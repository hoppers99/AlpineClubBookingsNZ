/**
 * Shared helpers for the Xero booking-invoice flows.
 *
 * Tiny utilities used across `xero-booking-invoices`, `xero-credit-notes`,
 * `xero-invoice-payments`, `xero-supplementary-invoices`,
 * `xero-modification-credit-notes`, and `xero-entrance-fee-invoices`.
 * Kept in their own module so the consumers do not have to import each
 * other just for date / allocation helpers.
 */

import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * The invoice's issue date is the booking's check-in, which is a `@db.Date`
 * lodge night — an abstract calendar day already pinned to UTC midnight, not an
 * instant. Truncating it reads back the day it encodes (INV-DATE-010).
 */
export function getBookingInvoiceIssueDate(booking: {
  checkIn: Date | string;
}): string {
  return formatDate(new Date(booking.checkIn));
}

/**
 * The invoice's due date is the club-local calendar day the booking was made.
 *
 * `Booking.createdAt` is a `DateTime` — a real instant — so its UTC calendar day
 * is the PREVIOUS day for roughly the first half of every New Zealand day. Xero
 * received a due date one day early for every booking made in the NZ morning,
 * which also shifted downstream overdue comparisons (#2697). The club timezone
 * is the only correct calendar for this value, so it is derived through the
 * canonical zone-aware helper rather than by truncating the instant.
 */
export function getBookingInvoiceDueDate(booking: {
  createdAt: Date | string;
}): string {
  return formatDateOnlyForTimeZone(new Date(booking.createdAt));
}

/**
 * Construct a stable allocation identifier for a Xero credit-note
 * allocation. Xero does not return per-allocation IDs, so the local code
 * derives one from the credit note, invoice, and amount.
 */
export function buildSyntheticAllocationId(
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
