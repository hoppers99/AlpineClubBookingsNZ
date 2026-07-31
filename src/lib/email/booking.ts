import { loadBookingAppliedCredit } from "@/lib/booking-confirmation-credit";
import {
  appliedCreditSummaryRows,
  settledByPaymentCents,
  bookingConfirmedTemplate,
  bookingPendingTemplate,
  bookingBumpedTemplate,
  bookingGuestsCancelledTemplate,
  bookingCancelledTemplate,
  bookingReviewApprovedTemplate,
  bookingReviewRejectedTemplate,
  checkinReminderTemplate,
  bookingModifiedTemplate,
  setupIntentFailedTemplate,
  preArrivalReminderTemplate,
  additionalPaymentReminderTemplate,
  splitGuestPortionCancelledTemplate,
  promoAdjustmentSummaryRows,
  resolvePromoAdjustmentCents,
  bookingModificationTypeLabel,
  bookingModificationSummaryRows,
} from "../email-templates";
import {
  composeChoreLine,
  composeOptionalEmailLine,
  splitGuestPortionOwnBookingLine,
} from "../email-message-notes";
import { CLUB_NAME } from "@/config/club-identity";
import { EMAIL_DEFAULT_LODGE_NAME } from "@/lib/email-message-settings";
import {
  formatNZDate,
  formatNZDateTime,
} from "../nzst-date";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { loadEmailMessageSettingsForLodge } from "@/lib/email-message-settings";
import { sendEmail } from "./core";

