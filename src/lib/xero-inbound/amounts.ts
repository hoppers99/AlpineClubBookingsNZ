import { type CreditNote as XeroCreditNote, type Payment as XeroPayment } from "xero-node";
import { PaymentStatus } from "@prisma/client";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { type AccountCreditAllocationTarget, type CreditNoteAmounts } from "./types";

export function buildSyntheticAllocationLinkId(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number
): string {
  return buildXeroIdempotencyKey(
    "allocation",
    creditNoteId,
    invoiceId,
    amountCents,
    "v1"
  );
}

function getPositiveCurrencyAmountCents(value: number | null | undefined): number | null {
  // The positivity test stays on the DOLLARS, ahead of the conversion, exactly
  // where it was: an amount of 0.001 is rejected here for being sub-cent, and
  // testing the rounded cents instead would let it through as a zero (#2685).
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return providerAmountToCents(value);
}

export function getCreditNoteAmountCents(
  creditNote: CreditNoteAmounts
): number | null {
  const totalAmountCents = getPositiveCurrencyAmountCents(creditNote.total);
  if (totalAmountCents !== null) {
    return totalAmountCents;
  }

  const appliedAmount = creditNote.appliedAmount ?? 0;
  const remainingAmount = creditNote.remainingCredit ?? 0;
  return getPositiveCurrencyAmountCents(appliedAmount + remainingAmount);
}

export function getJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function isIncludedRefundCreditNoteStatus(status: unknown) {
  if (typeof status !== "string") {
    return true;
  }

  const normalized = status.trim().toUpperCase();
  return normalized !== "VOIDED" && normalized !== "DELETED";
}

export function getCreditNoteIdFromAllocationMetadata(metadata: unknown): string | null {
  const record = getJsonRecord(metadata);
  const creditNoteId = record?.creditNoteId;
  return typeof creditNoteId === "string" && creditNoteId.trim().length > 0
    ? creditNoteId
    : null;
}

export function getAmountCentsFromAllocationMetadata(metadata: unknown): number | null {
  const record = getJsonRecord(metadata);
  const amountCents = record?.amountCents;

  if (typeof amountCents !== "number" || !Number.isFinite(amountCents) || amountCents <= 0) {
    return null;
  }

  return Math.round(amountCents);
}

export function getRefundContributionCentsFromCreditNoteMetadata(
  metadata: unknown
): number | null {
  const record = getJsonRecord(metadata);
  if (!record || !isIncludedRefundCreditNoteStatus(record.status)) {
    return null;
  }

  return getCreditNoteAmountCents({
    total: typeof record.total === "number" ? record.total : null,
    appliedAmount:
      typeof record.appliedAmount === "number" ? record.appliedAmount : null,
    remainingCredit:
      typeof record.remainingCredit === "number" ? record.remainingCredit : null,
  });
}

export function getNextRefundedPaymentStatus(
  currentStatus: string,
  amountCents: number,
  refundedAmountCents: number
): PaymentStatus | null {
  if (refundedAmountCents <= 0) {
    return currentStatus === PaymentStatus.REFUNDED ||
      currentStatus === PaymentStatus.PARTIALLY_REFUNDED
      ? PaymentStatus.SUCCEEDED
      : null;
  }

  return refundedAmountCents >= amountCents
    ? PaymentStatus.REFUNDED
    : PaymentStatus.PARTIALLY_REFUNDED;
}

export function buildXeroPaymentDisplayNumber(payment: XeroPayment): string | null {
  return payment.invoiceNumber ?? payment.creditNoteNumber ?? null;
}

export function buildBookingAppliedCreditDescription(bookingId: string) {
  return `Applied to booking ${bookingId.slice(0, 8)}`;
}

export function buildCreditNoteAllocationTargets(
  creditNote: Pick<XeroCreditNote, "allocations">
): AccountCreditAllocationTarget[] {
  const allocationTotals = new Map<string, number>();

  for (const allocation of creditNote.allocations ?? []) {
    const invoiceId = allocation.invoice?.invoiceID ?? null;
    const amount = allocation.amount;

    // Same ordering point as above: a non-positive allocation is dropped on the
    // dollars, before rounding, so a sub-cent allocation stays dropped.
    if (!invoiceId || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    const amountCents = providerAmountToCents(amount);
    if (amountCents === null) {
      continue;
    }

    allocationTotals.set(
      invoiceId,
      (allocationTotals.get(invoiceId) ?? 0) + amountCents
    );
  }

  return Array.from(allocationTotals.entries())
    .map(([invoiceId, amountCents]) => ({
      invoiceId,
      amountCents,
    }))
    .filter((target) => target.amountCents > 0);
}
