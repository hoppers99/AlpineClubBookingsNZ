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

  it("the fenced write re-asserts EVERY expressible refusal condition, including the transaction-stamped drift shape and organiserSettled", async () => {
    await settle();

    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "payment-1",
          xeroInvoiceId: null,
          xeroRefundCreditNoteId: null,
          manuallyMarkedPaidAt: null,
          transactions: { none: { xeroInvoiceId: { not: null } } },
          booking: { organiserSettled: false },
        },
      })
    );
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

  it("HIGH #1 — terminally closes every pending CANCEL_PAYMENT_INTENT / REFUND_SUPERSEDED_PAYMENT operation inside its own transaction", async () => {
    primeReversal();
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([
      { id: "op-cancel", paymentIntentId: "pi_live" },
    ]);
    mocks.paymentRecoveryOperationUpdateMany.mockResolvedValue({ count: 1 });

    const result = await reverse();

    expect(mocks.paymentRecoveryOperationUpdateMany).toHaveBeenCalledWith({
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
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.FAILED,
        // The queue selects PENDING/FAILED rows with nextRetryAt <= now, so a
        // NULL nextRetryAt is what makes the closure terminal.
        nextRetryAt: null,
        lastError: expect.stringContaining("manual_mark_paid_reversed"),
      }),
    });
    expect(result.closedRecoveryOperationIds).toEqual(["op-cancel"]);
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
