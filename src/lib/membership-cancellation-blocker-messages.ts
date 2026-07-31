/**
 * Membership-cancellation approval blockers: shared shapes and the plain-English
 * wording used to explain them (#2392).
 *
 * Deliberately dependency-free — no Prisma, no Xero, no app config — because the
 * same types and sentences are used by the server (the approval refusal message
 * and its audit record) and by the admin review queue, which is a client
 * component. One source of truth means the reviewer reads on screen exactly what
 * the server would say if they pressed Approve.
 */

/** The label of the setting that turns Xero contact archiving on or off. */
export const MEMBERSHIP_CANCELLATION_ARCHIVE_SETTING_LABEL =
  '"Archive Xero contacts after cancellation approval"';

/** A future booking the member owns, or a future stay they appear on as a guest. */
export type MembershipCancellationBookingBlocker = {
  type: "owned_booking" | "guest_appearance";
  bookingId: string;
  bookingStatus: string;
  checkIn: string;
  checkOut: string;
  guestAppearanceId?: string;
};

/**
 * A Xero invoice or bill on the member's contact that still has money owing.
 *
 * `amountDueCents` is the REMAINING balance, not the invoice total: a credit
 * note that only partly offsets an invoice leaves a residual, and the residual
 * is what the accounts are still waiting for, so that is the number shown.
 */
export type MembershipCancellationUnpaidInvoiceBlocker = {
  type: "unpaid_invoice";
  invoiceId: string;
  invoiceNumber: string | null;
  /** Xero's own status word — AUTHORISED or SUBMITTED. */
  invoiceStatus: string;
  /** "receivable" = the club is owed; "payable" = the club owes this contact. */
  direction: "receivable" | "payable";
  amountDueCents: number;
  /** Xero currency code, or "UNKNOWN" when Xero did not report one. */
  currency: string;
  /** Date-only "YYYY-MM-DD", or null when the invoice carries no due date. */
  dueDate: string | null;
  xeroUrl: string | null;
};

export type MembershipCancellationInvoiceCheckUnavailableReason =
  /** Xero is not connected, or the stored authorisation no longer works. */
  | "disconnected"
  /** Xero's API limit is in force, so the check could not be run. */
  | "rate_limited"
  /** Xero could not be reached this time — a transient failure. */
  | "unavailable";

/**
 * The unpaid-invoice check could not be completed. This is a blocker in its own
 * right: approval would archive the contact in Xero, and "we could not find out"
 * is not the same answer as "nothing is owing" (#2392).
 */
export type MembershipCancellationInvoiceCheckBlocker = {
  type: "invoice_check_unavailable";
  reason: MembershipCancellationInvoiceCheckUnavailableReason;
};

export type MembershipCancellationInvoiceBlocker =
  | MembershipCancellationUnpaidInvoiceBlocker
  | MembershipCancellationInvoiceCheckBlocker;

export type MembershipCancellationBlocker =
  | MembershipCancellationBookingBlocker
  | MembershipCancellationInvoiceBlocker;

export function isBookingBlocker(
  blocker: MembershipCancellationBlocker,
): blocker is MembershipCancellationBookingBlocker {
  return blocker.type === "owned_booking" || blocker.type === "guest_appearance";
}

export function isUnpaidInvoiceBlocker(
  blocker: MembershipCancellationBlocker,
): blocker is MembershipCancellationUnpaidInvoiceBlocker {
  return blocker.type === "unpaid_invoice";
}

export function isInvoiceCheckUnavailableBlocker(
  blocker: MembershipCancellationBlocker,
): blocker is MembershipCancellationInvoiceCheckBlocker {
  return blocker.type === "invoice_check_unavailable";
}

/**
 * "NZD 120.50". Formatted from the invoice's own currency rather than the club's
 * app currency, because a Xero invoice may be raised in any currency and a
 * mislabelled amount is worse than a plain one. A currency Xero did not report
 * is left off entirely rather than guessed.
 */
export function formatBlockerAmount(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency && currency !== "UNKNOWN" ? `${currency} ${amount}` : amount;
}

/** "INV-0042" when Xero has numbered it, otherwise a short form of its id. */
export function invoiceBlockerLabel(
  blocker: MembershipCancellationUnpaidInvoiceBlocker,
): string {
  return blocker.invoiceNumber ?? `Xero invoice ${blocker.invoiceId}`;
}

function describeInvoiceCheckUnavailable(
  reason: MembershipCancellationInvoiceCheckUnavailableReason,
): string {
  switch (reason) {
    case "disconnected":
      return `Xero is not connected, so its unpaid invoices could not be checked. Reconnect Xero, or turn off ${MEMBERSHIP_CANCELLATION_ARCHIVE_SETTING_LABEL} in the Membership Cancellation settings.`;
    case "rate_limited":
      return "Xero's API limit has been reached, so its unpaid invoices could not be checked. Try again once the limit resets.";
    case "unavailable":
      return "Xero could not be reached, so its unpaid invoices could not be checked. Try again in a few minutes.";
  }
}

/**
 * One line describing a single blocker, for the review queue's list.
 *
 * `formatDate` lets the admin page render dates the club's way while the server
 * keeps the unambiguous date-only form in its refusal message and audit record.
 */