export async function sendBookingConfirmedEmail(
  // Booking this message belongs to (#2258). Required, and an object rather
  // than a bare string so it can never be transposed with one of the sibling
  // string arguments. Every message in this file is unambiguously
  // booking-scoped, so `"none"` is not offered here: the per-booking "No
  // emails" switch must be able to withhold all of them.
  bookingContext: { bookingId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  totalCents: number,
  options?: {
    discountCents?: number;
    promoAdjustmentCents?: number;
    promoCode?: string;
    // Booking's lodge (multi-lodge phase 8): the email carries this lodge's
    // name, travel note, and door code. Omitted/null resolves the club's
    // default lodge — including its real door code, so always thread the
    // booking's own lodgeId.
    lodgeId?: string | null;
    // Split-booking parent (#738): describes the provisional non-member child
    // whose places are charged separately around the hold deadline. Present
    // only when this confirmation is a split parent (see
    // getProvisionalNonMemberChildSummary). Read-only email content — it never
    // changes the hold/settlement decision.
    provisionalGuests?: {
      guestCount: number;
      holdUntil: Date;
    };
    // #2263: the booking is CONFIRMED but the money is NOT in — the member
    // whole-lodge approval books a PENDING Internet Banking receivable. Pass
    // this and the message states the amount OWING plus the internet-banking
    // reference instead of claiming payment was processed. `invoiceEmailed`
    // must be TRUE only when an invoice really was raised (Xero module on);
    // otherwise the copy promises the club will send one by hand.
    paymentDue?: {
      reference: string;
      invoiceEmailed: boolean;
    };
    // #2397: the booking IS settled, but for less than it is worth — an admin
    // recorded a cash / off-Xero payment and said it did not cover an
    // uncollected price increase, so the club will still ask for the rest.
    // Passing this is what stops the confirmation telling the member they paid
    // in full while the admin's own receipt says the opposite. See
    // `bookingConfirmedTemplate` for the field meanings; `paymentDue` (nothing
    // paid at all) wins if both are supplied.
    outstandingBalance?: {
      amountCents: number;
      payableOnline: boolean;
    };
  },
) {
  const settings = await loadEmailMessageSettingsForLodge(options?.lodgeId);
  // #2328: account credit spent on this booking, read from the booking's own
  // persisted ledger rows (and its Payment row, for how the rest was settled)
  // rather than threaded in by the caller — see
  // `loadBookingAppliedCredit` for why the sender owns this read. Every send
  // site calls this function after its settlement transaction has committed,
  // so what is read here is the settled truth for THIS booking at THIS moment.
  const appliedCredit = await loadBookingAppliedCredit(bookingContext.bookingId);
  // #2267: derived by the same shared helper the HTML template uses, so the
  // two paths can never disagree about what the promo did to the price.
  const promoAdjustmentCents = resolvePromoAdjustmentCents(options);
  const promoAdjustmentPrefix = promoAdjustmentCents > 0 ? "+" : "-";
  // #2267: pre-composed {{promoSummary}} block for the admin-editable body —
  // the provisionalGuestsNote precedent, built from the same rows as the HTML
  // template so both paths always tell the same money story. Each row becomes
  // a "Label: value" line WITH its own trailing newline, so the default body
  // can write "{{promoSummary}}Total Paid: {{totalPaid}}" and render a clean
  // contiguous block for a promo and no leftover blank line without one. The
  // adjustment value carries its own sign (-$12.00 discount, +$1,370.00 for a
  // price-raising FIXED_NIGHTLY/SET_PRICE promo), so the body must never
  // prefix a minus of its own.
  const promoSummary = promoAdjustmentSummaryRows(
    totalCents,
    promoAdjustmentCents,
    options?.promoCode,
  )
    .map((row) => `${row.label}: ${row.value}\n`)
    .join("");
  // #2267: pre-composed {{doorCodeNote}} line, mirroring what the HTML
  // arrival-instructions section does — the whole "Door code: 1234" line, or
  // nothing at all for a lodge with no code recorded. The default body used to
  // hardcode the "Door code: " label around the bare {{doorCode}} value, which
  // left a dangling "Door code:" line in every confirmation a club without a
  // door code sent.
  // #2268: built by the one shared composer, so this line and the identical
  // one on the pre-arrival reminder cannot drift. `trailing: ""` keeps the
  // #2267 shape — a bare line that the body surrounds with its own blank
  // lines — rather than a block that carries its own.
  const doorCodeNote = composeOptionalEmailLine(
    "Door code",
    settings.doorCode,
    { trailing: "" },
  );
  const provisionalGuests = options?.provisionalGuests;
  // Composed sentence for the {{provisionalGuestsNote}} token — the same story
  // the FILE template renders, so an operator override keeps parity. Empty when
  // this is not a split parent so the token renders nothing.
  const provisionalGuestsNote =
    provisionalGuests && provisionalGuests.guestCount > 0
      ? `Your ${provisionalGuests.guestCount} non-member guest${
          provisionalGuests.guestCount === 1 ? "" : "s"
        } ${
          provisionalGuests.guestCount === 1 ? "is" : "are"
        } held provisionally as a linked booking — no bed is reserved for them yet, and the payment above covers only your member places. If beds remain around ${formatNZDateTime(
          provisionalGuests.holdUntil,
        )}, we'll automatically take that guest portion from your saved payment method and your guests are confirmed. If we can't take payment, we'll contact you to arrange it. If the lodge fills with member bookings first, that portion is not charged and those guests are bumped.`
      : "";
  // #2263: the composed unpaid-confirmation sentence, byte-identical to the one
  // the FILE template renders, so an operator override keeps parity (the same
  // convention provisionalGuestsNote follows). Empty when the booking is paid.
  const paymentDue = options?.paymentDue;
  const paymentDueNote = paymentDue
    ? `This booking is confirmed, but payment of ${formatMoneyCents(totalCents)} is still owing. Please pay by internet banking quoting reference ${paymentDue.reference}.` +
      (paymentDue.invoiceEmailed
        ? " An invoice has been emailed to you separately."
        : " The club will send you an invoice for it.")
    : "";
  // #2263 × #2267: the whole money outcome as ONE pre-composed block for the
  // default body ({{promoSummary}}'s convention — complete lines or nothing),
  // because the paid and unpaid stories are mutually exclusive and a flat body
  // cannot branch. Paid: the total-paid line plus the processed sentence.
  // Unpaid (a member whole-lodge approval's PENDING internet-banking
  // receivable): the total-due line plus the owing sentence above — never
  // "Payment has been processed successfully" for money that has not moved.
  // The legacy per-piece tokens (totalPaid, totalDue, paymentDueNote,
  // paymentReference) stay supplied for overrides that build their own lines.
  // #2397: the third money outcome — settled, but for LESS than the booking is
  // worth. Same convention again: complete lines, then the composed sentence,
  // byte-identical to what the FILE template renders.
  const outstandingBalance = paymentDue ? undefined : options?.outstandingBalance;
  const outstandingPaidCents = outstandingBalance
    ? totalCents - outstandingBalance.amountCents
    : 0;
  const outstandingBalanceNote = outstandingBalance
    ? `Your payment of ${formatMoneyCents(outstandingPaidCents)} has been recorded and your booking is confirmed. ${formatMoneyCents(outstandingBalance.amountCents)} is still owing from a later change to this booking.` +
      (outstandingBalance.payableOnline
        ? " You can pay it from your booking page."
        : " The club will be in touch to arrange it.")
    : "";
  // #2328: the pre-composed {{creditNote}} block — the two reconciling lines
  // that say where the money came from when part of it came from the member's
  // account credit, or NOTHING AT ALL when it did not. Built from the SAME
  // shared rows the HTML confirmation's info table uses, so the two paths tell
  // one story about one booking. Each row carries its own trailing newline
  // (the {{promoSummary}} convention), so the block sits hard against the
  // "Total Paid" line above it and leaves no blank line behind when empty —
  // which is what keeps every no-credit confirmation byte-for-byte unchanged.
  // The credit value carries its own minus sign, so a body must never prefix
  // one of its own (the editor rejects that at save time).
  const creditNote = appliedCreditSummaryRows(
    appliedCredit.amountCents,
    settledByPaymentCents({
      totalCents,
      appliedCreditCents: Math.max(0, appliedCredit.amountCents),
      unpaid: Boolean(paymentDue),
      outstandingCents: outstandingBalance?.amountCents ?? 0,
    }),
    appliedCredit.settlementMethod,
  )
    .map((row) => `${row.label}: ${row.value}\n`)
    .join("");
  const paymentOutcome = paymentDue
    ? `Total Due: ${formatMoneyCents(totalCents)}\n\n${paymentDueNote}`
    : outstandingBalance
      ? `Booking Total: ${formatMoneyCents(totalCents)}\nPaid: ${formatMoneyCents(outstandingPaidCents)}\n${creditNote}Still Owing: ${formatMoneyCents(outstandingBalance.amountCents)}\n\n${outstandingBalanceNote}`
      : `Total Paid: ${formatMoneyCents(totalCents)}\n${creditNote}\nPayment has been processed successfully.`;
  // #2262: the outcome is RETURNED so a caller that promised the admin a
  // receipt can report honestly what became of it (queued vs withheld vs
  // failed) instead of turning a decision into a delivery claim. Existing
  // callers ignore it and are unaffected.
  return await sendEmail({
    to: email,
    subject: `Booking Confirmed - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingConfirmedTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      totalCents,
      {
        ...options,
        lodgeTravelNote: settings.lodgeTravelNote,
        doorCode: settings.doorCode,
        provisionalGuests,
        // #2328: the same figures the {{creditNote}} token above is built from,
        // handed to the hand-built HTML so both render the shared rows.
        appliedCredit,
      },
    ),
    bookingContext,
    templateName: "booking-confirmed",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      provisionalGuestsNote,
      promoSummary,
      // Legacy per-piece promo tokens, kept supplied so a saved override that
      // still references them keeps rendering (#2267). New bodies should use
      // {{promoSummary}}: {{discount}} can only express a price cut (it is
      // empty for a price-raising promo), which is exactly the bug that
      // produced a dangling "Discount: -" line on surcharge promos.
      subtotal:
        promoAdjustmentCents !== 0
          ? formatMoneyCents(totalCents - promoAdjustmentCents)
          : "",
      promoCode: options?.promoCode ?? "",
      discount:
        promoAdjustmentCents < 0
          ? formatMoneyCents(Math.abs(promoAdjustmentCents))
          : "",
      promoAdjustment:
        promoAdjustmentCents !== 0
          ? `${promoAdjustmentPrefix}${formatMoneyCents(Math.abs(promoAdjustmentCents))}`
          : "",
      // An unpaid confirmation must not render a "Total Paid" line at all
      // (#2263). #2397 adds the third case: a PARTLY paid confirmation carries
      // BOTH, because both are true — {{totalPaid}} is what the club actually
      // has (cash plus any credit applied) and {{totalDue}} is what is still
      // owed, never the whole price.
      totalPaid: paymentDue
        ? ""
        : formatMoneyCents(
            outstandingBalance ? outstandingPaidCents : totalCents,
          ),
      totalDue: paymentDue
        ? formatMoneyCents(totalCents)
        : outstandingBalance
          ? formatMoneyCents(outstandingBalance.amountCents)
          : "",
      total: formatMoneyCents(totalCents),
      // #2328: pre-composed and ALREADY INSIDE {{paymentOutcome}} above, which
      // is what the shipped default body renders. It is supplied separately for
      // the same reason {{totalPaid}} is: an override that builds its own money
      // lines out of the per-piece tokens has no other way to explain a card
      // charge that is smaller than the total. A body that uses both renders the
      // pair twice — exactly as one using {{paymentOutcome}} and {{totalPaid}}
      // together renders the total twice.
      creditNote,
      paymentOutcome,
      paymentDueNote,
      paymentReference: paymentDue?.reference ?? "",
      doorCodeNote,
      // Legacy bare value, still supplied so an existing override that writes
      // its own "Door code: {{doorCode}}" line keeps rendering (#2267).
      doorCode: settings.doorCode ?? "",
    },
    lodgeId: options?.lodgeId,
  });
}

export async function sendBookingPendingEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  holdUntil: Date,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Pending - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingPendingTemplate(
      firstName,
      checkIn,
      checkOut,
      guestCount,
      holdUntil,
    ),
    bookingContext,
    templateName: "booking-pending",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
      holdUntil: formatNZDateTime(holdUntil),
    },
    lodgeId,
  });
}

export async function sendBookingBumpedEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Update - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingBumpedTemplate(firstName, checkIn, checkOut, guestCount),
    bookingContext,
    templateName: "booking-bumped",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount,
    },
    lodgeId,
  });
}

export async function sendBookingGuestsCancelledEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Cancelled - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingGuestsCancelledTemplate(firstName, checkIn, checkOut),
    bookingContext,
    templateName: "booking-guests-cancelled",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
    },
    lodgeId,
  });
}

export async function sendBookingCancelledEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  refundCents: number,
  // B5 (#2262): "manual" — a cash / off-Xero settlement handed back by a person.
  refundMethod: "card" | "credit" | "manual" = "card",
  creditRestoredCents: number = 0,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  await sendEmail({
    to: email,
    subject: `Booking Cancelled - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingCancelledTemplate(
      firstName,
      checkIn,
      checkOut,
      refundCents,
      refundMethod,
      creditRestoredCents,
    ),
    bookingContext,
    templateName: "booking-cancelled",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      refundAmount: formatMoneyCents(refundCents),
      refundMessage:
        refundCents > 0 && refundMethod === "manual"
          ? `You paid for this booking in cash or by bank transfer, so there is no card payment to reverse. The club will arrange your refund of ${formatMoneyCents(refundCents)} directly and will be in touch.`
          : refundCents > 0 && refundMethod === "credit"
            ? `A credit of ${formatMoneyCents(refundCents)} has been added to your account for future bookings.`
            : refundCents > 0
              ? `A refund of ${formatMoneyCents(refundCents)} has been processed to your original payment method.`
              : "No refund was applicable based on the cancellation policy.",
      // #1164 / D7: applied account credit is restored subject to the same
      // cancellation policy as the card slice. Empty when nothing was restored
      // so the override body renders no line (mirrors the refundMessage token).
      creditRestored: formatMoneyCents(creditRestoredCents),
      creditRestoredMessage:
        creditRestoredCents > 0
          ? `${formatMoneyCents(creditRestoredCents)} of previously applied account credit has been restored to your account (per the cancellation policy).`
          : "",
    },
    lodgeId,
  });
}

