import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

/**
 * B5 (#2262) — manual mark-paid for booking payments (cash / off-Xero bank
 * transfer), and its reversal.
 *
 * The four guards from the issue, each mutation-verified: every test here fails
 * if its guard's code is reverted.
 *  1. the settlement goes through the ONE settlement body — same lock ordering
 *     (global -> lodge -> member-credit), same capacity check, same fenced PAID
 *     claim, same bed reconciliation, same durable event;
 *  2. it is REFUSED whenever any Xero invoice evidence exists, including a
 *     queued mint, and the fenced write re-asserts what it can;
 *  3. the settlement is visible to the duplicate-capture detector (covered by
 *     the widened predicate in issue-1992-duplicate-capture-refund.test.ts);
 *  4. no new PaymentSource member — the row settles as INTERNET_BANKING with
 *     provenance columns.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentUpsert: vi.fn(),
  paymentUpdateMany: vi.fn(),
  paymentRefundCount: vi.fn(),
  paymentTransactionFindFirst: vi.fn(),
  paymentTransactionFindMany: vi.fn(),
  paymentTransactionUpdateMany: vi.fn(),
  paymentTransactionCreate: vi.fn(),
  paymentRecoveryOperationFindMany: vi.fn(),
  paymentRecoveryOperationFindFirst: vi.fn(),
  paymentRecoveryOperationUpdateMany: vi.fn(),
  paymentRecoveryOperationDeleteMany: vi.fn(),
  manualRefundTaskFindFirst: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroSyncOperationFindFirst: vi.fn(),
  lodgeFindFirst: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  findPaymentTransactionByIntentId: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  enqueuePaymentIntentCancellationRecovery: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  recordBookingEvent: vi.fn(),
  createAuditLog: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (...args: unknown[]) => mocks.transaction(...args) },
}));

vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mocks.upsertPaymentIntentTransaction(...args),
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mocks.findPaymentTransactionByIntentId(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mocks.refundPaymentTransactions(...args),
  planStripeRefundAllocation: (...args: unknown[]) =>
    mocks.planStripeRefundAllocation(...args),
}));

vi.mock("@/lib/payment-recovery", () => ({
  enqueueCapacityClaimFailedRefundRecovery: vi.fn(),
  enqueueDuplicateCaptureRefundRecovery: vi.fn(),
  enqueuePaymentIntentCancellationRecovery: (...args: unknown[]) =>
    mocks.enqueuePaymentIntentCancellationRecovery(...args),
  findOtherDuplicateCaptureRefundOperation: vi.fn(),
  markCapacityClaimFailedRefundRecoverySucceeded: vi.fn(),
  markDuplicateCaptureRefundRecoverySucceeded: vi.fn(),
  recordCapacityClaimFailedRefundRecoveryInlineError: vi.fn(),
  recordDuplicateCaptureRefundRecoveryInlineError: vi.fn(),
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: (...args: unknown[]) =>
    mocks.acquireLodgeCapacityLock(...args),
  checkCapacityForGuestRanges: (...args: unknown[]) =>
    mocks.checkCapacityForGuestRanges(...args),
}));

vi.mock("@/lib/member-credit", () => ({
  deriveBookingAppliedCreditCents: (...args: unknown[]) =>
    mocks.deriveBookingAppliedCreditCents(...args),
  lockMemberCreditLedger: (...args: unknown[]) =>
    mocks.lockMemberCreditLedger(...args),
  restoreCreditFromBooking: (...args: unknown[]) =>
    mocks.restoreCreditFromBooking(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: vi.fn(),
  sendAdminDuplicateCaptureRefundAlert: vi.fn(),
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: (...args: unknown[]) =>
    mocks.reconcileBedAllocationsForBooking(...args),
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...args: unknown[]) => mocks.recordBookingEvent(...args),
  recordDuplicateCaptureRefundEvent: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => mocks.createAuditLog(...args),
}));

vi.mock("@/lib/stripe", () => ({
  cancelPaymentIntentIfCancellable: (...args: unknown[]) =>
    mocks.cancelPaymentIntentIfCancellable(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  ManualBookingPaymentError,
  markBookingPaymentManuallySettled,
  reverseManualBookingPayment,
} from "@/lib/payment-reconciliation";
import { sendAdminPaymentFailureAlert } from "@/lib/email";

const tx = {
  $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  $queryRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  lodge: { findFirst: (...args: unknown[]) => mocks.lodgeFindFirst(...args) },
  booking: {
    findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    updateMany: (...args: unknown[]) => mocks.bookingUpdateMany(...args),
  },
  payment: {
    findUnique: (...args: unknown[]) => mocks.paymentFindUnique(...args),
    upsert: (...args: unknown[]) => mocks.paymentUpsert(...args),
    updateMany: (...args: unknown[]) => mocks.paymentUpdateMany(...args),
  },
  paymentRefund: {
    count: (...args: unknown[]) => mocks.paymentRefundCount(...args),
  },
  paymentTransaction: {
    findFirst: (...args: unknown[]) => mocks.paymentTransactionFindFirst(...args),
    findMany: (...args: unknown[]) => mocks.paymentTransactionFindMany(...args),
    updateMany: (...args: unknown[]) =>
      mocks.paymentTransactionUpdateMany(...args),
    create: (...args: unknown[]) => mocks.paymentTransactionCreate(...args),
  },
  paymentRecoveryOperation: {
    findMany: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationFindMany(...args),
    findFirst: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationFindFirst(...args),
    updateMany: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationUpdateMany(...args),
    deleteMany: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationDeleteMany(...args),
  },
  manualRefundTask: {
    findFirst: (...args: unknown[]) => mocks.manualRefundTaskFindFirst(...args),
  },
  xeroObjectLink: {
    findFirst: (...args: unknown[]) => mocks.xeroObjectLinkFindFirst(...args),
  },
  xeroSyncOperation: {
    findFirst: (...args: unknown[]) => mocks.xeroSyncOperationFindFirst(...args),
  },
};

const ADMIN_ID = "admin-1";

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: BookingStatus.PAYMENT_PENDING,
    finalPriceCents: 12000,
    checkIn: parseDateOnly("2026-08-01"),
    checkOut: parseDateOnly("2026-08-03"),
    parentBookingId: null,
    organiserSettled: false,
    guests: [],
    member: {
      id: "member-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.org",
    },
    ...overrides,
  };
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment-1",
    xeroInvoiceId: null,
    xeroRefundCreditNoteId: null,
    manuallyMarkedPaidAt: null,
    refundedAmountCents: 0,
    ...overrides,
  };
}

/** No Xero evidence of any kind. */
function primeNoXeroEvidence() {
  mocks.paymentTransactionFindFirst.mockResolvedValue(null);
  mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
  mocks.xeroSyncOperationFindFirst.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)
  );
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
  mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  mocks.lockMemberCreditLedger.mockResolvedValue(undefined);
  mocks.deriveBookingAppliedCreditCents.mockResolvedValue(2000);
  mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: true });
  mocks.bookingFindUnique.mockImplementation(async (args: { select?: unknown }) =>
    args.select ? { lodgeId: "lodge-1" } : bookingRow()
  );
  mocks.paymentFindUnique.mockResolvedValue(paymentRow());
  mocks.paymentUpsert.mockResolvedValue({ id: "payment-1" });
  mocks.paymentUpdateMany.mockResolvedValue({ count: 1 });
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 0 });
  mocks.paymentTransactionCreate.mockResolvedValue({ id: "txn-manual" });
  mocks.paymentTransactionFindMany.mockResolvedValue([]);
  mocks.paymentRecoveryOperationFindMany.mockResolvedValue([]);
  mocks.paymentRecoveryOperationUpdateMany.mockResolvedValue({ count: 0 });
  mocks.paymentRecoveryOperationDeleteMany.mockResolvedValue({ count: 0 });
  mocks.manualRefundTaskFindFirst.mockResolvedValue(null);
  mocks.paymentRefundCount.mockResolvedValue(0);
  mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.createAuditLog.mockResolvedValue(undefined);
  mocks.cancelPaymentIntentIfCancellable.mockResolvedValue(true);
  primeNoXeroEvidence();
});

