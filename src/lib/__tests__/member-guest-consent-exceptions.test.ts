// "+ Add Member Guest" (epic #2305) MG2 (#2307) — the admin exception list
// (owner decisions D-15 and MG2-M-3 as ticked): the two chip counts, and the
// Why-stuck / What-fixes-it columns composed from D-15's four reasons.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseDateOnly } from "@/lib/date-only";
import {
  classifyLiveConsentExceptionReason,
  describeConsentExceptionColumns,
  listMemberGuestConsentExceptions,
  loadMemberGuestConsentQueueCounts,
} from "@/lib/member-guest-consent-exceptions";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const CHECK_IN = parseDateOnly("2026-08-08");
const CHECK_OUT = parseDateOnly("2026-08-10");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("describeConsentExceptionColumns", () => {
  it("uses the mockup's table copy verbatim for the two drawn reasons", () => {
    expect(
      describeConsentExceptionColumns({ reason: "LAST_GUEST", guestFirstName: "Tui" }),
    ).toEqual({
      why: "Tui is the only guest on this booking, so taking them off would leave it empty.",
      fix: "Cancel the booking, or add another guest first.",
    });
    expect(
      describeConsentExceptionColumns({ reason: "QUOTE_PRICED", guestFirstName: "Mere" }),
    ).toEqual({
      why: "This booking was priced by hand, so the system will not reprice it.",
      fix: "Re-quote the request without Mere.",
    });
  });

  it("names a real remedy — never a dead-end 'ask the club' — for every reason", () => {
    for (const reason of [
      "LAST_GUEST",
      "QUOTE_PRICED",
      "BOOKING_STATUS",
      "STAY_NOT_FUTURE",
      "OTHER",
    ] as const) {
      const { why, fix } = describeConsentExceptionColumns({
        reason,
        guestFirstName: "Tui",
      });
      expect(why.length).toBeGreaterThan(0);
      expect(fix.length).toBeGreaterThan(0);
      expect(fix.toLowerCase()).not.toContain("ask the club");
    }
  });
});

describe("classifyLiveConsentExceptionReason", () => {
  const base = {
    bookingStatus: "PAID",
    bookingCheckIn: CHECK_IN,
    bookingGuestCount: 3,
    isQuotePriced: false,
    today: parseDateOnly("2026-08-01"),
  };

  it("maps the four predictable blockers and reports everything else as OTHER", () => {
    expect(classifyLiveConsentExceptionReason({ ...base, bookingGuestCount: 1 })).toBe(
      "LAST_GUEST",
    );
    expect(classifyLiveConsentExceptionReason({ ...base, isQuotePriced: true })).toBe(
      "QUOTE_PRICED",
    );
    expect(
      classifyLiveConsentExceptionReason({ ...base, bookingStatus: "COMPLETED" }),
    ).toBe("BOOKING_STATUS");
    expect(
      classifyLiveConsentExceptionReason({ ...base, bookingCheckIn: parseDateOnly("2026-07-20") }),
    ).toBe("STAY_NOT_FUTURE");
    // Nothing predictable explains it: the settled-payment/repricing case.
    expect(classifyLiveConsentExceptionReason(base)).toBe("OTHER");
  });
});

describe("loadMemberGuestConsentQueueCounts", () => {
  it("counts bookings for waiting and guest rows for attention — each chip's number is what clicking it reveals", async () => {
    const bookingCount = vi.fn(async () => 4);
    const guestCount = vi.fn(async () => 2);
    const db = {
      booking: { count: bookingCount },
      bookingGuest: { count: guestCount },
    } as never;

    const counts = await loadMemberGuestConsentQueueCounts(db);
    expect(counts).toEqual({ waitingBookings: 4, attentionGuests: 2 });

    // The waiting count matches the filtered LIST's own baseline (DRAFT
    // excluded, deleted hidden) plus the pending-consent narrowing.
    expect(bookingCount).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: { not: "DRAFT" },
        guests: { some: { consentStatus: "PENDING" } },
      },
    });
    // The attention count is stuck rows on live bookings: a cancelled booking
    // released everything, so its stuck rows have nothing left to fix.
    expect(guestCount).toHaveBeenCalledWith({
      where: {
        consentStatus: { in: ["DECLINED", "EXPIRED"] },
        booking: {
          deletedAt: null,
          status: { notIn: ["DRAFT", "CANCELLED"] },
        },
      },
    });
  });
});

describe("listMemberGuestConsentExceptions", () => {
  function row(overrides: Record<string, unknown> = {}) {
    const { booking: bookingOverrides, ...rest } = overrides;
    return {
      id: "bg-1",
      firstName: "Tui",
      lastName: "Aporo",
      consentStatus: "DECLINED",
      consentRespondedAt: parseDateOnly("2026-08-03"),
      consentExpiresAt: parseDateOnly("2026-08-05"),
      ...rest,
      booking: {
        id: "bk-1",
        status: "PAID",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        lodge: { name: "Silverpeak" },
        member: { firstName: "Dave", lastName: "Ngata" },
        guests: [{ id: "bg-1" }],
        ...(bookingOverrides as object | undefined),
      },
    };
  }

  function makeDb(rows: unknown[], quotePriced = false) {
    return {
      bookingGuest: { findMany: vi.fn(async () => rows) },
      bookingRequest: {
        findFirst: vi.fn(async () => (quotePriced ? { id: "br-1" } : null)),
      },
    } as never;
  }

  it("re-derives the stuck reason from the live booking and composes both columns", async () => {
    const [exception] = await listMemberGuestConsentExceptions(makeDb([row()]));
    expect(exception).toMatchObject({
      bookingId: "bk-1",
      lodgeName: "Silverpeak",
      bookerName: "Dave Ngata",
      guestFirstName: "Tui",
      status: "DECLINED",
      statusAt: parseDateOnly("2026-08-03"),
      reason: "LAST_GUEST",
      why: "Tui is the only guest on this booking, so taking them off would leave it empty.",
      fix: "Cancel the booking, or add another guest first.",
    });
  });

  it("dates a lapsed row by its expiry, not a response nobody made", async () => {
    const [exception] = await listMemberGuestConsentExceptions(
      makeDb([
        row({
          consentStatus: "EXPIRED",
          consentRespondedAt: null,
        }),
      ]),
    );
    expect(exception.status).toBe("EXPIRED");
    expect(exception.statusAt).toEqual(parseDateOnly("2026-08-05"));
  });

  it("classifies a quote-priced booking through the shared lookup", async () => {
    const twoGuests = row({
      booking: { guests: [{ id: "bg-1" }, { id: "bg-2" }] },
    });
    const [exception] = await listMemberGuestConsentExceptions(
      makeDb([twoGuests], true),
    );
    expect(exception.reason).toBe("QUOTE_PRICED");
    expect(exception.fix).toBe("Re-quote the request without Tui.");
  });
});