/**
 * #1993 Part A: member notice that the provisional non-member guest portion of
 * their stay was auto-cancelled because it stayed unpaid up to the check-in day.
 * Replaces the misleading generic booking-cancelled email on the terminal path:
 * nothing was ever charged for the guest portion, and their own linked booking
 * is untouched. `parentConfirmed` selects the reassurance wording (see the
 * template); `parentBookingReference` is shown when cheaply available.
 */
export async function sendSplitGuestPortionCancelledEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  parentConfirmed: boolean;
  parentBookingReference?: string | null;
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your guests' provisional place was cancelled — ${CLUB_NAME}`,
    html: splitGuestPortionCancelledTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      parentConfirmed: params.parentConfirmed,
      parentBookingReference: params.parentBookingReference ?? null,
    }),
    bookingContext: { bookingId: params.bookingId },
    templateName: "split-guest-portion-cancelled",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      bookingReference: params.parentBookingReference ?? "",
      // #2268: pre-composed optional line — a member whose own booking
      // reference is not cheaply available must not read a dangling
      // "Your booking reference:".
      bookingReferenceNote: composeOptionalEmailLine(
        "Your booking reference",
        params.parentBookingReference,
        { trailing: "\n" },
      ),
      // #2268: the reassurance sentence about the member's OWN booking, built
      // from the same helper as the hand-built HTML. The flat body used to
      // promise "unaffected and remains confirmed" unconditionally, which is
      // false when the parent booking is not settled.
      ownBookingNote: splitGuestPortionOwnBookingLine(params.parentConfirmed),
    },
    lodgeId: params.lodgeId,
  });
}