function settle(overrides: Record<string, unknown> = {}) {
  return markBookingPaymentManuallySettled({
    bookingId: "booking-1",
    actingAdminMemberId: ADMIN_ID,
    note: "cash at the lodge",
    expectedAmountCents: 10000,
    notifyMember: false,
    ...overrides,
  });
}

describe("#2262 guard 1 — the manual settlement runs the ONE settlement body", () => {
  it("takes global lock(1), then the per-lodge lock, then the MEMBER-CREDIT lock, before deriving the amount", async () => {
    const order: string[] = [];
    mocks.executeRaw.mockImplementation(async () => {
      order.push("global");
    });
    mocks.acquireLodgeCapacityLock.mockImplementation(async () => {
      order.push("lodge");
    });
    mocks.lockMemberCreditLedger.mockImplementation(async () => {
      order.push("member-credit");
    });
    mocks.deriveBookingAppliedCreditCents.mockImplementation(async () => {
      order.push("derive-amount");
      return 2000;
    });

    await settle();

    expect(order).toEqual(["global", "lodge", "member-credit", "derive-amount"]);
  });

  it("settles at the RE-DERIVED effective price, never a client-supplied amount, and the ledger mirror holds", async () => {
    const result = await settle();

    expect(result.effectiveAmountCents).toBe(10000);
    expect(result.creditAppliedCents).toBe(2000);
    expect(
      result.effectiveAmountCents + result.creditAppliedCents
    ).toBe(12000);
    expect(Number.isInteger(result.effectiveAmountCents)).toBe(true);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentStatus.SUCCEEDED,
          source: PaymentSource.INTERNET_BANKING,
          amountCents: 10000,
          creditAppliedCents: 2000,
        }),
      })
    );
  });

  it("claims PAID behind the shared status fence and reconciles bed allocations", async () => {
    await settle();

    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: {
          in: [
            BookingStatus.PAYMENT_PENDING,
            BookingStatus.CONFIRMED,
            BookingStatus.PENDING,
            BookingStatus.DRAFT,
          ],
        },
      },
      data: { status: BookingStatus.PAID, draftExpiresAt: null },
    });
    expect(mocks.reconcileBedAllocationsForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", db: tx })
    );
  });

  it("records the durable MEMBER_PAID fact with the ACTING ADMIN as the actor", async () => {
    await settle();

    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        type: "MEMBER_PAID",
        actorMemberId: ADMIN_ID,
        amountCents: 10000,
        reason: "manual_mark_paid",
      })
    );
  });

  it("REFUSES on a capacity failure and writes nothing (no cancel, no refund machinery)", async () => {
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: false });

    await expect(settle()).rejects.toThrow(
      /no longer fits the lodge — nothing was recorded/
    );
    // The PAID claim, the fenced payment write and the Stripe cancel-and-refund
    // machinery are all untouched.
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.planStripeRefundAllocation).not.toHaveBeenCalled();
  });

  it("settles an over-capacity booking that carries a persisted #1771 override", async () => {
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: false });
    mocks.bookingFindUnique.mockImplementation(async (args: { select?: unknown }) =>
      args.select
        ? { lodgeId: "lodge-1" }
        : bookingRow({
            capacityOverridden: true,
            capacityOverriddenAt: new Date(),
          })
    );

    await expect(settle()).resolves.toMatchObject({ paymentId: "payment-1" });
  });

  it("409s when the expected amount the admin saw no longer matches", async () => {
    await expect(settle({ expectedAmountCents: 9900 })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("amount owing changed"),
    });
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("409s on an already-PAID booking without adjudicating anything", async () => {
    mocks.bookingFindUnique.mockImplementation(async (args: { select?: unknown }) =>
      args.select
        ? { lodgeId: "lodge-1" }
        : bookingRow({ status: BookingStatus.PAID })
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already paid"),
    });
  });

  it("409s with a zero-owing message naming the paths that CAN settle it", async () => {
    mocks.deriveBookingAppliedCreditCents.mockResolvedValue(12000);

    await expect(settle({ expectedAmountCents: 0 })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(
        "Force confirm / Confirm pending guests"
      ),
    });
  });

  it("409s when the fenced payment write matches nothing (an invoice or group settlement landed between read and write)", async () => {
    mocks.paymentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(settle()).rejects.toMatchObject({ status: 409 });
  });

  it("the fenced write re-asserts EVERY expressible refusal condition, including the settled-from statuses, refund history, the transaction-stamped drift shape and organiserSettled", async () => {
    await settle();

    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "payment-1",
          xeroInvoiceId: null,
          xeroRefundCreditNoteId: null,
          manuallyMarkedPaidAt: null,
          // M6: only the documented settled-from statuses can flip to
          // SUCCEEDED. FAILED is deliberately included — a declined card
          // attempt is exactly what cash at the lodge remedies — while
          // SUCCEEDED / (PARTIALLY_)REFUNDED can never be clobbered.
          status: {
            in: [
              PaymentStatus.PENDING,
              PaymentStatus.PROCESSING,
              PaymentStatus.FAILED,
            ],
          },
          // L7: no refund history.
          refundedAmountCents: 0,
          transactions: { none: { xeroInvoiceId: { not: null } } },
          booking: { organiserSettled: false },
        },
      })
    );
  });

  it("L7 — refuses at read time when the payment already carries refund history", async () => {
    mocks.paymentFindUnique.mockResolvedValue(
      paymentRow({ refundedAmountCents: 2500 })
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/refund history/),
    });
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });
});