export function describeMembershipCancellationBlocker(
  blocker: MembershipCancellationBlocker,
  options: { formatDate?: (value: string) => string } = {},
): string {
  const formatDate = options.formatDate ?? ((value: string) => value.slice(0, 10));

  if (isBookingBlocker(blocker)) {
    const prefix =
      blocker.type === "owned_booking" ? "Owned booking" : "Guest appearance";
    return `${prefix} ${blocker.bookingId} (${blocker.bookingStatus}) from ${formatDate(
      blocker.checkIn,
    )} to ${formatDate(blocker.checkOut)}`;
  }

  if (isUnpaidInvoiceBlocker(blocker)) {
    const noun = blocker.direction === "payable" ? "Bill" : "Invoice";
    const due = blocker.dueDate ? `, due ${formatDate(blocker.dueDate)}` : "";
    return `${noun} ${invoiceBlockerLabel(blocker)} — ${formatBlockerAmount(
      blocker.amountDueCents,
      blocker.currency,
    )} still owing (${blocker.invoiceStatus}${due})`;
  }

  return describeInvoiceCheckUnavailable(blocker.reason);
}

const INVOICE_NAMES_IN_MESSAGE = 5;

function listInvoiceBlockers(
  blockers: readonly MembershipCancellationUnpaidInvoiceBlocker[],
): string {
  const named = blockers
    .slice(0, INVOICE_NAMES_IN_MESSAGE)
    .map(
      (blocker) =>
        `${invoiceBlockerLabel(blocker)} (${formatBlockerAmount(
          blocker.amountDueCents,
          blocker.currency,
        )})`,
    )
    .join("; ");
  const remaining = blockers.length - INVOICE_NAMES_IN_MESSAGE;
  return remaining > 0 ? `${named}; and ${remaining} more` : named;
}

/**
 * The whole refusal, in the words the approver needs: what is in the way, and
 * what to do about it. Every branch ends with a route forward — a refusal an
 * approver cannot clear is a trap, not a safeguard (#2392).
 */
export function buildMembershipCancellationApprovalBlockedMessage(
  blockers: readonly MembershipCancellationBlocker[],
): string {
  const sentences: string[] = [];

  if (blockers.some(isBookingBlocker)) {
    sentences.push(
      "Approval is blocked while this member has future bookings or guest appearances.",
    );
  }

  const invoiceBlockers = blockers.filter(isUnpaidInvoiceBlocker);
  if (invoiceBlockers.length > 0) {
    sentences.push(
      `Approval is blocked while Xero still shows money owing on this member's contact: ${listInvoiceBlockers(
        invoiceBlockers,
      )}. Approving would archive that contact in Xero, so each one must be paid, credited with an allocated credit note, or voided in Xero first — then approve again. If the club is not collecting them, void or credit them in Xero; alternatively turn off ${MEMBERSHIP_CANCELLATION_ARCHIVE_SETTING_LABEL} in the Membership Cancellation settings, which stops the archive and lifts this check.`,
    );
  }

  const unavailable = blockers.find(isInvoiceCheckUnavailableBlocker);
  if (unavailable) {
    sentences.push(
      `Approval is blocked because approving would archive this member's Xero contact and Xero could not be checked for unpaid invoices first. ${describeInvoiceCheckUnavailable(
        unavailable.reason,
      )}`,
    );
  }

  if (sentences.length === 0) {
    // Defensive: callers only build this message when something is blocking.
    return "Approval is blocked while this cancellation has unresolved blockers.";
  }

  return sentences.join(" ");
}

/** Heading for the amber panel above the blocker list in the review queue. */
export function membershipCancellationBlockerHeading(
  blockers: readonly MembershipCancellationBlocker[],
): string {
  const hasBookings = blockers.some(isBookingBlocker);
  const hasInvoices = blockers.some(isUnpaidInvoiceBlocker);

  if (hasBookings && !hasInvoices) {
    return "Resolve these bookings before approval.";
  }
  if (hasInvoices && !hasBookings) {
    return "Settle these in Xero before approval.";
  }
  if (hasInvoices && hasBookings) {
    return "Resolve these before approval.";
  }
  return "Approval cannot be checked yet.";
}

/** The "what do I do about it" line under the review queue's blocker list. */
export function membershipCancellationBlockerHint(
  blockers: readonly MembershipCancellationBlocker[],
): string | null {
  if (blockers.some(isUnpaidInvoiceBlocker)) {
    return `Approving archives this member's Xero contact, so anything still owing must be paid, credited with an allocated credit note, or voided in Xero first. If the club is not collecting it, void or credit it. Turning off ${MEMBERSHIP_CANCELLATION_ARCHIVE_SETTING_LABEL} also lifts this check, because the contact is then left alone.`;
  }
  if (blockers.some(isInvoiceCheckUnavailableBlocker)) {
    return `Approving archives this member's Xero contact, so the check has to run first. Turning off ${MEMBERSHIP_CANCELLATION_ARCHIVE_SETTING_LABEL} also lifts this check, because the contact is then left alone.`;
  }
  return null;
}