export async function sendBookingReviewApprovedEmail(params: {
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  adminNotes: string;
  bookingId: string;
  // Booking's lodge (multi-lodge phase 8); omitted/null resolves the
  // default lodge identity — always thread the booking's own lodgeId.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your booking has been approved - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingReviewApprovedTemplate(
      params.firstName,
      params.checkIn,
      params.checkOut,
      params.adminNotes,
      params.bookingId,
    ),
    bookingContext: { bookingId: params.bookingId },
    templateName: "booking-review-approved",
    lodgeId: params.lodgeId,
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      adminNotes: params.adminNotes,
      // #2268: pre-composed optional line — an approval with no admin note
      // must not print a bare "Note from admin:".
      adminNotesLine: composeOptionalEmailLine(
        "Note from admin",
        params.adminNotes,
      ),
      bookingId: params.bookingId,
    },
  });
}

export async function sendBookingReviewRejectedEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  adminNotes: string;
  // Booking's lodge (multi-lodge phase 8); omitted/null resolves the
  // default lodge identity — always thread the booking's own lodgeId.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your booking could not be approved - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingReviewRejectedTemplate(
      params.firstName,
      params.checkIn,
      params.checkOut,
      params.adminNotes,
    ),
    bookingContext: { bookingId: params.bookingId },
    templateName: "booking-review-rejected",
    lodgeId: params.lodgeId,
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      adminNotes: params.adminNotes,
      // #2268: pre-composed optional line — see sendBookingReviewApprovedEmail.
      adminNotesLine: composeOptionalEmailLine(
        "Reason from admin",
        params.adminNotes,
      ),
    },
  });
}

