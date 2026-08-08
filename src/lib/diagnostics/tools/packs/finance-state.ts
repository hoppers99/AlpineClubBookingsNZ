/**
 * AI Diagnostics — AID-6C finance pack, part 4: THE AUTHORITATIVE BOOKING-FINANCE
 * STATE ENTRY (#2377, epic #2369).
 *
 * ONE entry, and it is the one an operator should reach for first when the
 * question is "what is actually wrong with this booking's money".
 *
 *   diagnostics.booking_finance_state   finance + bookings
 *
 * PERMISSION: BOTH areas, AND-ed, re-read from the database on every invocation.
 * This entry combines finance evidence (amounts, refunds, Xero state) with
 * booking evidence (the booking's own status and price), which is exactly the
 * combination the epic says requires every relevant area. A Finance Officer
 * without `bookings:view` is denied it and told which area is missing; they can
 * still use every other entry in the pack, which needs `finance:view` alone.
 *
 * WHAT MAKES THIS ENTRY DIFFERENT FROM THE OTHER NINE. The rest of the pack
 * returns STORED ROWS. This one returns the application's OWN AUTHORITATIVE
 * ANSWER: the same credit ledger, the same captured-payment test, the same
 * refundable calculation, the same display label, the same settlement kind and
 * the same Xero classification that Admin > Payments renders. #2375 forbids a
 * second definition of a number an admin screen already owns, and #2377 says the
 * same about finance state in as many words — so this entry reads
 * `readBookingFinanceStateEvidence` (`finance-evidence.ts`) rather than
 * re-deriving anything in SQL.
 *
 * THE TWO VARIANCE FIELDS ARE THE POINT OF THE TOOL. `ledgerVarianceCents` and
 * `creditLedgerVarianceCents` are signed integer-cent differences that are ZERO on
 * a healthy booking. A non-zero value means the platform's own stored figures
 * disagree with each other — the write-time identity
 * `amountCents + creditAppliedCents + uncollectedAdditionalCents = finalPriceCents`
 * has been broken, or the denormalised applied-credit column has drifted from the
 * `MemberCredit` ledger. Nothing else in this platform surfaces either
 * discrepancy, and neither is visible by reading any single screen.
 *
 * READ ONLY. It computes; it never writes, never calls a provider, and its
 * `blockerCodes` are a diagnosis, never an action taken.
 */

import "server-only";

import { z } from "zod";

import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "../define";
import {
  FINANCE_BLOCKER_CODES,
  readBookingFinanceStateEvidence,
} from "./finance-evidence";
import {
  FINANCE_DESCRIPTION_TAIL,
  FINANCE_SINGLE_ROW_BYTE_LIMIT,
  RECORD_ID,
  STORED_EVIDENCE_DISCLOSURE,
  boolOf,
  centsOrZero,
  codeListOrNull,
  countOf,
  instantOrNull,
  recordRefOrNull,
  serverLabelOrNull,
  stableCodeOrNull,
} from "./finance-shared";

export const DIAGNOSTICS_BOOKING_FINANCE_STATE_TOOL_ID =
  "diagnostics.booking_finance_state";

const bookingFinanceArgsSchema = z.object({ bookingId: RECORD_ID }).strict();
type BookingFinanceArgs = z.infer<typeof bookingFinanceArgsSchema>;

/**
 * The operator-facing description of every blocker code, kept beside the entry so
 * the words the model reads and the words a UI renders come from one place.
 *
 * Exported because AID-7 (#2378) needs it to render a case, and because a test
 * pins that every declared code has a sentence — a code with no sentence is a
 * code a model will paraphrase, and a paraphrased blocker is how "a refund is
 * queued" becomes "a refund has been issued".
 */
export const FINANCE_BLOCKER_DESCRIPTIONS: Record<
  (typeof FINANCE_BLOCKER_CODES)[number],
  string
> = {
  payment_record_missing:
    "This booking has no payment record at all, so nothing can settle against it.",
  refund_execution_exhausted:
    "A refund this platform undertook to make has failed at its retry ceiling and will NOT retry on its own. A member is owed money and only an administrator can move it.",
  refund_execution_pending:
    "A refund is queued but has not executed yet, so the money has not moved.",
  manual_refund_open:
    "Money has to be handed back by a person — this payment has no card leg to refund against.",
  refund_appeal_pending:
    "A member has asked for a refund and nobody has decided yet.",
  xero_operation_failed:
    "A Xero sync for this booking or payment failed, so Xero does not have what this platform thinks it sent.",
  xero_operation_partial:
    "A Xero sync for this booking or payment only partly completed.",
  xero_operation_pending:
    "A Xero sync for this booking or payment is still queued or running.",
  xero_invoice_missing:
    "This booking has reached a status where an invoice is expected, and no Xero invoice is linked to it.",
  additional_payment_outstanding:
    "An upward change to this booking was never collected, so part of the price is still owing.",
  payment_failed: "The payment attempt failed at the provider.",
  payment_processing:
    "A charge is in flight and unconfirmed, so it is not yet money.",
  payment_pending: "No charge has been attempted or captured yet.",
  ledger_variance:
    "The stored figures do not add up: the charged amount plus applied credit plus any uncollected additional payment does not equal the booking's final price. One of the stored numbers is wrong.",
  credit_ledger_variance:
    "The credit recorded on the payment disagrees with the member credit ledger. One of the two is wrong and a person has to decide which.",
};

