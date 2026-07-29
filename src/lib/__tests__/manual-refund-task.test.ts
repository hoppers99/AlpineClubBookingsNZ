import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManualRefundTaskStatus, PaymentSource } from "@prisma/client";

/**
 * B5 (#2262) guard 4 — the cash hand-back task.
 *
 * A cancelled cash-settled booking has no card charge to reverse and no Xero
 * invoice to credit, so the cancellation raises a durable task rather than a
 * silent $0 refund. Completing the task is the ONLY moment the ledger records
 * that money went back.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  manualRefundTaskFindUnique: vi.fn(),
  manualRefundTaskUpdateMany: vi.fn(),
  applyLocalRefundAllocation: vi.fn(),
  createAuditLog: vi.fn(),
  recordBookingEvent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (...a: unknown[]) => mocks.transaction(...a) },
}));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: (...a: unknown[]) =>
    mocks.applyLocalRefundAllocation(...a),
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...a: unknown[]) => mocks.createAuditLog(...a),
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...a: unknown[]) => mocks.recordBookingEvent(...a),
}));
vi.mock("@/lib/email", () => ({ sendBookingConfirmedEmail: vi.fn() }));
vi.mock("@/lib/payment-reconciliation", () => ({
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "ManualBookingPaymentError";
      this.status = status;
    }
  },
  markBookingPaymentManuallySettled: vi.fn(),
  reverseManualBookingPayment: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { resolveManualRefundTask } from "@/lib/manual-booking-payment";

const tx = {
  manualRefundTask: {
    findUnique: (...a: unknown[]) => mocks.manualRefundTaskFindUnique(...a),
    updateMany: (...a: unknown[]) => mocks.manualRefundTaskUpdateMany(...a),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)
  );
  mocks.manualRefundTaskFindUnique.mockResolvedValue({
    id: "task-1",
    bookingId: "booking-1",
    paymentId: "payment-1",
    amountCents: 9000,
    status: ManualRefundTaskStatus.OPEN,
    booking: { memberId: "member-1" },
  });
  mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });
});

describe("resolveManualRefundTask", () => {
  it("completing writes the ledger allocation and the REFUNDED booking event — that is when the money is recorded as returned", async () => {
    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "cash handed back",
      actingMemberId: "admin-1",
    });

    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment-1",
      amountCents: 9000,
      store: tx,
    });
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        type: "REFUNDED",
        amountCents: 9000,
        reason: "manual_refund_completed",
      })
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-refund-task.complete",
        category: "payment",
      }),
      tx
    );
  });

  it("dismissing moves no money and writes no allocation or refund event", async () => {
    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "dismissed",
      note: "member asked us to keep it",
      actingMemberId: "admin-1",
    });

    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-refund-task.dismiss",
      }),
      tx
    );
  });

  it("requires a note to dismiss, so the record still makes sense later", async () => {
    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "dismissed",
        note: "   ",
        actingMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("closes the OPEN -> terminal transition behind a status fence, so a double click cannot double-apply the allocation", async () => {
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: null,
        actingMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.manualRefundTaskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1", status: ManualRefundTaskStatus.OPEN },
      })
    );
  });

  it("409s on an already-closed task", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue({
      id: "task-1",
      bookingId: "booking-1",
      paymentId: "payment-1",
      amountCents: 9000,
      status: ManualRefundTaskStatus.COMPLETED,
      booking: { memberId: "member-1" },
    });

    await expect(
      resolveManualRefundTask({
        taskId: "task-1",
        resolution: "completed",
        note: null,
        actingMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("404s on a task that does not exist", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(null);

    await expect(
      resolveManualRefundTask({
        taskId: "nope",
        resolution: "completed",
        note: null,
        actingMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("#2262 guard 4 — no third PaymentSource member", () => {
  it("PaymentSource stays exactly STRIPE | INTERNET_BANKING", () => {
    expect(Object.keys(PaymentSource).sort()).toEqual([
      "INTERNET_BANKING",
      "STRIPE",
    ]);
  });
});

describe("#2262 guard 3 — the self-match refutation, pinned", () => {
  it("upsertPaymentIntentTransaction hardcodes source STRIPE on BOTH arms, so the widened duplicate-capture predicate's non-Stripe arm can never match the row a Stripe settlement just wrote", async () => {
    // The widened predicate's non-Stripe OR arm carries NO arriving-row
    // exclusion. It cannot self-match, because the probe filters
    // PaymentTransaction.source and this writer hardcodes STRIPE. Pinned here
    // so a future "derive the source from the payment" refactor fails loudly
    // instead of quietly making a Stripe capture refund itself.
    const upsert = vi.fn().mockResolvedValue(undefined);
    const { upsertPaymentIntentTransaction } = await vi.importActual<
      typeof import("@/lib/payment-transactions")
    >("@/lib/payment-transactions");

    await upsertPaymentIntentTransaction({
      paymentId: "payment-1",
      kind: "PRIMARY",
      paymentIntentId: "pi_1",
      amountCents: 1000,
      status: "SUCCEEDED",
      store: {
        paymentTransaction: { upsert },
        payment: { update: vi.fn() },
      } as never,
    }).catch(() => {
      // reconcilePaymentAggregates runs against the same stub and is not the
      // subject of this pin; the upsert shape below is.
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ source: PaymentSource.STRIPE }),
        update: expect.objectContaining({ source: PaymentSource.STRIPE }),
      })
    );
  });
});
