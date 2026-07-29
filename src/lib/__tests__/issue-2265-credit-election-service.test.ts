import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, CreditType } from "@prisma/client";

/**
 * #2265 (epic #2245, E1) — the stored credit election.
 *
 * A member who ticks "use my credit" and then saves the booking as a draft used
 * to have that election silently discarded. It is now remembered on the booking
 * and applied when the booking reaches PAYMENT_PENDING.
 *
 * These are the money tests for the consumption rules. They drive the REAL
 * credit ledger helpers (getMemberCreditBalance, deriveBookingAppliedCreditCents,
 * applyCreditToBooking) against an in-memory MemberCredit table, so the ledger
 * arithmetic under test is the same arithmetic booking-create uses — not a
 * mock's idea of it.
 */

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));

import {
  consumeStoredCreditElection,
  settleFullyCreditCoveredBooking,
} from "@/lib/booking-credit-election";
import { queueSupersededPrimaryIntentCancellations } from "@/lib/booking-payment-cleanup";

type LedgerRow = {
  memberId: string;
  amountCents: number;
  type: CreditType;
  appliedToBookingId?: string | null;
};

const MEMBER_ID = "member-2265";
const BOOKING_ID = "booking-2265";

/**
 * A transaction double backed by an in-memory MemberCredit table plus one
 * booking row. `aggregate` discriminates on the same `where` shapes the real
 * helpers issue, so balance and applied-credit reads behave like Postgres.
 */
function makeTx({
  ledger = [],
  booking,
}: {
  ledger?: LedgerRow[];
  booking: {
    memberId?: string;
    status?: BookingStatus;
    finalPriceCents: number;
    creditElectionCents: number | null;
  };
}) {
  const rows: LedgerRow[] = [...ledger];
  const bookingRow = {
    memberId: MEMBER_ID,
    status: BookingStatus.PAYMENT_PENDING,
    ...booking,
  };
  const bookingUpdates: Array<Record<string, unknown>> = [];
  const paymentUpserts: Array<Record<string, unknown>> = [];

  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    booking: {
      findUnique: vi.fn(async () => ({ ...bookingRow })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        bookingUpdates.push(data);
        Object.assign(bookingRow, data);
        return { ...bookingRow };
      }),
    },
    payment: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        paymentUpserts.push(args);
        return { id: "payment-2265" };
      }),
    },
    memberCredit: {
      aggregate: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          const matched = rows.filter((row) => {
            if (where.memberId != null && row.memberId !== where.memberId) {
              return false;
            }
            if (
              where.appliedToBookingId != null &&
              row.appliedToBookingId !== where.appliedToBookingId
            ) {
              return false;
            }
            if (where.type != null && row.type !== where.type) return false;
            return true;
          });
          return {
            _sum: {
              amountCents: matched.reduce((sum, row) => sum + row.amountCents, 0),
            },
          };
        },
      ),
      create: vi.fn(async ({ data }: { data: LedgerRow }) => {
        rows.push(data);
        return data;
      }),
    },
  };

  return { tx, rows, bookingRow, bookingUpdates, paymentUpserts };
}

function creditLot(amountCents: number): LedgerRow {
  return {
    memberId: MEMBER_ID,
    amountCents,
    type: CreditType.CANCELLATION_REFUND,
    appliedToBookingId: null,
  };
}

function run(fixture: ReturnType<typeof makeTx>) {
  return consumeStoredCreditElection(
    fixture.tx as never,
    { bookingId: BOOKING_ID },
  );
}

/** Net credit consumed by the booking, straight off the fake ledger. */
function appliedTotal(rows: LedgerRow[]) {
  return -rows
    .filter(
      (row) =>
        row.type === CreditType.BOOKING_APPLIED &&
        row.appliedToBookingId === BOOKING_ID,
    )
    .reduce((sum, row) => sum + row.amountCents, 0) || 0;
}