describe("#2262 — the manual transaction mint", () => {
  it("EXCLUDES FAILED rows from the update predicate, so a reversal's row is never resurrected at a stale amount", async () => {
    await settle();

    expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            notIn: [
              PaymentStatus.REFUNDED,
              PaymentStatus.PARTIALLY_REFUNDED,
              PaymentStatus.FAILED,
            ],
          },
        }),
      })
    );
  });

  it("CREATES UNCONDITIONALLY on count 0 — it must NOT copy the inbound mint's existingPrimary fallback", async () => {
    // The reversed-then-re-marked shape: a FAILED IB PRIMARY row exists, so the
    // update matches nothing. Copying the inbound fallback would find that row
    // and mint nothing, leaving a PAID payment with NO settled transaction.
    mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 0 });

    await settle();

    expect(mocks.paymentTransactionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: "payment-1",
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.INTERNET_BANKING,
        stripePaymentIntentId: null,
        amountCents: 10000,
        status: PaymentStatus.SUCCEEDED,
        reason: "manual_mark_paid",
      }),
    });
  });

  it("does not create a second row when an existing non-FAILED row was updated", async () => {
    mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 1 });

    await settle();

    expect(mocks.paymentTransactionCreate).not.toHaveBeenCalled();
  });
});

describe("#2262 guard 2 — Xero refusals", () => {
  const cases: Array<[string, () => void, RegExp]> = [
    [
      "a payment-level invoice id",
      () =>
        mocks.paymentFindUnique.mockResolvedValue(
          paymentRow({ xeroInvoiceId: "inv-1" })
        ),
      /outstanding Xero invoice/,
    ],
    [
      "a refund credit note",
      () =>
        mocks.paymentFindUnique.mockResolvedValue(
          paymentRow({ xeroRefundCreditNoteId: "cn-1" })
        ),
      /outstanding Xero invoice/,
    ],
    [
      "a transaction-level invoice id (the modeled drift shape)",
      () => mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "txn-1" }),
      /outstanding Xero invoice/,
    ],
    [
      "an active PRIMARY_INVOICE object link",
      () => mocks.xeroObjectLinkFindFirst.mockResolvedValue({ id: "link-1" }),
      /outstanding Xero invoice/,
    ],
  ];

  for (const [label, prime, message] of cases) {
    it(`refuses when the payment carries ${label}`, async () => {
      prime();
      await expect(settle()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(message) });
      expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    });
  }

  it("refuses when a CREATE-INVOICE outbox operation has already SUCCEEDED", async () => {
    mocks.xeroSyncOperationFindFirst.mockImplementation(
      async (args: { where: { status: unknown } }) =>
        args.where.status === "SUCCEEDED" ? { id: "op-1" } : null
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/outstanding Xero invoice/),
    });
  });

  it("refuses while a CREATE-INVOICE outbox operation is still IN FLIGHT", async () => {
    mocks.xeroSyncOperationFindFirst.mockImplementation(
      async (args: { where: { status: unknown } }) =>
        typeof args.where.status === "object" ? { id: "op-2" } : null
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/already queued/),
    });
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("pins the settle-time in-flight predicate: the op-status set is exactly PENDING/RUNNING/WAITING_PAYMENT (level 2 of the mint fence)", async () => {
    // H3 relies on this set: the operator retry CLAIMS its FAILED/PARTIAL row
    // to RUNNING before minting, precisely so this fence sees it. Narrowing
    // this set (or widening it silently) would re-open the settle-vs-mint race,
    // so the exact predicate is pinned.
    await settle();

    expect(mocks.xeroSyncOperationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: "payment-1",
          status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
        }),
      })
    );
  });

  it("refuses a booking settled as part of a group booking", async () => {
    mocks.bookingFindUnique.mockImplementation(async (args: { select?: unknown }) =>
      args.select ? { lodgeId: "lodge-1" } : bookingRow({ organiserSettled: true })
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/group booking/),
    });
  });
});

