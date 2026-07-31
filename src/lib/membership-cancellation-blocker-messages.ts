/**
 * Membership-cancellation approval blockers: shared shapes and the plain-English
 * wording used to explain them (#2392).
 *
 * Deliberately dependency-free — no Prisma, no Xero, no app config — because the
 * same types and sentences are used by the server (the approval refusal message
 * and its audit record) and by the admin review queue, which is a client
 * component. One source of truth means the reviewer reads on screen exactly what
 * the server would say if they pressed Approve.
 *
 * It also carries the shared-invoice NOTICE (#2400), which is not a blocker: it
 * does not refuse anything, it warns the reviewer that approving will raise no
 * credit note because the invoice covers other members who are staying. Same
 * reason for living here — the wording is written once and read by both sides.
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
  /**
   * Deep link straight to this invoice in Xero, or null for a bill — Xero's
   * receivable and payable views live at different paths and only the
   * receivable one is a URL this app can build with confidence.
   */
  xeroUrl: string | null;
  /**
   * Deep link to the CONTACT the invoice sits on. Always present, and it is what
   * makes a row without an invoice number usable: a treasurer cannot search Xero
   * by GUID, but the contact page lists every invoice and bill on the contact.
   */
  xeroContactUrl: string | null;
};

export type MembershipCancellationInvoiceCheckUnavailableReason =
  /** Xero is not connected, or the stored authorisation no longer works. */
  | "disconnected"
  /** Xero's API limit is in force, so the check could not be run. */
  | "rate_limited"
  /** Xero could not be reached this time — a transient failure. */
  | "unavailable"
  /**
   * Xero refused the request itself — most often because the stored contact id
   * no longer exists there (merged, or deleted). Waiting does not fix it, so it
   * must not be worded as though it will (#2392 review).
   */
  | "invalid_request"
  /**
   * The contact carries more open invoices than the paged read will list, so
   * "nothing owing" could not be established for it. Also not transient.
   */
  | "too_many_invoices";

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

/**
 * "INV-0042" when Xero has numbered it. Xero leaves the number blank on plenty
 * of bills, and a treasurer cannot search Xero by GUID, so an unnumbered one is
 * named by its full Xero id AND given a link — `xeroUrl` for a receivable,
 * `xeroContactUrl` otherwise — because the link is what actually makes that row
 * actionable (#2392 review).
 */
export function invoiceBlockerLabel(
  blocker: MembershipCancellationUnpaidInvoiceBlocker,
): string {
  return blocker.invoiceNumber ?? `(no number, Xero id ${blocker.invoiceId})`;
}

/**
 * The escape hatch, in one place. EVERY failure message ends with it: the owner's
 * worry behind this whole blocker was a cancellation held hostage, and a refusal
 * whose only advice is "try again later" is exactly that — Xero's daily limit
 * resets at midnight UTC, so "wait for the limit" can be most of a working day
 * (#2392 review, H2).
 */
const ARCHIVE_SETTING_ESCAPE_HATCH = `Alternatively, turn off ${MEMBERSHIP_CANCELLATION_ARCHIVE_SETTING_LABEL} in the Membership Cancellation settings: with it off no Xero contact is archived, so this check is not needed and the approval goes through.`;

function describeInvoiceCheckUnavailable(
  reason: MembershipCancellationInvoiceCheckUnavailableReason,
): string {
  switch (reason) {
    case "disconnected":
      return `Xero is not connected, so its unpaid invoices could not be checked. Reconnect Xero from the admin Xero page — this one will not clear on its own. ${ARCHIVE_SETTING_ESCAPE_HATCH}`;
    case "rate_limited":
      return `Xero's API limit has been reached, so its unpaid invoices could not be checked. Try again once the limit resets — Xero's daily limit resets at midnight UTC, which is about midday in New Zealand, so that can be most of a working day away. ${ARCHIVE_SETTING_ESCAPE_HATCH}`;
    case "unavailable":
      return `Xero could not be reached, so its unpaid invoices could not be checked. Try again in a few minutes. ${ARCHIVE_SETTING_ESCAPE_HATCH}`;
    case "invalid_request":
      return `Xero refused the request for this member's contact, so its unpaid invoices could not be checked. Waiting will not fix this one: the contact has most likely been merged or deleted in Xero. Re-link the member to their Xero contact from their member page. ${ARCHIVE_SETTING_ESCAPE_HATCH}`;
    case "too_many_invoices":
      return `This member's Xero contact has more open invoices than this check can list, so "nothing owing" could not be established. Waiting will not fix this one: settle or void them in Xero, starting from the contact's page. ${ARCHIVE_SETTING_ESCAPE_HATCH}`;
  }
}

