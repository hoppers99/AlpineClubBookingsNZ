/**
 * AID-6C's authoritative booking-finance calculation (#2377).
 *
 * The other finance entries return stored rows, and a contract test is enough for
 * them. This one COMPUTES, so what has to be proved is the arithmetic and the
 * classification — in integer cents, across the money shapes #2377 enumerates:
 * zero, partial, over, under, refunds, credits, cent-level differences and the
 * exact reconciliation identity.
 *
 * `@/lib/member-credit` is deliberately NOT mocked. `deriveBookingAppliedCreditCents`
 * and `getMemberCreditBalance` are the authoritative credit functions every write
 * path validates against, and the whole argument for making this a `server_owned`
 * entry is that it reuses them rather than re-deriving credit. Stubbing them would
 * test a copy of the thing under test, so the Prisma client beneath them is what is
 * stubbed and the real functions run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: vi.fn() },
    payment: { findUnique: vi.fn() },
    memberCredit: { findMany: vi.fn(), aggregate: vi.fn() },
    xeroSyncOperation: { findMany: vi.fn() },
    paymentRecoveryOperation: { findMany: vi.fn() },
    manualRefundTask: { count: vi.fn() },
    refundRequest: { count: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";

import { readBookingFinanceStateEvidence } from "../finance-evidence";

const BOOKING_ID = "clzbooking0000000000000001";
const PAYMENT_ID = "clzpayment0000000000000001";
const MEMBER_ID = "clzmember00000000000000001";

interface Scenario {
  booking?: {
    id?: string;
    memberId?: string;
    status?: string;
    finalPriceCents?: number;
  } | null;
  payment?: {
    id?: string;
    status?: string;
    source?: string;
    amountCents?: number;
    refundedAmountCents?: number;
    creditAppliedCents?: number;
    additionalAmountCents?: number;
    additionalPaymentStatus?: string | null;
    xeroInvoiceId?: string | null;
    manuallyMarkedPaidAt?: Date | null;
  } | null;
  /** Signed `MemberCredit` rows the ledger aggregate should report for the booking. */
  appliedCreditLedgerCents?: number;
  memberCreditBalanceCents?: number;
  cancellationCredits?: { amountCents: number; description: string }[];
  xeroOperations?: { id: string; status: string; createdAt: Date }[];
  recoveryOperations?: { status: string; attempts: number }[];
  openManualRefundTasks?: number;
  pendingRefundAppeals?: number;
}

function setup(scenario: Scenario): void {
  const booking =
    scenario.booking === null
      ? null
      : {
          id: scenario.booking?.id ?? BOOKING_ID,
          memberId: scenario.booking?.memberId ?? MEMBER_ID,
          status: scenario.booking?.status ?? "CONFIRMED",
          finalPriceCents: scenario.booking?.finalPriceCents ?? 10_000,
        };

  const payment =
    scenario.payment === null
      ? null
      : {
          id: scenario.payment?.id ?? PAYMENT_ID,
          status: scenario.payment?.status ?? "SUCCEEDED",
          source: scenario.payment?.source ?? "STRIPE",
          amountCents: scenario.payment?.amountCents ?? 10_000,
          refundedAmountCents: scenario.payment?.refundedAmountCents ?? 0,
          creditAppliedCents: scenario.payment?.creditAppliedCents ?? 0,
          additionalAmountCents: scenario.payment?.additionalAmountCents ?? 0,
          additionalPaymentStatus:
            scenario.payment?.additionalPaymentStatus ?? null,
          xeroInvoiceId:
            scenario.payment?.xeroInvoiceId === undefined
              ? "xero-invoice-1"
              : scenario.payment.xeroInvoiceId,
          manuallyMarkedPaidAt: scenario.payment?.manuallyMarkedPaidAt ?? null,
        };

  vi.mocked(prisma.booking.findUnique).mockResolvedValue(
    booking as never,
  );
  vi.mocked(prisma.payment.findUnique).mockResolvedValue(payment as never);

  // The two authoritative credit reads share one Prisma call, so the stub branches
  // on the `where` each of them builds — which is also what pins that this module
  // really is calling both of them.
  vi.mocked(prisma.memberCredit.aggregate).mockImplementation((async (
    args: { where?: Record<string, unknown> },
  ) => {
    if (args?.where && "appliedToBookingId" in args.where) {
      // `deriveBookingAppliedCreditCents` negates and floors this sum.
      return {
        _sum: { amountCents: -(scenario.appliedCreditLedgerCents ?? 0) },
      };
    }
    return {
      _sum: { amountCents: scenario.memberCreditBalanceCents ?? 0 },
    };
  }) as never);

  vi.mocked(prisma.memberCredit.findMany).mockResolvedValue(
    (scenario.cancellationCredits ?? []) as never,
  );
  vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue(
    (scenario.xeroOperations ?? []) as never,
  );
  vi.mocked(prisma.paymentRecoveryOperation.findMany).mockResolvedValue(
    (scenario.recoveryOperations ?? []) as never,
  );
  vi.mocked(prisma.manualRefundTask.count).mockResolvedValue(
    (scenario.openManualRefundTasks ?? 0) as never,
  );
  vi.mocked(prisma.refundRequest.count).mockResolvedValue(
    (scenario.pendingRefundAppeals ?? 0) as never,
  );
}