describe("#2262 — Stripe intent hygiene", () => {
  it("enqueues a durable CANCEL_PAYMENT_INTENT for every live intent, in-transaction, and cancels best-effort AFTER commit", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      {
        id: "txn-live",
        stripePaymentIntentId: "pi_live",
        amountCents: 10000,
      },
    ]);

    const result = await settle();

    expect(mocks.enqueuePaymentIntentCancellationRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentId: "payment-1",
        paymentTransactionId: "txn-live",
        paymentIntentId: "pi_live",
        store: tx,
      })
    );
    expect(result.outstandingIntentIds).toEqual(["pi_live"]);
    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_live");
  });

  it("only considers non-terminal intents", async () => {
    await settle();

    expect(mocks.paymentTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        }),
      })
    );
  });
});

describe("#2262 — audit trail", () => {
  it("writes the finance audit row inside the transaction, recording the email decision BOTH ways", async () => {
    await settle({ notifyMember: true });

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-payment.mark-paid",
        actorMemberId: ADMIN_ID,
        category: "payment",
        severity: "important",
        metadata: expect.objectContaining({
          effectiveAmountCents: 10000,
          creditAppliedCents: 2000,
          hasXeroInvoiceLink: false,
          notifyMember: true,
        }),
      }),
      tx
    );
  });
});

