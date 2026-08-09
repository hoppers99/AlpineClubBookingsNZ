/**
 * #2739 — booking-request bookings and the canonical night set.
 *
 * `BookingGuestNight` is what the whole bed-allocation surface reads. A booking
 * created by approving a booking request used to get guests with none of those
 * rows, so its guests were invisible to it: not listed on the board, not placed
 * by the planner, not counted as awaiting a bed — while being real people on a
 * confirmed booking who turn up at the lodge (INV-CAP-032).
 *
 * The per-pipeline write points are pinned in each pipeline's own suite
 * (`booking-request.test.ts`, `school-booking-request.test.ts`,
 * `booking-request-quotes.test.ts`, `reassign-held-booking-guests.test.ts`).
 * This file pins the two properties those tests cannot see between them: that
 * the rows carry the right DATES, and that writing them moves no MONEY.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgeTier } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  // The real resolver stamps a rate-membership-type snapshot and returns the
  // guests otherwise untouched; nothing here turns on which type it picks.
  resolveGuestRateMembershipTypes: vi.fn(async (_tx: unknown, params: {
    guests: Array<Record<string, unknown>>;
  }) => params.guests.map((guest) => ({ ...guest, rateMembershipTypeId: "type-nonmember" }))),
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  assertNoBookingMemberNightConflicts: vi.fn().mockResolvedValue(undefined),
}));

import {
  buildApprovalGuestCreates,
  buildApprovalGuestNights,
  toPipelineGuestCreateData,
} from "@/lib/booking-request-shared";
import { countGuestsAwaitingBed } from "@/lib/admin-bed-allocation";
import { parseDateOnly } from "@/lib/date-only";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoices";

const CHECK_IN = parseDateOnly("2026-08-01");
const CHECK_OUT = parseDateOnly("2026-08-04"); // three nights

describe("buildApprovalGuestNights — the dates (#2739)", () => {
  it("expands the HALF-OPEN envelope, so the check-out morning is not a night", () => {
    const nights = buildApprovalGuestNights({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      priceCents: 9000,
    });

    // INV-DATE-003: a stay is [checkIn, checkOut). Night N runs to midday NZ on
    // date N+1, so the day a guest checks out is not one of theirs. A fourth row
    // here would claim a bed on the 4th while its real occupant is still in it —
    // a double booking written by the creation path itself.
    expect(nights.map((night) => night.stayDate)).toEqual([
      parseDateOnly("2026-08-01"),
      parseDateOnly("2026-08-02"),
      parseDateOnly("2026-08-03"),
    ]);
  });

  it("produces no rows for a zero-night envelope rather than one phantom night", () => {
    expect(
      buildApprovalGuestNights({
        checkIn: CHECK_IN,
        checkOut: CHECK_IN,
        priceCents: 9000,
      }),
    ).toEqual([]);
  });

  it("stores NZ date-only values at the encoding every other night row uses", () => {
    // INV-DATE-013: a @db.Date column holds an NZ calendar date encoded at UTC
    // midnight. A local-midnight or raw `new Date()` value shifts the boundary by
    // a day for the first ~13h of each NZ day.
    for (const night of buildApprovalGuestNights({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      priceCents: 9000,
    })) {
      expect(night.stayDate.toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
  });
});

describe("buildApprovalGuestNights — the money (#2739)", () => {
  it("splits to the exact cent, with the extra cents on the EARLIEST nights", () => {
    const nights = buildApprovalGuestNights({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      priceCents: 10001,
    });

    expect(nights.map((night) => night.priceCents)).toEqual([3334, 3334, 3333]);
    expect(nights.reduce((sum, night) => sum + night.priceCents, 0)).toBe(10001);
  });

  it.each([0, 1, 2, 9000, 10001, 33333, 100000])(
    "sums to the guest's stored price exactly for %i cents",
    (priceCents) => {
      const nights = buildApprovalGuestNights({
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        priceCents,
      });
      expect(nights.reduce((sum, night) => sum + night.priceCents, 0)).toBe(
        priceCents,
      );
    },
  );

  it("leaves the Xero invoice byte-identical to the one it raises with no rows at all", () => {
    // THE MONEY-SAFETY PROOF, and the reason this split rule was chosen over the
    // #1098 backfill's (whole remainder on the first night).
    //
    // `buildInvoiceLineItems` ALREADY synthesises a per-night vector for a guest
    // carrying no night rows and bills from it. Writing real rows only changes
    // which branch runs — so if the two vectors agree, a converted booking's
    // invoice is unchanged on a fresh raise AND an invoice-update diff of a
    // backfilled booking finds nothing to push. A different split totals the same
    // and still emits different lines, which on an already-raised invoice reads
    // as a change to send to Xero.
    const guest = {
      firstName: "Tara",
      lastName: "Tester",
      ageTier: AgeTier.ADULT,
      isMember: false,
      rateMembershipTypeId: null,
      priceCents: 10001,
    };

    const withoutRows = buildInvoiceLineItems([guest], CHECK_IN, CHECK_OUT, 3);
    const withRows = buildInvoiceLineItems(
      [
        {
          ...guest,
          nights: buildApprovalGuestNights({
            checkIn: CHECK_IN,
            checkOut: CHECK_OUT,
            priceCents: guest.priceCents,
          }),
        },
      ],
      CHECK_IN,
      CHECK_OUT,
      3,
    );

    expect(withRows).toEqual(withoutRows);
    // And the lines still reconcile to the guest's price, in dollars.
    const total = withRows.reduce(
      (sum, line) => sum + (line.quantity ?? 0) * (line.unitAmount ?? 0),
      0,
    );
    expect(Math.round(total * 100)).toBe(10001);
  });
});

describe("buildApprovalGuestCreates gives every guest a night set (#2739)", () => {
  const tx = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches nights to every guest, matching each one's own price", async () => {
    const guestCreates = await buildApprovalGuestCreates(tx, {
      guests: [
        { firstName: "Tara", lastName: "Tester", ageTier: AgeTier.ADULT },
        { firstName: "Sam", lastName: "Student", ageTier: AgeTier.CHILD },
      ],
      linkedMembers: new Map<number, string>(),
      guestPriceCents: [10001, 9000],
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      adminMemberId: "admin-1",
      heldBookingId: null,
    });

    expect(guestCreates.map((guest) => guest.nights.map((n) => n.priceCents))).toEqual([
      [3334, 3334, 3333],
      [3000, 3000, 3000],
    ]);
  });

  it("nests them the way Prisma wants at the shared write point", async () => {
    const [guestCreate] = await buildApprovalGuestCreates(tx, {
      guests: [{ firstName: "Tara", lastName: "Tester", ageTier: AgeTier.ADULT }],
      linkedMembers: new Map<number, string>(),
      guestPriceCents: [9000],
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      adminMemberId: "admin-1",
      heldBookingId: null,
    });

    const prismaData = toPipelineGuestCreateData(guestCreate);
    expect(prismaData.nights).toEqual({
      create: [
        { stayDate: parseDateOnly("2026-08-01"), priceCents: 3000 },
        { stayDate: parseDateOnly("2026-08-02"), priceCents: 3000 },
        { stayDate: parseDateOnly("2026-08-03"), priceCents: 3000 },
      ],
    });
    // The planning-only fields never reach Prisma.
    expect(prismaData).not.toHaveProperty("memberGuestConsent");
    expect(prismaData).not.toHaveProperty("crossFamilyMemberGuest");
  });
});

describe("the guests now reach the Bed Allocation officer card (#2739)", () => {
  /**
   * `countGuestsAwaitingBed` reads `BookingGuestNight` and nothing else since
   * #2628 — "a guest carrying no night rows has no placeable nights, so the board
   * never lists them and this card must not count them either". That is the
   * sentence that made this defect total: both the board and its counter went
   * blind at once. These two cases run the real counter over the rows the
   * pipeline now writes, and over the empty set it used to write.
   */
  async function countFor(nights: Array<{ stayDate: Date }>) {
    return countGuestsAwaitingBed({
      from: parseDateOnly("2026-08-01"),
      to: parseDateOnly("2026-08-08"),
      db: {
        booking: {
          findMany: vi.fn().mockResolvedValue([
            { guests: [{ id: "converted-guest", nights }] },
          ]),
        },
        bedAllocation: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
    });
  }

  it("counts a converted guest once the pipeline writes their nights", async () => {
    const nights = buildApprovalGuestNights({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      priceCents: 9000,
    });

    expect(await countFor(nights)).toBe(1);
  });

  it("counted nobody while the pipeline wrote none — the defect, pinned", async () => {
    expect(await countFor([])).toBe(0);
  });
});