async function readRow(): Promise<Record<string, unknown>> {
  const rows = await readBookingFinanceStateEvidence({ bookingId: BOOKING_ID });
  expect(rows).toHaveLength(1);
  return rows[0] as Record<string, unknown>;
}

function blockers(row: Record<string, unknown>): string[] {
  const codes = String(row.blocker_codes);
  return codes === "none" ? [] : codes.split(",");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("booking finance state: absence and shape (#2377)", () => {
  it("returns NO rows for a booking that does not exist", async () => {
    // Zero rows is what the executor reports as `not_found` — "we looked and there
    // is nothing" — which is a different answer from a row full of zeroes.
    setup({ booking: null });
    await expect(
      readBookingFinanceStateEvidence({ bookingId: BOOKING_ID }),
    ).resolves.toEqual([]);
  });

  it("returns one row for a booking with NO payment, and says so", async () => {
    setup({ booking: {}, payment: null });
    const row = await readRow();
    expect(row.payment_ref).toBeNull();
    expect(row.payment_status).toBeNull();
    expect(blockers(row)).toContain("payment_record_missing");
    // Nothing was captured, so the whole price is outstanding.
    expect(row.amount_due_cents).toBe(10_000);
    expect(row.amount_paid_cents).toBe(0);
    expect(row.outstanding_cents).toBe(10_000);
  });

  it("rejects rather than returning a partial row when a read fails", async () => {
    // The executor turns a rejection into `evidence_unavailable` and no rows. A
    // finance state assembled from some of its inputs would read as authoritative.
    setup({ booking: {} });
    vi.mocked(prisma.xeroSyncOperation.findMany).mockRejectedValue(
      new Error("database unreachable"),
    );
    await expect(
      readBookingFinanceStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow();
  });
});

describe("booking finance state: integer-cent arithmetic (#2377)", () => {
  it("is exact on a fully paid booking with no credit", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000, status: "SUCCEEDED" },
    });
    const row = await readRow();
    expect(row.amount_due_cents).toBe(10_000);
    expect(row.amount_paid_cents).toBe(10_000);
    expect(row.credit_applied_cents).toBe(0);
    expect(row.outstanding_cents).toBe(0);
    expect(row.ledger_variance_cents).toBe(0);
    expect(row.credit_ledger_variance_cents).toBe(0);
    expect(blockers(row)).toEqual([]);
    expect(row.blocker_codes).toBe("none");
  });

  it("nets applied credit from the LEDGER, not the copy on the payment", async () => {
    // 10,000 due, 3,000 of member credit applied, 7,000 charged. Nothing outstanding.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 7_000, creditAppliedCents: 3_000 },
      appliedCreditLedgerCents: 3_000,
    });
    const row = await readRow();
    expect(row.credit_applied_cents).toBe(3_000);
    expect(row.amount_paid_cents).toBe(7_000);
    expect(row.outstanding_cents).toBe(0);
    expect(row.ledger_variance_cents).toBe(0);
    expect(blockers(row)).toEqual([]);
  });

  it("reports a CENT-level ledger variance rather than rounding it away", async () => {
    // 10,001 due; 10,000 charged and 0 credit. One cent short, and the identity
    // `amount + credit + uncollected = final` is broken by exactly that cent.
    setup({
      booking: { finalPriceCents: 10_001 },
      payment: { amountCents: 10_000, creditAppliedCents: 0 },
    });
    const row = await readRow();
    expect(row.ledger_variance_cents).toBe(-1);
    expect(row.outstanding_cents).toBe(1);
    expect(blockers(row)).toContain("ledger_variance");
  });

  it("reports an OVERPAYMENT as a negative outstanding and a positive variance", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 12_000 },
    });
    const row = await readRow();
    expect(row.amount_paid_cents).toBe(12_000);
    expect(row.outstanding_cents).toBe(-2_000);
    expect(row.ledger_variance_cents).toBe(2_000);
    expect(blockers(row)).toContain("ledger_variance");
  });

  it("reports an UNDERPAYMENT as an outstanding balance", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 6_000 },
    });
    const row = await readRow();
    expect(row.outstanding_cents).toBe(4_000);
    expect(row.ledger_variance_cents).toBe(-4_000);
  });

  it("does not count an UNCAPTURED payment as paid", async () => {
    // A `PENDING` payment carries an amount, and treating it as money is the single
    // most expensive mistake this tool could make. `hasCapturedPayment` decides.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000, status: "PENDING" },
    });
    const row = await readRow();
    expect(row.amount_paid_cents).toBe(0);
    expect(row.outstanding_cents).toBe(10_000);
    expect(blockers(row)).toContain("payment_pending");
  });

  it("reports how much is still refundable, net of refunds already made", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: {
        amountCents: 10_000,
        refundedAmountCents: 2_500,
        status: "PARTIALLY_REFUNDED",
      },
    });
    const row = await readRow();
    expect(row.refunded_amount_cents).toBe(2_500);
    expect(row.remaining_refundable_cents).toBe(7_500);
  });

  it("never reports a negative refundable amount", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: {
        amountCents: 10_000,
        refundedAmountCents: 12_000,
        status: "REFUNDED",
      },
    });
    const row = await readRow();
    expect(row.remaining_refundable_cents).toBe(0);
  });

  it("counts an uncollected additional payment, and clears it once collected", async () => {
    setup({
      booking: { finalPriceCents: 12_000 },
      payment: {
        amountCents: 10_000,
        additionalAmountCents: 2_000,
        additionalPaymentStatus: "PENDING",
      },
    });
    const pending = await readRow();
    expect(pending.uncollected_additional_cents).toBe(2_000);
    expect(pending.ledger_variance_cents).toBe(0);
    expect(blockers(pending)).toContain("additional_payment_outstanding");

    setup({
      booking: { finalPriceCents: 12_000 },
      payment: {
        amountCents: 12_000,
        additionalAmountCents: 2_000,
        additionalPaymentStatus: "SUCCEEDED",
      },
    });
    const collected = await readRow();
    expect(collected.uncollected_additional_cents).toBe(0);
    expect(collected.ledger_variance_cents).toBe(0);
    expect(blockers(collected)).not.toContain("additional_payment_outstanding");
  });

  it("surfaces a disagreement between the payment's credit column and the ledger", async () => {
    // The discrepancy no screen shows: the denormalised copy says 3,000 and the
    // ledger says 2,500. Signed, in cents, and reported rather than reconciled.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 7_000, creditAppliedCents: 3_000 },
      appliedCreditLedgerCents: 2_500,
    });
    const row = await readRow();
    expect(row.credit_ledger_variance_cents).toBe(500);
    expect(row.credit_applied_cents).toBe(2_500);
    expect(blockers(row)).toContain("credit_ledger_variance");
    // And the OUTSTANDING figure is netted against the LEDGER, not the payment's
    // copy: 10,000 due less 2,500 real credit less 7,000 captured leaves 500 owing.
    // Reading the denormalised column here would report 0 and tell a Finance
    // Officer the booking was square when the member still owes five dollars. A
    // mutation that swapped the two survived every other assertion in this file.
    expect(row.outstanding_cents).toBe(500);
  });

  it("reports the member's credit balance from the authoritative aggregate", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000 },
      memberCreditBalanceCents: 4_250,
    });
    const row = await readRow();
    expect(row.member_credit_balance_cents).toBe(4_250);
  });

  it("keeps every projected amount an integer", async () => {
    setup({
      booking: { finalPriceCents: 10_001 },
      payment: {
        amountCents: 3_333,
        refundedAmountCents: 1_111,
        creditAppliedCents: 3_334,
        additionalAmountCents: 777,
        additionalPaymentStatus: "PENDING",
        status: "PARTIALLY_REFUNDED",
      },
      appliedCreditLedgerCents: 3_334,
      memberCreditBalanceCents: 999,
    });
    const row = await readRow();
    for (const [key, value] of Object.entries(row)) {
      if (!key.endsWith("_cents")) continue;
      expect(Number.isInteger(value), `${key} = ${String(value)}`).toBe(true);
    }
  });
});