describe("#2262 — the reversal (direction unpaid)", () => {
  function primeReversal(
    overrides: { payment?: Record<string, unknown> } = {}
  ) {
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: unknown }) =>
        args.select
          ? { lodgeId: "lodge-1" }
          : {
              ...bookingRow({ status: BookingStatus.PAID }),
              payment: {
                id: "payment-1",
                amountCents: 10000,
                refundedAmountCents: 0,
                xeroInvoiceId: null,
                xeroRefundCreditNoteId: null,
                internetBankingHoldSlots: false,
                internetBankingHoldUntil: null,
                manuallyMarkedPaidAt: new Date("2026-07-20T00:00:00Z"),
                manuallyMarkedPaidPreviousStatus: BookingStatus.PAYMENT_PENDING,
                ...overrides.payment,
              },
            }
    );
  }

  function reverse() {
    return reverseManualBookingPayment({
      bookingId: "booking-1",
      actingAdminMemberId: ADMIN_ID,
      note: null,
    });
  }

  it("HIGH #1 — DELETES every pending CANCEL_PAYMENT_INTENT / REFUND_SUPERSEDED_PAYMENT operation inside its own transaction, behind the status fence", async () => {
    primeReversal();
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([
      {
        id: "op-cancel",
        type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
        status: PaymentRecoveryOperationStatus.PENDING,
        paymentIntentId: "pi_live",
        paymentTransactionId: "txn-live",
        amountCents: 10000,
        idempotencyKey: "payment_recovery_cancel_txn-live_pi_live",
        attempts: 0,
        createdAt: new Date("2026-07-20T00:00:00Z"),
      },
    ]);
    mocks.paymentRecoveryOperationDeleteMany.mockResolvedValue({ count: 1 });

    const result = await reverse();

    // A DELETE, never a status flip: the webhook-side liveness predicates
    // (queueSupersededPaymentIntentRefundRecovery, listLiveSupersededIntentIds,
    // findLiveSupersededIntentOperation) all key on `status != SUCCEEDED`, so a
    // FAILED "closed" row would still hand a post-reversal capture to the
    // superseded-refund machinery and poison the duplicate-guard notIn
    // exclusion forever. Only deletion makes every predicate coherent.
    expect(mocks.paymentRecoveryOperationDeleteMany).toHaveBeenCalledWith({
      where: {
        paymentId: "payment-1",
        type: {
          in: [
            PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
            PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          ],
        },
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
          ],
        },
      },
    });
    expect(mocks.paymentRecoveryOperationUpdateMany).not.toHaveBeenCalled();
    expect(result.closedRecoveryOperationIds).toEqual(["op-cancel"]);
    // The deleted rows' full content lives on in the AuditLog metadata.
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          closedRecoveryOperationIds: ["op-cancel"],
          closedRecoveryOperations: [
            expect.objectContaining({
              id: "op-cancel",
              type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
              paymentIntentId: "pi_live",
              idempotencyKey: "payment_recovery_cancel_txn-live_pi_live",
            }),
          ],
        }),
      }),
      tx
    );
  });

  it("M3 — a member-owed superseded-refund operation SURVIVES: its settled transaction 409s the reversal before the disarm is reached", async () => {
    // The handoff that creates a REFUND_SUPERSEDED_PAYMENT op marks its
    // transaction SUCCEEDED first, so any payment carrying such an op also
    // carries a settled Stripe transaction — which this fence refuses on.
    // The disarm can therefore never delete money the machinery owes back.
    primeReversal();
    mocks.paymentTransactionFindFirst.mockImplementation(
      async (args: { where: { source?: unknown } }) =>
        args.where.source === PaymentSource.STRIPE
          ? { id: "txn-superseded-late-capture" }
          : null
    );
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([
      {
        id: "op-refund",
        type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
        status: PaymentRecoveryOperationStatus.PENDING,
        paymentIntentId: "pi_superseded",
        paymentTransactionId: "txn-superseded-late-capture",
        amountCents: 10000,
        idempotencyKey: "payment_recovery_refund_txn_pi",
        attempts: 0,
        createdAt: new Date("2026-07-20T00:00:00Z"),
      },
    ]);

    await expect(reverse()).rejects.toMatchObject({ status: 409 });
    expect(mocks.paymentRecoveryOperationDeleteMany).not.toHaveBeenCalled();
  });

  it("M2 — after a reversal's delete, a re-mark re-arms the cancel op through the enqueue upsert's CREATE arm", async () => {
    // The reversal DELETED the settle's cancel op, so the re-mark's enqueue
    // upsert finds no row on the idempotency key and its create arm fires
    // fresh (PENDING, nextRetryAt now) — the durable cancel hygiene survives
    // mark -> reverse -> re-mark. Pinned against the real
    // enqueuePaymentIntentCancellationRecovery in payment-recovery.test.ts;
    // here we pin that the settle path calls it for every live intent even
    // when a previous settle-and-reverse cycle already happened.
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { id: "txn-live", stripePaymentIntentId: "pi_live", amountCents: 10000 },
    ]);
    // Reversed-then-re-marked mint shape: the FAILED row blocks the update arm.
    mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 0 });

    const result = await settle();

    expect(mocks.enqueuePaymentIntentCancellationRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_live", store: tx })
    );
    expect(result.outstandingIntentIds).toEqual(["pi_live"]);
  });

  it("is idempotent: a replayed reversal closes nothing and 409s on its own fenced write", async () => {
    primeReversal();
    mocks.paymentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(reverse()).rejects.toMatchObject({ status: 409 });
  });

  it("restores a stored DRAFT as PAYMENT_PENDING (draftExpiresAt was cleared by the PAID claim, so there is nothing to restore)", async () => {
    primeReversal({
      payment: { manuallyMarkedPaidPreviousStatus: BookingStatus.DRAFT },
    });

    const result = await reverse();

    expect(result.restoredStatus).toBe(BookingStatus.PAYMENT_PENDING);
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", status: BookingStatus.PAID },
      data: { status: BookingStatus.PAYMENT_PENDING },
    });
  });

  it("clears a restored CONFIRMED internet-banking hold deadline, so the expiry cron cannot auto-cancel the booking minutes later", async () => {
    primeReversal({
      payment: {
        manuallyMarkedPaidPreviousStatus: BookingStatus.CONFIRMED,
        internetBankingHoldSlots: true,
        internetBankingHoldUntil: new Date("2026-07-01T00:00:00Z"),
      },
    });

    const result = await reverse();

    expect(result.clearedInternetBankingHold).toBe(true);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ internetBankingHoldUntil: null }),
      })
    );
  });

  it("marks the manual transaction FAILED rather than deleting it, so history is preserved and the mint never resurrects it", async () => {
    primeReversal();

    await reverse();

    expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith({
      where: {
        paymentId: "payment-1",
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.INTERNET_BANKING,
        status: PaymentStatus.SUCCEEDED,
      },
      data: {
        status: PaymentStatus.FAILED,
        reason: "manual_mark_paid_reversed",
      },
    });
  });

  it("refuses when a card payment has since settled the booking", async () => {
    primeReversal();
    mocks.paymentTransactionFindFirst.mockImplementation(
      async (args: { where: { source?: unknown } }) =>
        args.where.source === PaymentSource.STRIPE ? { id: "txn-stripe" } : null
    );

    await expect(reverse()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/card payment has since settled/),
    });
  });

  it("refuses while an open manual refund task exists", async () => {
    primeReversal();
    mocks.manualRefundTaskFindFirst.mockResolvedValue({ id: "task-1" });

    await expect(reverse()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/open manual refund task/),
    });
  });

  it("refuses when a Xero invoice has been acquired since the settle", async () => {
    primeReversal();
    mocks.xeroObjectLinkFindFirst.mockResolvedValue({ id: "link-1" });

    await expect(reverse()).rejects.toBeInstanceOf(ManualBookingPaymentError);
  });

  it("refuses a payment that was never manually settled", async () => {
    primeReversal({ payment: { manuallyMarkedPaidAt: null } });

    await expect(reverse()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/Only a manually recorded payment/),
    });
  });
});

