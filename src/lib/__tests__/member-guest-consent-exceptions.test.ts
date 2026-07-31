// "+ Add Member Guest" (epic #2305) MG2 (#2307) — the admin exception list
// (owner decisions D-15 and MG2-M-3 as ticked): the two chip counts, and the
// Why-stuck / What-fixes-it columns composed from D-15's four reasons.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const TODAY = parseDateOnly("2026-08-01");

beforeEach(() => {
  vi.clearAllMocks();
  // The fixtures pin a check-in of 8 August 2026 and STAY_NOT_FUTURE outranks
  // LAST_GUEST and QUOTE_PRICED, so a derivation that quietly read the wall
  // clock would reclassify every row below — on 8 August 2026 and no other day.
  // The clock is pinned well past every fixture date so that a wall-clock read
  // fails here immediately rather than on one future morning in CI.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-03-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("describeConsentExceptionColumns", () => {
  // Every sentence pinned word for word, all six reasons. These two columns are
  // the only thing telling an operator what is wrong and what to do about it,
  // and two of them swapped would read perfectly while sending the operator to
  // re-quote a booking whose real problem is its status.
  const COLUMNS = {
    LAST_GUEST: {
      why: "Tui is the only guest on this booking, so taking them off would leave it empty.",
      fix: "Cancel the booking, or add another guest first.",
    },
    QUOTE_PRICED: {
      why: "This booking was priced by hand, so the system will not reprice it.",
      fix: "Re-quote the request without Tui.",
    },
    BOOKING_STATUS: {
      why: "This booking's status does not allow guest changes.",
      fix: "Move it to a status that does, or cancel it.",
    },
    STAY_NOT_FUTURE: {
      why: "This stay has already started, so the place cannot be released.",
      fix: "Check who actually arrived and adjust the booking directly.",
    },
    OTHER: {
      why: "The booking could not be repriced automatically.",
      fix: "Open the booking and take Tui off through the edit flow.",
    },
    NO_LONGER_BLOCKED: {
      why: "Nothing is blocking this now — the booking has changed since the removal was refused.",
      fix: "Open the booking and take Tui off; it should go through this time.",
    },
  } as const;

  const ALL_REASONS = Object.keys(COLUMNS) as (keyof typeof COLUMNS)[];

  it.each(ALL_REASONS)("writes the %s columns word for word", (reason) => {
    expect(
      describeConsentExceptionColumns({ reason, guestFirstName: "Tui" }),
    ).toEqual(COLUMNS[reason]);
  });

  it("names the guest in the fix wherever the sentence needs one", () => {
    expect(
      describeConsentExceptionColumns({ reason: "QUOTE_PRICED", guestFirstName: "Mere" }).fix,
    ).toBe("Re-quote the request without Mere.");
  });

  it("gives each reason its own distinct pair of sentences", () => {
    const sentences = ALL_REASONS.flatMap((reason) => [
      COLUMNS[reason].why,
      COLUMNS[reason].fix,
    ]);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("names a real remedy — never a dead-end 'ask the club' — for every reason", () => {
    for (const reason of ALL_REASONS) {
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
    hasSettledPayment: true,
    today: TODAY,
  };

  it("maps the four predictable blockers", () => {
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
  });

  it("reports the settled-payment case as OTHER", () => {
    // Nothing predictable explains it and there IS money captured, so the
    // refund-vs-credit election really is the likely refusal.
    expect(classifyLiveConsentExceptionReason(base)).toBe("OTHER");
  });

  it("reports a row the booking has moved past as no longer blocked", () => {
    // The row was refused as LAST_GUEST; the booker has since added two more
    // guests. Nothing captured means there is no election to make, so there is
    // nothing left blocking the removal — and nothing re-attempts it, because
    // the nightly sweep only ever looks at PENDING rows.
    expect(
      classifyLiveConsentExceptionReason({ ...base, hasSettledPayment: false }),
    ).toBe("NO_LONGER_BLOCKED");
  });

  it("still reports a live blocker on an unpaid booking", () => {
    // "No captured payment" must not become a blanket "nothing is wrong".
    expect(
      classifyLiveConsentExceptionReason({
        ...base,
        hasSettledPayment: false,
        bookingGuestCount: 1,
      }),
    ).toBe("LAST_GUEST");
  });

  it("uses the caller's date, not the day the test runs", () => {
    // The pinned clock is 1 March 2027, long past every fixture check-in. If
    // this derivation read the wall clock the answer would be STAY_NOT_FUTURE.
    expect(classifyLiveConsentExceptionReason({ ...base, bookingGuestCount: 1 })).toBe(
      "LAST_GUEST",
    );
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

  it("takes the waiting count inside the operator's own filters, because the click stacks with them", async () => {
    const bookingCount = vi.fn(async () => 1);
    const guestCount = vi.fn(async () => 2);
    const db = {
      booking: { count: bookingCount },
      bookingGuest: { count: guestCount },
    } as never;

    // What the bookings list is already filtering by — say, one lodge.
    const waitingScope = { deletedAt: null, lodgeId: "lodge-1" };
    await loadMemberGuestConsentQueueCounts(db, { waitingScope });

    expect(bookingCount).toHaveBeenCalledWith({
      where: {
        AND: [waitingScope, { guests: { some: { consentStatus: "PENDING" } } }],
      },
    });
    // The attention chip swaps in an unfiltered table, so its count stays
    // global — the scope must not narrow it.
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
        // A captured payment by default, so a row with no live blocker
        // classifies as the genuine settled-payment case unless a test says
        // otherwise.
        payment: { status: "SUCCEEDED", amountCents: 24_000, refundedAmountCents: 0 },
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
    const [exception] = await listMemberGuestConsentExceptions(makeDb([row()]), {
      today: TODAY,
    });
    expect(exception).toMatchObject({
      bookingId: "bk-1",
      guestId: "bg-1",
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

  it("classifies every row against ONE date, the caller's, not the wall clock", async () => {
    // The pinned clock is 1 March 2027; the fixture's check-in is 8 August
    // 2026. Read from the wall clock this row would come back STAY_NOT_FUTURE
    // ("check who actually arrived") instead of LAST_GUEST — and it would have
    // done so only from 8 August 2026 onwards, which is precisely the kind of
    // drift a fixed date in the test cannot catch on its own.
    const [exception] = await listMemberGuestConsentExceptions(makeDb([row()]), {
      today: TODAY,
    });
    expect(exception.reason).toBe("LAST_GUEST");
  });

  it("dates a lapsed row by its expiry, not a response nobody made", async () => {
    const [exception] = await listMemberGuestConsentExceptions(
      makeDb([
        row({
          consentStatus: "EXPIRED",
          consentRespondedAt: null,
        }),
      ]),
      { today: TODAY },
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
      { today: TODAY },
    );
    expect(exception.reason).toBe("QUOTE_PRICED");
    expect(exception.fix).toBe("Re-quote the request without Tui.");
  });

  it("tells the operator the truth about a row the booking has moved past", async () => {
    // Tui said no when she was the only guest, so the removal was refused.
    // Dave has since added two more guests and nothing was ever captured on
    // this booking. There is no repricing problem to report — the row is
    // simply waiting for somebody to try again.
    const unstuck = row({
      booking: {
        guests: [{ id: "bg-1" }, { id: "bg-2" }, { id: "bg-3" }],
        payment: null,
      },
    });
    const [exception] = await listMemberGuestConsentExceptions(makeDb([unstuck]), {
      today: TODAY,
    });
    expect(exception.reason).toBe("NO_LONGER_BLOCKED");
    expect(exception.why).toBe(
      "Nothing is blocking this now — the booking has changed since the removal was refused.",
    );
    expect(exception.fix).toBe(
      "Open the booking and take Tui off; it should go through this time.",
    );
    // The old copy invented a repricing failure that never happened.
    expect(exception.why).not.toContain("repriced");
  });

  it("still reports the settled-payment case honestly when money was captured", async () => {
    const settled = row({
      booking: { guests: [{ id: "bg-1" }, { id: "bg-2" }, { id: "bg-3" }] },
    });
    const [exception] = await listMemberGuestConsentExceptions(makeDb([settled]), {
      today: TODAY,
    });
    expect(exception.reason).toBe("OTHER");
    expect(exception.why).toBe("The booking could not be repriced automatically.");
  });
});