// N-01: Check-in reminder
export async function sendCheckinReminderEmail(
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingContext: { bookingId: string },
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guests: Array<{ firstName: string; lastName: string }>,
  chores: Array<{ name: string; description: string | null }>,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  // One "First Last" per line — see the token comments below for why the same
  // string is handed to three tokens.
  const guestList = guests
    .map((guest) => `${guest.firstName} ${guest.lastName}`.trim())
    .join("\n");

  await sendEmail({
    to: email,
    subject: `Check-in Reminder - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: checkinReminderTemplate(firstName, checkIn, checkOut, guests, chores),
    bookingContext,
    templateName: "checkin-reminder",
    templateData: {
      firstName,
      checkIn: formatNZDate(checkIn),
      checkOut: formatNZDate(checkOut),
      guestCount: guests.length,
      // #2307: the audited/overridable body renders one guest per line. This
      // used to supply every FIRST name comma-joined into {{guestFirstName}} and
      // every LAST name comma-joined into {{guestLastName}} on one line, so a
      // three-guest booking read "Ada, Bob, Cleo Lovelace, Smith, Jones" — each
      // guest's surname attached to somebody else. One newline-joined
      // "First Last" per guest is what the HTML template has always rendered as
      // a <li> list, so the audit trail and the delivered mail now agree.
      guestName: guestList,
      // BACK-COMPATIBILITY for a club that SAVED an override of this body before
      // the fix above. Their stored text still says
      // "{{guestFirstName}} {{guestLastName}}", and a token nobody supplies
      // renders as an empty string — so dropping the pair outright would have
      // sent those clubs a reminder that names NOBODY, which is worse than the
      // bug it replaced.
      //
      // THE MAPPING, and why it is this one. {{guestFirstName}} carries the same
      // full "First Last" per-guest list as {{guestName}}, and
      // {{guestLastName}} is deliberately empty:
      //   - the saved pair "{{guestFirstName}} {{guestLastName}}" renders the
      //     correct one-guest-per-line list, with the literal space between the
      //     two tokens left trailing at the end of the last line — invisible,
      //     because plainTextEmailTemplate trims every blank-line-separated
      //     block, and because an empty guest list makes the whole block trim to
      //     nothing and drop out rather than leaving a stray blank line;
      //   - a body using {{guestFirstName}} alone still names everybody;
      //   - a body using {{guestLastName}} alone renders nothing. Surnames on
      //     their own cannot be shown truthfully — a bare list of surnames is
      //     how the original bug misattributed them — so this shows nobody
      //     rather than somebody wrong.
      // What it can NEVER do, which was the whole point of the fix, is put one
      // guest's surname next to another guest's first name.
      guestFirstName: guestList,
      guestLastName: "",
      choreName: chores.map((chore) => chore.name).join(", "),
      choreDescription: chores
        .map((chore) => chore.description ?? "")
        .filter(Boolean)
        .join(", "),
      // #2268: the whole arrival-day chore block, pre-composed — heading and
      // all — or nothing at all. The flat body has no conditional syntax, so
      // a stay with no arrival-day chores must not print a bare
      // "Your arrival day chores:" heading over an empty list.
      choreListNote: chores.length
        ? "Your arrival day chores:\n\n" +
          chores
            .map((chore) => composeChoreLine(chore.name, chore.description))
            .join("") +
          "\n"
        : "",
    },
    lodgeId,
  });
}

export async function sendPreArrivalReminderEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expectedArrivalTime?: string | null;
  // Booking's lodge (multi-lodge phase 8): the email carries this lodge's
  // name, travel note, and door code. Omitted/null resolves the club's
  // default lodge — including its real door code, so always thread the
  // booking's own lodgeId.
  lodgeId?: string | null;
  // #2350: extra still owing on this booking after an upward change. Passed by
  // the pre-arrival cron when the delta is uncollected; zero/omitted otherwise,
  // which leaves the message byte-for-byte as it was.
  outstandingAdditionalAmountCents?: number;
}) {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);
  const outstandingAdditionalAmountCents =
    params.outstandingAdditionalAmountCents ?? 0;
  await sendEmail({
    to: params.email,
    subject: `Pre-arrival Information - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: preArrivalReminderTemplate({
      ...params,
      lodgeTravelNote: settings.lodgeTravelNote,
      doorCode: settings.doorCode,
    }),
    bookingContext: { bookingId: params.bookingId },
    templateName: "pre-arrival-reminder",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
      guestCount: params.guestCount,
      expectedArrivalTime: params.expectedArrivalTime ?? "",
      doorCode: settings.doorCode ?? "",
      // #2268: pre-composed optional lines. Both values are nullable, so the
      // flat body carries only these tokens — a stay with no expected arrival
      // time, or a lodge with no door code, prints neither a dangling
      // "Expected arrival:" nor a dangling "Door code:".
      expectedArrivalNote: composeOptionalEmailLine(
        "Expected arrival",
        params.expectedArrivalTime,
        { trailing: "\n" },
      ),
      // #2268: identical shape to the booking-confirmed line above — a bare
      // "Door code: 1234", or nothing at all for a lodge with no code.
      doorCodeNote: composeOptionalEmailLine("Door code", settings.doorCode, {
        trailing: "",
      }),
      // Pre-composed so an admin override places one block rather than having
      // to write the conditional itself (the {{doorCodeNote}} convention).
      outstandingAdditionalNote:
        outstandingAdditionalAmountCents > 0
          ? `There is still ${formatMoneyCents(outstandingAdditionalAmountCents)} to pay on this booking after a change to your stay. Please pay it from your booking page before you arrive.`
          : "",
    },
    lodgeId: params.lodgeId,
  });
}