/** What the member has left to spend. */
function balance(rows: LedgerRow[]) {
  return rows.reduce((sum, row) => sum + row.amountCents, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#2265 consumeStoredCreditElection", () => {
  it("does nothing at all when the booking carries no election", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: null },
    });

    await expect(run(fixture)).resolves.toBeNull();
    expect(fixture.tx.booking.update).not.toHaveBeenCalled();
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
    expect(balance(fixture.rows)).toBe(20_000);
  });

  it("refuses to consume credit while the booking is still a DRAFT", async () => {
    // The whole point of the stored election: a draft may be abandoned or
    // expire, so the member's balance must stay free until the booking is real.
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: {
        status: BookingStatus.DRAFT,
        finalPriceCents: 10_000,
        creditElectionCents: 5_000,
      },
    });

    await expect(run(fixture)).resolves.toBeNull();
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
    expect(balance(fixture.rows)).toBe(20_000);
    // And the election is NOT cleared — it is still owed to the member.
    expect(fixture.bookingRow.creditElectionCents).toBe(5_000);
  });

  it("refuses to consume credit while the booking is AWAITING_REVIEW", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: {
        status: BookingStatus.AWAITING_REVIEW,
        finalPriceCents: 10_000,
        creditElectionCents: 5_000,
      },
    });

    await expect(run(fixture)).resolves.toBeNull();
    expect(balance(fixture.rows)).toBe(20_000);
    expect(fixture.bookingRow.creditElectionCents).toBe(5_000);
  });

  it("applies the elected amount in full when the balance and price still allow it", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      requestedCents: 8_650,
      appliedCents: 8_650,
      shortfallCents: 0,
      shortfallReason: "none",
      fullyCovered: false,
    });
    expect(appliedTotal(fixture.rows)).toBe(8_650);
    expect(balance(fixture.rows)).toBe(11_350);
  });

  it("clears the election in the same transaction, so a re-drive cannot apply it twice", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 5_000 },
    });

    await run(fixture);
    expect(fixture.bookingUpdates[0]).toEqual({ creditElectionCents: null });
    expect(fixture.bookingRow.creditElectionCents).toBeNull();

    // Second attempt on the same booking: nothing left to consume.
    const second = await run(fixture);
    expect(second).toBeNull();
    expect(appliedTotal(fixture.rows)).toBe(5_000);
  });

  it("clamps to the balance when the member spent their credit elsewhere, and says so", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000), { ...creditLot(-17_000), type: CreditType.BOOKING_APPLIED, appliedToBookingId: "other-booking" }],
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      requestedCents: 8_650,
      appliedCents: 3_000,
      shortfallCents: 5_650,
      shortfallReason: "balance",
      availableBalanceCents: 3_000,
      fullyCovered: false,
    });
    expect(appliedTotal(fixture.rows)).toBe(3_000);
    // Never overdrawn.
    expect(balance(fixture.rows)).toBe(0);
  });

  it("clamps to the price when the draft was edited down below the election", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 4_000, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      requestedCents: 8_650,
      appliedCents: 4_000,
      shortfallCents: 4_650,
      shortfallReason: "price",
      fullyCovered: true,
    });
    expect(appliedTotal(fixture.rows)).toBe(4_000);
    expect(balance(fixture.rows)).toBe(16_000);
  });

  it("reports both limits when the balance AND the price moved under the election", async () => {
    const fixture = makeTx({
      ledger: [creditLot(3_000)],
      booking: { finalPriceCents: 2_500, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      appliedCents: 2_500,
      shortfallCents: 6_150,
      shortfallReason: "balance_and_price",
      fullyCovered: true,
    });
  });

  it("applies nothing, without throwing, when the balance is gone entirely", async () => {
    // calculateBookingCreditApplication throws on an over-request; the
    // confirmation path must never leave a member unable to pay their own
    // booking, so the election is clamped to zero and reported instead.
    const fixture = makeTx({
      ledger: [],
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      requestedCents: 8_650,
      appliedCents: 0,
      shortfallCents: 8_650,
      shortfallReason: "balance",
      fullyCovered: false,
    });
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
  });

  it("honours an explicit election of zero without touching the ledger", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 0 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      requestedCents: 0,
      appliedCents: 0,
      shortfallCents: 0,
      shortfallReason: "none",
    });
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
    expect(fixture.bookingRow.creditElectionCents).toBeNull();
  });

  it("never re-covers a slice of the price another path already paid with credit", async () => {
    const fixture = makeTx({
      ledger: [
        creditLot(20_000),
        {
          memberId: MEMBER_ID,
          amountCents: -6_000,
          type: CreditType.BOOKING_APPLIED,
          appliedToBookingId: BOOKING_ID,
        },
      ],
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    // Only the outstanding 4,000 is claimable.
    expect(outcome).toMatchObject({
      appliedCents: 4_000,
      shortfallReason: "price",
      fullyCovered: true,
    });
    expect(appliedTotal(fixture.rows)).toBe(10_000);
  });

  it("flags a booking the election covers in full", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 10_000 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      appliedCents: 10_000,
      shortfallCents: 0,
      fullyCovered: true,
    });
  });
});

describe("#2265 settleFullyCreditCoveredBooking", () => {
  it("marks the booking PAID with a $0 payment that mirrors the applied credit", async () => {
    const fixture = makeTx({
      booking: { finalPriceCents: 10_000, creditElectionCents: null },
    });

    await settleFullyCreditCoveredBooking(fixture.tx as never, {
      bookingId: BOOKING_ID,
      appliedCreditCents: 10_000,
    });

    // amountCents + creditAppliedCents = finalPriceCents.
    const upsert = fixture.paymentUpserts[0] as {
      create: { amountCents: number; creditAppliedCents: number; status: string };
      update: { amountCents: number; creditAppliedCents: number };
    };
    expect(upsert.create.amountCents).toBe(0);
    expect(upsert.create.creditAppliedCents).toBe(10_000);
    expect(upsert.create.status).toBe("SUCCEEDED");
    expect(upsert.update.amountCents).toBe(0);
    expect(upsert.update.creditAppliedCents).toBe(10_000);

    expect(fixture.bookingRow.status).toBe(BookingStatus.PAID);
  });

  it("sweeps every stale positive card intent, because nothing is owed", async () => {
    const fixture = makeTx({
      booking: { finalPriceCents: 10_000, creditElectionCents: null },
    });

    await settleFullyCreditCoveredBooking(fixture.tx as never, {
      bookingId: BOOKING_ID,
      appliedCreditCents: 10_000,
    });

    expect(queueSupersededPrimaryIntentCancellations).toHaveBeenCalledWith(
      fixture.tx,
      expect.objectContaining({
        bookingId: BOOKING_ID,
        paymentId: "payment-2265",
        newFinalPriceCents: 0,
      }),
    );
  });
});
