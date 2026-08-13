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

/**
 * Read a **date-only** value back as the calendar day it encodes.
 *
 * This is UTC truncation, so it is correct ONLY for a receiver that is already an
 * abstract calendar day pinned to UTC midnight — a `@db.Date` column, or a value
 * derived from one (INV-DATE-010).
 *
 * It is NOT correct for a real instant. Passing a `DateTime` — `createdAt`,
 * `updatedAt`, or `new Date()` — yields the UTC calendar day, which for roughly
 * the first half of every New Zealand day is the day before the club's
 * (INV-DATE-019). A calendar date derived from an instant belongs in
 * `formatDateOnlyForTimeZone` instead. #2834 tracks the sibling Xero document
 * dates in this codebase that still take an instant through here.
 */
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
 * canonical zone-aware helper rather than by truncating the instant
 * (INV-DATE-019).
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
