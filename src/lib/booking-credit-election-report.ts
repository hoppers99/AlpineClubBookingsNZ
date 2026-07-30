import { createAuditLog } from "@/lib/audit";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { UNAPPLIED_CREDIT_ELECTION_AUDIT_ACTION } from "@/lib/booking-credit-election";
import { formatCents } from "@/lib/utils";

/**
 * Reporting for a stored credit election (#2265) that a settlement had to CLEAR
 * because it could no longer be honoured (#2319 doors 1 and 2).
 *
 * Deliberately a module of its own, and deliberately not part of
 * `booking-credit-election.ts`. That module is pure database work — a guarded
 * claim, a ledger write, some integer arithmetic — and its test suite drives it
 * against an in-memory ledger with nothing mocked. Pulling an SES send and an
 * audit write in there would make every one of those cases carry provider mocks
 * for a code path they do not exercise. Here instead, imported by the three
 * settlement writers that can clear an election.
 *
 * Why report at all. A cleared column is invisible. Without this, a member who
 * chose to spend $80 of account credit and then paid the full price would have
 * no way to tell which of two very different things had happened: their credit
 * was spent (and the club owes them a smaller bill) or their credit was never
 * touched (and they still hold all of it). It is the second — the balance is
 * never debited by a clear — and the honest thing is to say so where they will
 * see it, on their own booking's history, rather than leave them to work it out
 * from a balance figure.
 *
 * Best-effort by design: this runs AFTER the money has been captured and the
 * clear has committed. Neither a failed audit write nor an undeliverable email
 * may turn a settled booking's reconciliation into an error, so both are caught
 * and logged. The log line is the floor — something always records it.
 */
export async function reportUnappliedCreditElection({
  bookingId,
  memberId,
  memberFirstName,
  memberLastName,
  checkIn,
  checkOut,
  electionCents,
  paidAmountCents,
  source,
  reference,
  extraDetails = {},
}: {
  bookingId: string;
  memberId: string;
  memberFirstName: string;
  memberLastName: string;
  checkIn: Date;
  checkOut: Date;
  /** What the member had asked to apply, integer cents, as cleared. */
  electionCents: number;
  /** What was actually taken instead, integer cents (the full price). */
  paidAmountCents: number;
  /** Which settlement cleared it, for the audit trail. */
  source: "payment-reconciliation" | "payment-link" | "xero-inbound-invoice";
  /**
   * What to show in the operator alert's reference slot — the Stripe intent id,
   * the Xero invoice id, or (when the settlement has neither) the booking id, so
   * an officer always has something to search on.
   */
  reference: string;
  /** Source-specific identifiers to carry into the audit row. */
  extraDetails?: Record<string, string | number | null>;
}): Promise<void> {
  logger.warn(
    { bookingId, creditElectionCents: electionCents, paidAmountCents, source },
    "Cleared a stored credit election on a settlement that could not honour it: the full price was already taken, so the member's balance stays whole (#2265)"
  );

  const details = {
    source,
    creditElectionCents: electionCents,
    paidAmountCents,
    ...extraDetails,
  };

  try {
    await createAuditLog({
      action: UNAPPLIED_CREDIT_ELECTION_AUDIT_ACTION,
      targetId: bookingId,
      subjectMemberId: memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "payment",
      outcome: "success",
      summary:
        "Stored credit election cleared: the booking was settled at the full price",
      details: JSON.stringify(details),
      metadata: details,
    });
  } catch (err) {
    logger.error(
      { err, bookingId, source },
      "Failed to audit a cleared credit election"
    );
  }

  await sendAdminPaymentFailureAlert({
    memberName: `${memberFirstName} ${memberLastName}`,
    checkIn,
    checkOut,
    amountCents: electionCents,
    errorMessage: `This member had asked to put ${formatCents(electionCents)} of account credit towards this booking, but it was settled at the full price of ${formatCents(paidAmountCents)} before the credit could be applied, so the saved choice has been cleared. Their account credit balance is untouched and the booking is fully settled — no money is missing and nothing was charged twice. Decide whether to refund the difference or leave the credit for their next stay.`,
    paymentIntentId: reference,
  }).catch((err) =>
    logger.error(
      { err, bookingId, source },
      "Failed to alert admins about a cleared credit election"
    )
  );
}