const bookingFinanceState = defineDiagnosticsTool<BookingFinanceArgs>({
  id: DIAGNOSTICS_BOOKING_FINANCE_STATE_TOOL_ID,
  source: "server_owned",
  label: "Authoritative booking finance state",
  description: `Returns this platform's OWN authoritative answer for ONE booking's money — the same figures and classifications Admin > Payments shows, not a second calculation. It gives the amount due, the account credit applied (from the credit LEDGER, not the copy stored on the payment), the amount actually captured, the amount refunded, what is outstanding, any uncollected additional payment, how much is still refundable, the member's credit balance, the payment display status, the settlement kind, the Xero state, and stable blocker codes in the order they should be acted on. Two fields are signed variances that are ZERO on a healthy booking: ledgerVarianceCents (the stored amounts do not add up to the final price) and creditLedgerVarianceCents (the payment's credit column disagrees with the credit ledger). A non-zero variance is a real discrepancy no screen surfaces. Needs BOTH finance and bookings access. All amounts are integer cents. ${FINANCE_DESCRIPTION_TAIL}`,
  requiredAreas: ["finance", "bookings"],
  evidenceScope: `The authoritative finance state of ONE booking, computed by the same code the admin payments screen uses. blockerCodes is in PRIORITY order — report the first one as the primary problem, and mention the rest as also true. "none" means nothing is blocking. It covers the booking's OWN payment only: a group booking settled by an organiser, a membership subscription charge and an entrance-fee invoice are separate records this tool does not read. ${STORED_EVIDENCE_DISCLOSURE}`,
  argsSchema: bookingFinanceArgsSchema,
  inputSchema: {
    type: "object",
    properties: {
      bookingId: {
        type: "string",
        description:
          "The EXACT booking record id, as returned by diagnostics.finance_payment_search. Not the eight-character booking reference.",
      },
    },
    required: ["bookingId"],
    additionalProperties: false,
  },
  readEvidence: (args) =>
    readBookingFinanceStateEvidence({ bookingId: args.bookingId }),
  project: (row) => ({
    bookingId: recordRefOrNull(row.booking_id) ?? "",
    bookingReference: recordRefOrNull(row.booking_reference) ?? "",
    bookingStatus: stableCodeOrNull(row.booking_status),
    paymentRef: recordRefOrNull(row.payment_ref),
    paymentStatus: stableCodeOrNull(row.payment_status),
    paymentSource: stableCodeOrNull(row.payment_source),
    // A server-owned label from a closed set in `payment-status-display.ts`; it
    // carries spaces and a `+`, so it is not a code and is not validated as one.
    paymentDisplayLabel: serverLabelOrNull(row.payment_display_label) ?? "unknown",
    settlementKind: stableCodeOrNull(row.settlement_kind),
    xeroState: stableCodeOrNull(row.xero_state),
    amountDueCents: centsOrZero(row.amount_due_cents),
    creditAppliedCents: centsOrZero(row.credit_applied_cents),
    amountPaidCents: centsOrZero(row.amount_paid_cents),
    refundedAmountCents: centsOrZero(row.refunded_amount_cents),
    outstandingCents: centsOrZero(row.outstanding_cents),
    uncollectedAdditionalCents: centsOrZero(row.uncollected_additional_cents),
    remainingRefundableCents: centsOrZero(row.remaining_refundable_cents),
    ledgerVarianceCents: centsOrZero(row.ledger_variance_cents),
    creditLedgerVarianceCents: centsOrZero(row.credit_ledger_variance_cents),
    memberCreditBalanceCents: centsOrZero(row.member_credit_balance_cents),
    // Comma-joined, priority-ordered, from a closed server-owned catalogue. It is
    // not validated as a single code because it is a LIST of them.
    blockerCodes: codeListOrNull(row.blocker_codes) ?? "none",
    blockerCount: countOf(row.blocker_count),
    manuallyMarkedPaid: boolOf(row.manually_marked_paid),
    observedAtUtc: instantOrNull(row.observed_at_utc) ?? "",
  }),
  rowLimit: 1,
  byteLimit: FINANCE_SINGLE_ROW_BYTE_LIMIT,
  // No name, no email, no member id — but a booking reference plus a credit
  // balance is per-person financial information, and ADR-004's opt-in applies.
  surfacesPersonalData: true,
});

/** The AID-6C authoritative half. */
export const DIAGNOSTICS_FINANCE_STATE_TOOLS: readonly DiagnosticsToolEntry[] = [
  bookingFinanceState,
];