type DescribeBlockerOptions = { formatDate?: (value: string) => string };

const defaultFormatDate = (value: string) => value.slice(0, 10);

/**
 * What joins an invoice line's label to its detail.
 *
 * Exported because BOTH sides of the split sentence need it: the server joins
 * `label` and `detail` with it below, and the review queue's panel renders the
 * label as a hyperlink and then emits this same separator before the detail. A
 * literal copied into the component would let the rendered line drift from the
 * refusal message with nothing failing, which is precisely the drift this module
 * exists to prevent (#2392 review, residual 2).
 */
export const MEMBERSHIP_CANCELLATION_BLOCKER_DETAIL_SEPARATOR = " — ";

/**
 * The unpaid-invoice line, split at the point a link belongs.
 *
 * The review queue renders `label` as a hyperlink to `href` and `detail` as
 * plain text, rejoining them with
 * {@link MEMBERSHIP_CANCELLATION_BLOCKER_DETAIL_SEPARATOR}; the server joins the
 * two into one sentence with the same constant. Splitting here rather than
 * rebuilding the sentence in the client is what keeps the one-source-of-truth
 * promise this module exists for — the panel and the 409 cannot drift apart
 * (#2392 review, H1).
 */
export function describeUnpaidInvoiceBlockerParts(
  blocker: MembershipCancellationUnpaidInvoiceBlocker,
  options: DescribeBlockerOptions = {},
): { label: string; detail: string; href: string | null } {
  const formatDate = options.formatDate ?? defaultFormatDate;
  const noun = blocker.direction === "payable" ? "Bill" : "Invoice";
  const due = blocker.dueDate ? `, due ${formatDate(blocker.dueDate)}` : "";

  return {
    label: `${noun} ${invoiceBlockerLabel(blocker)}`,
    detail: `${formatBlockerAmount(
      blocker.amountDueCents,
      blocker.currency,
    )} still owing (${blocker.invoiceStatus}${due})`,
    // A bill has no receivable-view URL, so it falls back to the contact page,
    // which lists it. Every row therefore leads somewhere in Xero.
    href: blocker.xeroUrl ?? blocker.xeroContactUrl,
  };
}

/**
 * One line describing a single blocker, for the review queue's list.
 *
 * `formatDate` lets the admin page render dates the club's way while the server
 * keeps the unambiguous date-only form in its refusal message and audit record.
 */
