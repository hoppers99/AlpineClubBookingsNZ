import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2700 surface 2, part 2 — when the race still fires, the money is recorded
 * AND a human is told.
 *
 * THE DECISION, and it rejected both of the options the issue body offered.
 * "Record it anyway" leaves a ledger row against a ghost booking with nobody
 * told. "Refuse and let Stripe reconciliation surface it" leaves the club
 * holding a member's money with no record of it at all. The owner's 10 Aug 2026
 * answer does both halves of the right thing: record the payment, so the money
 * is accounted for, and raise an OPEN `ManualRefundTask`, so a person decides
 * whether to refund rather than the system deciding silently either way.
 *
 * NO AUTOMATIC REFUND FROM THIS PATH — a money movement triggered by a race,
 * and if the DELETION was itself the mistake, refunding automatically compounds
 * it instead of surfacing it. "raises the task without moving any money"
 * asserts that directly.
 *
 * WHY A `DISMISSED` CLOSE EXISTS AND IS NOT A CONTRADICTION. The browser
 * confirm is not the only writer that hears about the capture: Stripe also
 * sends `payment_intent.succeeded`, and since #1350 the webhook routes an
 * additional payment on a CANCELLED booking through
 * `handleCancelledBookingAdditionalPaymentSucceeded`, which refunds it in full.
 * A soft-deleted booking is ALWAYS CANCELLED (`INV-ADDPAY-030`), so that
 * pre-existing path covers deleted bookings too. If it runs after this task was
 * raised, the task's question is already answered, and leaving it OPEN would
 * invite an operator to COMPLETE it — which writes a second refund allocation
 * through `resolveManualRefundTask` and double-counts one refund in the ledger.
 * Closing a task whose subject is resolved moves no money; the refund it
 * records was #1350's behaviour and is not introduced here.
 *
 * AND THE CLOSE ONLY COVERS ONE ORDERING, WHICH IS WHY THE RAISE IS ALSO
 * FENCED. The close catches a webhook that arrives after the task exists. The
 * reverse interleaving is just as producible: the confirm route reads the
 * transaction's status once, then spends a Stripe round trip in
 * `getPaymentIntent`, and a webhook that completes entirely inside that window
 * refunds the capture and returns 200 before the route looks again. The route's
 * already-captured early return no longer fires, `markPaymentIntentTransaction-
 * Succeeded` writes SUCCEEDED back over the REFUNDED status, and a raise there
 * queues an operator to hand back money Stripe already returned — a task that
 * cannot even be completed, because `applyLocalRefundAllocation` throws "Refund
 * amount exceeds captured payments". So the raise re-reads the transaction under
 * the same lock and skips. `refundedAmountCents` is the field that decides it,
 * not `status`, precisely because the status is the thing that got overwritten.
 *
 * MUTATION PROOF. Drop the `findFirst` pre-check in
 * `raiseDeletedBookingModificationRefundTask` and "raises exactly one task when
 * the same capture is confirmed twice" fails. Drop `pg_advisory_xact_lock(1)`
 * and "takes the global settlement lock before the find-then-create" fails.
 * Drop the refund fence and "raises nothing for a capture Stripe has already
 * refunded" fails; fence it on `status` alone instead of `refundedAmountCents`
 * and "still skips when the status was overwritten back to SUCCEEDED" fails;
 * move the fence outside the lock and "reads the refund state under the same
 * lock as the raise" fails. Widen the close's `where` to drop `reason` and
 * "never closes an unrelated ManualRefundTask on the same booking" fails; drop
 * `status: OPEN` and "claims nothing on a replay" fails. Change `DISMISSED` to
 * `COMPLETED` and "closes it as DISMISSED, which writes no refund allocation"
 * fails.
 */

const mocks = vi.hoisted(() => ({
  manualRefundTaskFindFirst: vi.fn(),
  manualRefundTaskCreate: vi.fn(),
  manualRefundTaskUpdateMany: vi.fn(),
  paymentTransactionFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: {
      updateMany: (...args: unknown[]) =>
        mocks.manualRefundTaskUpdateMany(...args),
    },
    $transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
}));

import {
  closeDeletedBookingModificationRefundTaskAfterAutomaticRefund,
  deletedBookingModificationRefundReason,
  raiseDeletedBookingModificationRefundTask,
} from "@/lib/deleted-booking-modification-payment";

const BOOKING_ID = "booking-1";
const PAYMENT_ID = "payment-1";
const INTENT_ID = "pi_modification";
const AMOUNT_CENTS = 2500;

const tx = {
  $executeRaw: mocks.executeRaw,
  manualRefundTask: {
    findFirst: (...args: unknown[]) => mocks.manualRefundTaskFindFirst(...args),
    create: (...args: unknown[]) => mocks.manualRefundTaskCreate(...args),
  },
  paymentTransaction: {
    findUnique: (...args: unknown[]) =>
      mocks.paymentTransactionFindUnique(...args),
  },
};