describe("#2262 door 3 — a stored credit election (#2265) is never silently stranded", () => {
  const UNAPPLIED_ACTION = "booking.credit_election.unapplied";

  /** The settle-shaped booking read, carrying a stored, unconsumed election. */
  function primeSettleWithElection(electionCents: number | null = 4500) {
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: unknown }) =>
        args.select
          ? { lodgeId: "lodge-1" }
          : bookingRow({ creditElectionCents: electionCents })
    );
  }

  /** The reversal-shaped booking read (mirrors the sibling describe's helper). */
  function primeReversalRead() {
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: unknown }) =>
        args.select
          ? { lodgeId: "lodge-1" }
          : {
              ...bookingRow({
                status: BookingStatus.PAID,
                creditElectionCents: null,
              }),
              payment: {
                id: "payment-1",
                amountCents: 10000,
                refundedAmountCents: 0,
                xeroInvoiceId: null,
                xeroRefundCreditNoteId: null,
                internetBankingHoldSlots: false,
                internetBankingHoldUntil: null,
                manuallyMarkedPaidAt: new Date("2026-07-20T00:00:00Z"),
                manuallyMarkedPaidPreviousStatus: BookingStatus.PAYMENT_PENDING,
              },
            }
    );
  }

  function unappliedAuditCalls() {
    return mocks.createAuditLog.mock.calls.filter(
      (call) => (call[0] as { action?: string })?.action === UNAPPLIED_ACTION
    );
  }

  /** Every write's data payload, so "nothing touched the election" is provable. */
  function electionWritePayloads() {
    return [
      ...mocks.bookingUpdateMany.mock.calls,
      ...mocks.paymentUpdateMany.mock.calls,
    ]
      .map((call) => (call[0] as { data?: Record<string, unknown> })?.data ?? {})
      .filter((data) => "creditElectionCents" in data);
  }

  beforeEach(() => {
    vi.mocked(sendAdminPaymentFailureAlert).mockResolvedValue(
      undefined as never
    );
  });

  it("CLEARS the election with the guarded claim, audits it on the mark-paid row, and reports the honest member-visible copy", async () => {
    primeSettleWithElection(4500);

    const result = await settle();

    // The guarded claim — the exact amount that was read moves to NULL, the
    // same discipline every #2319 door uses, so a consumer racing this settle
    // is never clobbered.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", creditElectionCents: 4500 },
      data: { creditElectionCents: null },
    });

    // The cleared cents ride the mark-paid audit row's own metadata...
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-payment.mark-paid",
        metadata: expect.objectContaining({
          clearedCreditElectionCents: 4500,
        }),
      }),
      expect.anything()
    );

    // ...and the shared #2319 reporter writes the member-visible row: the
    // booking history renders this exact action as "your credit was not used
    // and is still available".
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: UNAPPLIED_ACTION,
        entityId: "booking-1",
        subjectMemberId: "member-1",
        metadata: expect.objectContaining({
          source: "manual-mark-paid",
          creditElectionCents: 4500,
          paidAmountCents: 10000,
          paymentId: "payment-1",
          actingAdminMemberId: ADMIN_ID,
        }),
      })
    );

    // The operator alert says the balance is untouched — cash collected outside
    // the app means the member's credit was NOT spent — and, this door having
    // neither a Stripe intent nor a Xero invoice, references the booking id.
    expect(vi.mocked(sendAdminPaymentFailureAlert)).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4500,
        paymentIntentId: "booking-1",
        errorMessage: expect.stringContaining(
          "account credit balance is untouched"
        ),
      })
    );

    expect(result.staleCreditElectionCents).toBe(4500);
  });

  it("does nothing and reports nothing when the booking carries no election — the overwhelmingly common case", async () => {
    const result = await settle();

    expect(electionWritePayloads()).toEqual([]);
    expect(unappliedAuditCalls()).toEqual([]);
    expect(vi.mocked(sendAdminPaymentFailureAlert)).not.toHaveBeenCalled();
    expect(result.staleCreditElectionCents).toBeNull();
  });

  it("reports nothing when the guarded claim is lost — a racing consumer already owns the election", async () => {
    primeSettleWithElection(4500);
    mocks.bookingUpdateMany.mockImplementation(
      async (args: { data?: Record<string, unknown> }) =>
        args.data && "creditElectionCents" in args.data
          ? { count: 0 }
          : { count: 1 }
    );

    const result = await settle();

    expect(unappliedAuditCalls()).toEqual([]);
    expect(vi.mocked(sendAdminPaymentFailureAlert)).not.toHaveBeenCalled();
    expect(result.staleCreditElectionCents).toBeNull();
  });

  it("the reversal never resurrects a cleared election", async () => {
    primeReversalRead();

    await reverseManualBookingPayment({
      bookingId: "booking-1",
      actingAdminMemberId: ADMIN_ID,
      note: null,
    });

    // No write on either row touches the column: the member was already told
    // their credit is still available, and the restored booking's pay step
    // asks about credit afresh.
    expect(electionWritePayloads()).toEqual([]);
  });

  it("mark-paid -> reversal -> re-mark clears and reports exactly once — no double-clear, no resurrection", async () => {
    // 1. The settle clears the election and reports it.
    primeSettleWithElection(4500);
    await settle();
    expect(unappliedAuditCalls()).toHaveLength(1);
    expect(vi.mocked(sendAdminPaymentFailureAlert)).toHaveBeenCalledTimes(1);

    // 2. The reversal restores the booking; the election stays NULL.
    primeReversalRead();
    await reverseManualBookingPayment({
      bookingId: "booking-1",
      actingAdminMemberId: ADMIN_ID,
      note: null,
    });

    // 3. The re-mark finds no election: nothing to clear, nothing to report.
    primeSettleWithElection(null);
    mocks.paymentFindUnique.mockResolvedValue(paymentRow());
    const remark = await settle();

    expect(remark.staleCreditElectionCents).toBeNull();
    expect(unappliedAuditCalls()).toHaveLength(1);
    expect(vi.mocked(sendAdminPaymentFailureAlert)).toHaveBeenCalledTimes(1);
  });
});