export function describeMembershipCancellationBlocker(
  blocker: MembershipCancellationBlocker,
  options: DescribeBlockerOptions = {},
): string {
  const formatDate = options.formatDate ?? defaultFormatDate;

  if (isBookingBlocker(blocker)) {
    const prefix =
      blocker.type === "owned_booking" ? "Owned booking" : "Guest appearance";
    return `${prefix} ${blocker.bookingId} (${blocker.bookingStatus}) from ${formatDate(
      blocker.checkIn,
    )} to ${formatDate(blocker.checkOut)}`;
  }

  if (isUnpaidInvoiceBlocker(blocker)) {
    const { label, detail } = describeUnpaidInvoiceBlockerParts(
      blocker,
      options,
    );
    return `${label}${MEMBERSHIP_CANCELLATION_BLOCKER_DETAIL_SEPARATOR}${detail}`;
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
      )}. Approving would archive that contact in Xero, so each one must be paid, credited with an allocated credit note, or voided in Xero first — then approve again. If the club is not collecting them, void or credit them in Xero; alternatively turn off ${MEMBERSHIP_CANCELLATION_ARCHIVE_SETTING_LABEL} in the Membership Cancellation settings, which stops the archive and lifts this check. Every one of them is listed beside this participant in the review queue, each linked into Xero.`,
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

/**
 * The member's own current-season subscription invoice, when it also covers
 * OTHER members who are staying — so the cancellation will raise no credit note
 * against it (#2400).
 *
 * Not a blocker. Nothing about it stops the approval: the invoice is simply left
 * alone, which is the right outcome when the club is still owed for the members
 * who remain. It is here so the reviewer is told BEFORE they approve, because a
 * cancellation that quietly changes — or, as it used to, quietly wipes — what a
 * different member owes deserves to be visible.
 */
export type MembershipCancellationSharedInvoiceNotice = {
  invoiceId: string;
  invoiceNumber: string | null;
  /** Deep link to the invoice in Xero. */
  xeroUrl: string;
  /** The other members this invoice still covers, named. Never empty. */
  sharedWith: Array<{ memberId: string; name: string }>;
};

/** Members named in the notice before it summarises the rest. */
const SHARED_INVOICE_NAMES_IN_MESSAGE = 5;

/** "Ana", "Ana and Bo", "Ana, Bo and Cy", "Ana, Bo, Cy, Di, Ed and 2 others". */
export function formatMemberNameList(names: readonly string[]): string {
  const named = names.slice(0, SHARED_INVOICE_NAMES_IN_MESSAGE);
  const remaining = names.length - named.length;
  const tail =
    remaining > 0 ? `${remaining} other${remaining === 1 ? "" : "s"}` : null;
  const parts = tail ? [...named, tail] : named;

  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "invoice INV-0042" — or its Xero id where Xero never numbered it, because a
 * treasurer cannot search Xero by GUID and the link is what makes it findable.
 */
export function sharedInvoiceLabel(
  notice: MembershipCancellationSharedInvoiceNotice,
): string {
  return notice.invoiceNumber
    ? `invoice ${notice.invoiceNumber}`
    : `an invoice with no number (Xero id ${notice.invoiceId})`;
}

/**
 * The whole explanation, split where the invoice link belongs — the same
 * label/detail shape the unpaid-invoice line uses, and for the same reason: the
 * panel hyperlinks the label and the server logs one sentence, and neither can
 * drift from the other.
 */
export function describeMembershipCancellationSharedInvoiceParts(
  notice: MembershipCancellationSharedInvoiceNotice,
): { before: string; label: string; href: string; after: string } {
  const names = formatMemberNameList(
    notice.sharedWith.map((member) => member.name),
  );

  return {
    before: "This member's membership was billed on ",
    label: sharedInvoiceLabel(notice),
    href: notice.xeroUrl,
    after: `, which also covers ${names}. They are staying, so approving raises no Xero credit note: crediting this invoice would wipe their share of the bill as well, and the club is still owed it. The invoice is left exactly as it is. If this member is owed something back, raise that credit note yourself in Xero. If the rest of the family is leaving too, approve them first — the last cancellation on this invoice credits it in full.`,
  };
}

/** The same explanation as one sentence, for the server's logs and records. */
export function buildMembershipCancellationSharedInvoiceMessage(
  notice: MembershipCancellationSharedInvoiceNotice,
): string {
  const { before, label, after } =
    describeMembershipCancellationSharedInvoiceParts(notice);
  return `${before}${label}${after}`;
}

/** Heading for the amber panel above the blocker list in the review queue. */
export function membershipCancellationBlockerHeading(
  blockers: readonly MembershipCancellationBlocker[],
): string {
  const hasBookings = blockers.some(isBookingBlocker);
  const hasInvoices = blockers.some(isUnpaidInvoiceBlocker);
  // A failed check is a Xero bullet too. Heading a bookings-plus-"Xero is not
  // connected" panel "Resolve these bookings before approval." contradicts the
  // bullet directly underneath it (#2392 review, L9).
  const hasXero = hasInvoices || blockers.some(isInvoiceCheckUnavailableBlocker);

  if (hasBookings && !hasXero) {
    return "Resolve these bookings before approval.";
  }
  if (hasInvoices && !hasBookings) {
    return "Settle these in Xero before approval.";
  }
  if (hasBookings || hasInvoices) {
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
