import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2902 (INV-PAY-050): provider-backed Stripe CASH refund evidence.
 *
 * `Payment.refundedAmountCents` mirrors BOTH dispositions — Stripe cash and
 * member account credit — so the Xero refund-note pipeline must never read it
 * as cash. These tests pin the two resolution rules:
 *
 * - ANY PaymentRefund ledger rows → sum of `succeeded` rows, capped at the
 *   mirror ("provider-ledger"); failed/pending rows contribute nothing, and a
 *   ledger of only failures resolves to ZERO cash rather than falling back.
 * - NO ledger rows (pre-2026-05-09 history) → mirror minus the account-credit
 *   disposition ("legacy-mirror"), clamped at zero, excluding restore rows
 *   and non-refund credit types.
 */

const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  aggregate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRefund: { groupBy: mocks.groupBy },
    memberCredit: { aggregate: mocks.aggregate },
  },
}));

import { resolveStripeCashRefundEvidence } from "@/lib/stripe-cash-refund-evidence";

const payment = {
  id: "pay_1",
  bookingId: "book_1",
  refundedAmountCents: 10000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.groupBy.mockResolvedValue([]);
  mocks.aggregate.mockResolvedValue({ _sum: { amountCents: null } });
});

describe("resolveStripeCashRefundEvidence — provider-ledger rule", () => {
  it("sums succeeded PaymentRefund rows per payment and ignores other statuses", async () => {
    mocks.groupBy.mockResolvedValue([
      { status: "succeeded", _sum: { amountCents: 6000 }, _count: { _all: 2 } },
      { status: "failed", _sum: { amountCents: 4000 }, _count: { _all: 1 } },
      { status: "pending", _sum: { amountCents: 1000 }, _count: { _all: 1 } },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence).toEqual({
      cashRefundCents: 6000,
      succeededRefundCents: 6000,
      refundLedgerRowCount: 4,
      accountCreditCents: 0,
      source: "provider-ledger",
    });
    expect(mocks.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["status"],
        where: { paymentId: "pay_1" },
      })
    );
    // The provider-ledger path never consults the credit disposition.
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it("caps the cash target at the refundedAmountCents mirror", async () => {
    // A ledger anomaly (succeeded rows above the mirror) must not make the
    // pipeline owe MORE notes than the settlement mirror ever recorded.
    mocks.groupBy.mockResolvedValue([
      { status: "succeeded", _sum: { amountCents: 12000 }, _count: { _all: 3 } },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.cashRefundCents).toBe(10000);
    expect(evidence.succeededRefundCents).toBe(12000);
    expect(evidence.source).toBe("provider-ledger");
  });

  it("resolves a failed-only ledger to ZERO cash rather than falling back to the mirror", async () => {
    // The rows prove the ledger era; their statuses prove no cash moved.
    mocks.groupBy.mockResolvedValue([
      { status: "failed", _sum: { amountCents: 10000 }, _count: { _all: 1 } },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence).toMatchObject({
      cashRefundCents: 0,
      succeededRefundCents: 0,
      refundLedgerRowCount: 1,
      source: "provider-ledger",
    });
  });

  it("clamps a negative succeeded sum to zero", async () => {
    mocks.groupBy.mockResolvedValue([
      { status: "succeeded", _sum: { amountCents: -500 }, _count: { _all: 1 } },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.cashRefundCents).toBe(0);
    expect(evidence.succeededRefundCents).toBe(0);
  });
});

describe("resolveStripeCashRefundEvidence — legacy-mirror fallback", () => {
  it("subtracts the account-credit disposition from the mirror when no ledger rows exist", async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: 3500 } });

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence).toEqual({
      cashRefundCents: 6500,
      succeededRefundCents: 0,
      refundLedgerRowCount: 0,
      accountCreditCents: 3500,
      source: "legacy-mirror",
    });
    // The disposition query is scoped to the payment's booking, to the two
    // refund credit types, to positive rows, and excludes restores.
    expect(mocks.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceBookingId: "book_1",
          type: {
            in: ["CANCELLATION_REFUND", "BOOKING_MODIFICATION_REFUND"],
          },
          amountCents: { gt: 0 },
          restoredFromBookingId: null,
        }),
      })
    );
  });

  it("resolves an account-credit-only cancellation to ZERO cash (#2902 defect shape)", async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: 10000 } });

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.cashRefundCents).toBe(0);
    expect(evidence.accountCreditCents).toBe(10000);
    expect(evidence.source).toBe("legacy-mirror");
  });

  it("clamps at zero when the credit disposition exceeds the mirror", async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: 15000 } });

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.cashRefundCents).toBe(0);
  });

  it("treats a creditless legacy payment as fully cash-refunded", async () => {
    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence).toMatchObject({
      cashRefundCents: 10000,
      accountCreditCents: 0,
      source: "legacy-mirror",
    });
  });

  it("clamps a negative mirror to zero", async () => {
    const evidence = await resolveStripeCashRefundEvidence({
      ...payment,
      refundedAmountCents: -100,
    });

    expect(evidence.cashRefundCents).toBe(0);
  });
});

describe("resolveStripeCashRefundEvidence — transaction client", () => {
  it("queries through the provided transaction client, not the global one", async () => {
    const tx = {
      paymentRefund: {
        groupBy: vi.fn().mockResolvedValue([
          {
            status: "succeeded",
            _sum: { amountCents: 2500 },
            _count: { _all: 1 },
          },
        ]),
      },
      memberCredit: { aggregate: vi.fn() },
    };

    const evidence = await resolveStripeCashRefundEvidence(
      payment,
      tx as never
    );

    expect(evidence.cashRefundCents).toBe(2500);
    expect(tx.paymentRefund.groupBy).toHaveBeenCalledTimes(1);
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });
});