/**
 * F-#2350: the extra owed after an upward booking change has not been paid.
 *
 * Sent automatically a few days after the change and once more shortly before
 * check-in (src/lib/cron-additional-payment-reminders.ts), and on demand by an
 * admin from the booking page. One template for all three so the member always
 * reads the same wording, and so an admin override edits one message rather than
 * three.
 */
export async function sendAdditionalPaymentReminderEmail(params: {
  bookingId: string;
  email: string;
  firstName: string;
  additionalAmountCents: number;
  checkIn: Date;
  checkOut: Date;
  requestedOn: Date;
  lodgeId?: string | null;
}) {
  // Returns the outcome rather than swallowing it (#2350): both callers write a
  // stamp BEFORE sending, and that stamp is also the 60-minute cooldown, so a
  // withheld/suppressed/placeholder send — which returns, it does not throw —
  // must not be mistaken for a delivered one.
  return sendEmail({
    to: params.email,
    subject: `Payment Still Needed - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: additionalPaymentReminderTemplate(params),
    bookingContext: { bookingId: params.bookingId },
    templateName: "additional-payment-reminder",
    templateData: {
      firstName: params.firstName,
      additionalAmount: formatMoneyCents(params.additionalAmountCents),
      requestedOn: formatNZDate(params.requestedOn),
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
    },
    lodgeId: params.lodgeId,
  });
}

// EML-01: Booking modified email
export async function sendBookingModifiedEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  email: string;
  firstName: string;
  modificationType: string;
  oldCheckIn: Date;
  oldCheckOut: Date;
  newCheckIn: Date;
  newCheckOut: Date;
  oldGuestCount: number;
  newGuestCount: number;
  oldFinalPriceCents: number;
  newFinalPriceCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  accountCreditAmountCents?: number;
  additionalAmountCents: number;
  additionalPaymentMethod?: "STRIPE" | "INTERNET_BANKING";
  paymentReference?: string | null;
  xeroInvoiceNumber?: string | null;
  // #2390: the plain-English sentence about who a capped promotion still covers
  // after this edit. Flows into the shared change rows, so the HTML email, the
  // admin-editable body, the edit preview and the booking's own history all
  // carry the identical wording.
  promoCoverageNote?: string | null;
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  const accountCreditAmountCents = params.accountCreditAmountCents ?? 0;
  // #2267: pre-composed {{changeSummary}} block for the admin-editable body,
  // built from the same rows as the HTML template — only what actually changed
  // is shown as a Previous/New pair, and a change fee only when one was
  // charged. Each row carries its own trailing newline (the {{promoSummary}}
  // precedent) so the default body can place it as a single block.
  const changeSummary = bookingModificationSummaryRows(params)
    .map((row) => `${row.label}: ${row.value}\n`)
    .join("");
  const xeroInvoicePaymentContext = params.xeroInvoiceNumber
    ? ` Xero invoice ${params.xeroInvoiceNumber} will be used for payment.`
    : " A Xero invoice and payment reference will be used for payment.";
  const paymentReferenceContext = params.paymentReference
    ? ` Payment reference: ${params.paymentReference}.`
    : "";
  const paymentNote =
    params.refundAmountCents > 0
      ? `A refund of ${formatMoneyCents(params.refundAmountCents)} has been processed to your original payment method.`
      : accountCreditAmountCents > 0
        ? `Account credit of ${formatMoneyCents(accountCreditAmountCents)} has been added for future bookings.`
        : params.additionalAmountCents > 0
          ? params.additionalPaymentMethod === "INTERNET_BANKING"
            ? `An additional Internet Banking payment of ${formatMoneyCents(params.additionalAmountCents)} is required.${xeroInvoicePaymentContext}${paymentReferenceContext} Xero reconciliation confirms the payment before it is treated as paid.`
            : `An additional payment of ${formatMoneyCents(params.additionalAmountCents)} is required.`
          : "";

  await sendEmail({
    to: params.email,
    subject: `Booking Modified - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: bookingModifiedTemplate(params),
    bookingContext: { bookingId: params.bookingId },
    templateName: "booking-modified",
    templateData: {
      firstName: params.firstName,
      // #2267: the same wording the HTML path shows — not the raw enum word an
      // override-using club used to email members.
      modificationTypeLabel: bookingModificationTypeLabel(
        params.modificationType,
      ),
      changeSummary,
      // Legacy per-piece change tokens, still supplied so an override saved
      // before {{changeSummary}} existed keeps rendering (#2267). They cannot
      // express "only show what changed", which is why the default body no
      // longer builds its rows out of them.
      oldCheckIn: formatNZDate(params.oldCheckIn),
      oldCheckOut: formatNZDate(params.oldCheckOut),
      newCheckIn: formatNZDate(params.newCheckIn),
      newCheckOut: formatNZDate(params.newCheckOut),
      oldGuestCount: params.oldGuestCount,
      newGuestCount: params.newGuestCount,
      oldTotal: formatMoneyCents(params.oldFinalPriceCents),
      newTotal: formatMoneyCents(params.newFinalPriceCents),
      changeFee: formatMoneyCents(params.changeFeeCents),
      refundAmount: formatMoneyCents(params.refundAmountCents),
      accountCreditAmount: formatMoneyCents(accountCreditAmountCents),
      additionalAmount: formatMoneyCents(params.additionalAmountCents),
      additionalPaymentMethod: params.additionalPaymentMethod ?? "",
      paymentReference: params.paymentReference ?? "",
      xeroInvoiceNumber: params.xeroInvoiceNumber ?? "",
      paymentNote,
    },
    lodgeId: params.lodgeId,
  });
}

export async function sendSetupIntentFailedEmail(params: {
  // Booking this message belongs to (#2258); see sendBookingConfirmedEmail.
  bookingId: string;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Card Setup Failed - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: setupIntentFailedTemplate(params),
    bookingContext: { bookingId: params.bookingId },
    templateName: "setup-intent-failed",
    templateData: {
      firstName: params.firstName,
      checkIn: formatNZDate(params.checkIn),
      checkOut: formatNZDate(params.checkOut),
    },
    lodgeId: params.lodgeId,
  });
}