function raise() {
  return raiseDeletedBookingModificationRefundTask({
    bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID,
    paymentIntentId: INTENT_ID,
    amountCents: AMOUNT_CENTS,
  });
}

function close() {
  return closeDeletedBookingModificationRefundTaskAfterAutomaticRefund({
    bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID,
    paymentIntentId: INTENT_ID,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeRaw.mockResolvedValue(1);
  mocks.transaction.mockImplementation(
    async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  );
  mocks.manualRefundTaskFindFirst.mockResolvedValue(null);
  mocks.manualRefundTaskCreate.mockResolvedValue({ id: "task-1" });
  mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });
  // The ordinary state at the moment of the raise: captured, nothing refunded.
  mocks.paymentTransactionFindUnique.mockResolvedValue({
    status: "SUCCEEDED",
    refundedAmountCents: 0,
    amountCents: AMOUNT_CENTS,
  });
});

describe("raiseDeletedBookingModificationRefundTask (#2700)", () => {
  it("raises an OPEN task carrying the booking, payment and captured amount", async () => {
    const result = await raise();

    expect(result).toEqual({ taskId: "task-1", created: true, alreadyRefunded: false });
    expect(mocks.manualRefundTaskCreate).toHaveBeenCalledTimes(1);
    expect(mocks.manualRefundTaskCreate.mock.calls[0][0]).toMatchObject({
      data: {
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        amountCents: AMOUNT_CENTS,
        status: "OPEN",
      },
    });
  });

  it("raises the task without moving any money", async () => {
    // The whole point of the decision. This module holds no refund call at all,
    // and the assertion is on the object it is handed: a task creation and
    // nothing else.
    await raise();

    const created = mocks.manualRefundTaskCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(Object.keys(created.data).sort()).toEqual([
      "amountCents",
      "bookingId",
      "paymentId",
      "reason",
      "status",
    ]);
    // Nothing here completes the task or records that money went back.
    expect(created.data.completedAt).toBeUndefined();
    expect(created.data.completedByMemberId).toBeUndefined();
  });

  it("names the situation in a reason a person can act on, and fits the column", async () => {
    await raise();

    const reason = (
      mocks.manualRefundTaskCreate.mock.calls[0][0] as {
        data: { reason: string };
      }
    ).data.reason;
    expect(reason).toContain(INTENT_ID);
    expect(reason).toContain("#2700");
    // `ManualRefundTask.reason` is VarChar(500).
    expect(reason.length).toBeLessThanOrEqual(500);
  });

  it("raises exactly one task when the same capture is confirmed twice", async () => {
    // Two operators, two refunds is the failure this prevents. The match is on
    // bookingId + paymentId + this intent's reason, across EVERY status, so a
    // retry after somebody already completed or dismissed the task raises
    // nothing either.
    mocks.manualRefundTaskFindFirst.mockResolvedValue({ id: "task-existing" });

    const result = await raise();

    expect(result).toEqual({
      taskId: "task-existing",
      created: false,
      alreadyRefunded: false,
    });
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
    expect(mocks.manualRefundTaskFindFirst).toHaveBeenCalledWith({
      where: {
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        reason: deletedBookingModificationRefundReason(INTENT_ID),
      },
      select: { id: true },
    });
  });

  it("takes the global settlement lock before the find-then-create", async () => {
    // find-then-create is not atomic on its own. `pg_advisory_xact_lock(1)` is
    // the canonical global booking/settlement key and is the one
    // `booking-cancel.ts` already holds when IT creates a ManualRefundTask, so
    // this write joins that cohort rather than minting a new keyspace. It takes
    // that key and nothing else, for two statements, with every Stripe call
    // made by the caller outside this transaction — so it adds no lock ordering.
    await raise();

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw.mock.calls[0][0].join("?")).toContain(
      "pg_advisory_xact_lock(1)",
    );
    // The lock is taken FIRST, before anything is read.
    expect(
      mocks.executeRaw.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.manualRefundTaskFindFirst.mock.invocationCallOrder[0]);
  });

  it("raises nothing for a capture Stripe has already refunded", async () => {
    // THE REVERSE INTERLEAVING. The webhook refunded the capture inside the
    // confirm route's own Stripe round trip, so the close ran before there was
    // a task to close and Stripe will not redeliver. Without this fence the
    // operator gets an OPEN task for money already returned — and completing it
    // throws out of `applyLocalRefundAllocation`, so it looks unresolvable.
    mocks.paymentTransactionFindUnique.mockResolvedValue({
      status: "REFUNDED",
      refundedAmountCents: AMOUNT_CENTS,
      amountCents: AMOUNT_CENTS,
    });

    const result = await raise();

    expect(result).toEqual({
      taskId: null,
      created: false,
      alreadyRefunded: true,
    });
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
  });

  it("still skips when the status was overwritten back to SUCCEEDED", async () => {
    // The producible shape, and the reason `refundedAmountCents` decides this
    // rather than `status`: `markPaymentIntentTransactionSucceeded` writes
    // SUCCEEDED over the REFUNDED status but never touches the refunded total,
    // so by the time the raise looks, the status is the field that is lying.
    mocks.paymentTransactionFindUnique.mockResolvedValue({
      status: "SUCCEEDED",
      refundedAmountCents: AMOUNT_CENTS,
      amountCents: AMOUNT_CENTS,
    });

    const result = await raise();

    expect(result.alreadyRefunded).toBe(true);
    expect(mocks.manualRefundTaskCreate).not.toHaveBeenCalled();
  });

  it("still raises for a PARTIAL refund that does not cover the capture", async () => {
    // The complement. A partial refund leaves money the club is still holding
    // against a deleted booking, which is exactly what the task is for — and
    // `PARTIALLY_REFUNDED` alone is not enough to conclude "settled".
    mocks.paymentTransactionFindUnique.mockResolvedValue({
      status: "SUCCEEDED",
      refundedAmountCents: AMOUNT_CENTS - 1,
      amountCents: AMOUNT_CENTS,
    });

    const result = await raise();

    expect(result.alreadyRefunded).toBe(false);
    expect(mocks.manualRefundTaskCreate).toHaveBeenCalledTimes(1);
  });

  it("reads the refund state under the same lock as the raise", async () => {
    // Outside the lock it is a stale read: a refund committing between the
    // check and the create is exactly the interleaving being fenced.
    await raise();

    expect(mocks.paymentTransactionFindUnique).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: INTENT_ID },
      select: { status: true, refundedAmountCents: true, amountCents: true },
    });
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.paymentTransactionFindUnique.mock.invocationCallOrder[0],
    );
    expect(
      mocks.paymentTransactionFindUnique.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.manualRefundTaskCreate.mock.invocationCallOrder[0]);
  });

  it("raises normally when there is no transaction row to read", async () => {
    // A missing row is not evidence of a refund. Refusing to raise there would
    // trade one silent hole for another.
    mocks.paymentTransactionFindUnique.mockResolvedValue(null);

    const result = await raise();

    expect(result.created).toBe(true);
    expect(mocks.manualRefundTaskCreate).toHaveBeenCalledTimes(1);
  });

  it("does not confuse another booking's task for this one", async () => {
    // Two different intents on the same booking and payment produce two
    // different reasons, so neither suppresses the other.
    expect(deletedBookingModificationRefundReason("pi_a")).not.toBe(
      deletedBookingModificationRefundReason("pi_b"),
    );
  });
});