describe("booking finance state: blockers and their order (#2377)", () => {
  it("puts an EXHAUSTED refund first, ahead of bookkeeping problems", async () => {
    // A member is owed money and nothing automatic will move it. A missing Xero
    // invoice is bookkeeping; sending a Finance Officer to Xero first would be wrong.
    setup({
      booking: { finalPriceCents: 10_000, status: "CANCELLED" },
      payment: { amountCents: 10_000, xeroInvoiceId: null },
      recoveryOperations: [{ status: "FAILED", attempts: 5 }],
      xeroOperations: [
        { id: "op-1", status: "FAILED", createdAt: new Date("2026-08-01") },
      ],
    });
    const row = await readRow();
    expect(blockers(row)[0]).toBe("refund_execution_exhausted");
    expect(blockers(row)).toContain("xero_operation_failed");
    expect(row.blocker_count).toBe(blockers(row).length);
  });

  it("does not call a refund exhausted below the attempt ceiling", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000 },
      recoveryOperations: [{ status: "FAILED", attempts: 4 }],
    });
    const row = await readRow();
    expect(blockers(row)).not.toContain("refund_execution_exhausted");
    expect(blockers(row)).not.toContain("refund_execution_pending");
  });

  it("reports a queued refund as PENDING — money that has not moved", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000 },
      recoveryOperations: [{ status: "PROCESSING", attempts: 1 }],
    });
    expect(blockers(await readRow())).toContain("refund_execution_pending");
  });

  it("reports an open hand-back task and a pending member appeal separately", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000, source: "INTERNET_BANKING" },
      openManualRefundTasks: 1,
      pendingRefundAppeals: 1,
    });
    const codes = blockers(await readRow());
    expect(codes).toContain("manual_refund_open");
    expect(codes).toContain("refund_appeal_pending");
    // The two are never merged: one is money owed, the other is an undecided request.
    expect(codes.indexOf("manual_refund_open")).toBeLessThan(
      codes.indexOf("refund_appeal_pending"),
    );
  });

  it("reports a missing Xero invoice only once the booking has settled", async () => {
    setup({
      booking: { finalPriceCents: 10_000, status: "CONFIRMED" },
      payment: { amountCents: 10_000, xeroInvoiceId: null },
    });
    expect(blockers(await readRow())).toContain("xero_invoice_missing");

    setup({
      booking: { finalPriceCents: 10_000, status: "DRAFT" },
      payment: { amountCents: 10_000, xeroInvoiceId: null },
    });
    expect(blockers(await readRow())).not.toContain("xero_invoice_missing");
  });

  it("classifies Xero activity with the same states the admin screen uses", async () => {
    for (const [status, expected] of [
      ["FAILED", "operationFailed"],
      ["PARTIAL", "operationPartial"],
      ["PENDING", "operationPending"],
      ["WAITING_PAYMENT", "operationPending"],
    ] as const) {
      setup({
        booking: { finalPriceCents: 10_000 },
        payment: { amountCents: 10_000 },
        xeroOperations: [
          { id: "op-1", status, createdAt: new Date("2026-08-01") },
        ],
      });
      const row = await readRow();
      expect(row.xero_state, status).toBe(expected);
    }
  });

  it("excludes a Xero operation an administrator resolved by hand", async () => {
    // The query filters `manuallyResolvedAt: null`, exactly as the admin overview
    // does. Asserted on the query rather than the result, because the filter is what
    // stops a fixed problem being reported as a live one forever.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000 },
    });
    await readRow();
    const call = vi.mocked(prisma.xeroSyncOperation.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ manuallyResolvedAt: null });
  });

  it("reads the Xero operations of BOTH the booking and its payment", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000 },
    });
    await readRow();
    const call = vi.mocked(prisma.xeroSyncOperation.findMany).mock.calls[0]?.[0];
    expect(call?.where?.localId).toEqual({ in: [BOOKING_ID, PAYMENT_ID] });
    expect(call?.where?.localModel).toEqual({ in: ["Booking", "Payment"] });
  });

  it("reports the authoritative display label rather than inventing one", async () => {
    setup({
      booking: { finalPriceCents: 10_000, status: "CANCELLED" },
      payment: {
        amountCents: 10_000,
        refundedAmountCents: 10_000,
        status: "REFUNDED",
      },
      cancellationCredits: [
        {
          amountCents: 10_000,
          description: "Cancellation refund for booking ABC",
        },
      ],
    });
    const row = await readRow();
    // The label and the settlement kind both come from the shared helpers the
    // admin payments screen renders, so a diagnostic answer and the screen agree.
    expect(row.payment_display_label).toBe("Credit Issued");
    expect(row.settlement_kind).toBe("accountCredit");
  });

  it("never returns a credit DESCRIPTION, even though it reads one to classify", async () => {
    setup({
      booking: { finalPriceCents: 10_000, status: "CANCELLED" },
      payment: {
        amountCents: 10_000,
        refundedAmountCents: 10_000,
        status: "REFUNDED",
      },
      cancellationCredits: [
        {
          amountCents: 10_000,
          description:
            "Cancellation refund for booking ABC — member Jane Tramper, jane@example.org",
        },
      ],
    });
    const row = await readRow();
    for (const value of Object.values(row)) {
      if (typeof value !== "string") continue;
      expect(value).not.toContain("Jane Tramper");
      expect(value).not.toContain("example.org");
    }
  });

  it("flags a payment settled by hand, which has no card leg to refund", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: {
        amountCents: 10_000,
        source: "INTERNET_BANKING",
        manuallyMarkedPaidAt: new Date("2026-08-01"),
      },
    });
    const row = await readRow();
    expect(row.manually_marked_paid).toBe(true);
  });
});