describe("closeDeletedBookingModificationRefundTaskAfterAutomaticRefund (#2700)", () => {
  it("closes it as DISMISSED, which writes no refund allocation", async () => {
    // In `manual-booking-payment.ts` COMPLETED means "an operator handed the
    // money back by hand" and is what writes the local refund allocation.
    // Stripe refunded this one and `refundPaymentTransactions` already wrote the
    // allocation, so COMPLETED here would be both untrue and a second allocation
    // for one refund.
    const closed = await close();

    expect(closed).toBe(1);
    const call = mocks.manualRefundTaskUpdateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.status).toBe("DISMISSED");
    expect(call.data.status).not.toBe("COMPLETED");
    // No member did it, so no member is named as having done it.
    expect(call.data.completedByMemberId).toBeUndefined();
    expect(call.data.note).toContain(INTENT_ID);
  });

  it("claims nothing on a replay, because it is fenced on OPEN", async () => {
    // A webhook retry, or an operator who got there first, must claim nothing.
    const call = await close().then(
      () => mocks.manualRefundTaskUpdateMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      },
    );

    expect(call.where.status).toBe("OPEN");
  });

  it("never closes an unrelated ManualRefundTask on the same booking", async () => {
    // `booking-cancel.ts` raises a cash/manual settlement task on the same
    // booking and payment. Only the reason distinguishes them, so the reason is
    // part of the match.
    await close();

    expect(mocks.manualRefundTaskUpdateMany.mock.calls[0][0]).toMatchObject({
      where: {
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        reason: deletedBookingModificationRefundReason(INTENT_ID),
        status: "OPEN",
      },
    });
  });

  it("needs no lock of its own", async () => {
    // A status-fenced updateMany is its own claim, so this takes no advisory
    // lock and cannot participate in a lock ordering.
    await close();

    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("reports zero when there was no task to close", async () => {
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await expect(close()).resolves.toBe(0);
  });
});
