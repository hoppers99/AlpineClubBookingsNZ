import {
  evaluateGuestSelfRemoval,
  type GuestSelfRemovalBlocker,
} from "@/lib/booking-guest-self-removal";
import { addDaysDateOnly } from "@/lib/date-only";
import { escapeHtml } from "@/lib/email-templates";
import { formatNZDate } from "@/lib/nzst-date";
import { formatCents } from "@/lib/utils";

/**
 * The composed sentences and blocks the four member-guest emails are built from
 * (epic #2305, MG2 #2307).
 *
 * WHY THIS MODULE EXISTS AT ALL. `renderTemplateString` is a flat regex
 * substitution with no syntax of its own — no conditional, no loop, no section.
 * So every value that can be absent, vary by case, or repeat has to arrive as
 * ONE pre-composed token that the server built: the default body carries the
 * token alone on its own line and the sender emits either the whole block or the
 * empty string. That is the same shape `{{provisionalGuestsNote}}`
 * (booking-confirmed) and `{{refundMessage}}` (booking-cancelled) already use.
 *
 * AND WHY THE COMPOSERS ARE HERE RATHER THAN IN THE SENDERS. Each of these
 * values is rendered TWICE — once as flat text for the editable default body,
 * once as HTML for the hand-built template — and the two must never drift. Both
 * renderings are produced from one call to one composer in this file, so a
 * change to the wording cannot land in one and miss the other. The party
 * listing goes furthest: `buildMemberGuestPartyList` returns the flat text and
 * the HTML `<ul>` from a single pass over a single ordered array of names, and a
 * test asserts the two list the same names in the same order.
 */

/** One person on the booking, as the party listing names them (MG2-D-a). */
export interface MemberGuestPartyMember {
  firstName: string;
  lastName: string;
}

export interface MemberGuestPartyList {
  /**
   * The `{{partyListNote}}` value: the heading and the list as plain text, or
   * the empty string when there is nobody to list.
   */
  text: string;
  /**
   * The same names, in the same order, as an already-HTML-ESCAPED heading plus
   * `<ul>`. Embed it verbatim — passing it through `escapeHtml` again would
   * print the markup to the member.
   */
  html: string;
  /** The names exactly as both renderings list them, in order. */
  names: string[];
}

/**
 * The heading lives INSIDE the token, not in the default body above it.
 *
 * If the body carried its own "Everyone on this booking" line and the token were
 * empty — a booking whose guest list could not be loaded — the member would read
 * a bare heading with nothing under it. Keeping the heading in the composed
 * block means an empty list renders as nothing at all.
 */
const PARTY_LIST_HEADING = "Everyone on this booking";

/**
 * The full party listing, names only.
 *
 * Owner decision MG2-D-a: every guest's first AND last name, and NO MONEY
 * anywhere — not a per-guest price, not a total. (An honest caveat recorded in
 * the mockup pack: under D-11 the member can open the booking page and see
 * every price there. Leaving money out of the email is a courtesy, not a
 * control.) The parameter type carries only the two name fields so a priced
 * guest row cannot be splatted in whole by accident.
 */
export function buildMemberGuestPartyList(
  party: readonly MemberGuestPartyMember[],
): MemberGuestPartyList {
  const names = party
    .map((member) => `${member.firstName} ${member.lastName}`.trim())
    .filter((name) => name.length > 0);

  if (names.length === 0) {
    return { text: "", html: "", names: [] };
  }

  // No trailing newline. The default body already sits the token between blank
  // lines, and `plainTextEmailTemplate` splits the rendered body on runs of
  // blank lines and drops empty blocks — so a trailing newline here would only
  // widen the gap, and an empty token collapses cleanly on its own.
  const text = [
    `${PARTY_LIST_HEADING}:`,
    ...names.map((name) => `- ${name}`),
  ].join("\n");

  const html = [
    `<p style="margin: 0 0 6px 0; font-size: 15px; font-weight: 700;">${escapeHtml(PARTY_LIST_HEADING)}</p>`,
    `<ul style="margin: 0 0 16px 0; padding: 0 0 0 20px; font-size: 15px; line-height: 1.6;">`,
    ...names.map((name) => `  <li>${escapeHtml(name)}</li>`),
    `</ul>`,
  ].join("\n");

  return { text, html, names };
}

/**
 * The `{{guestNightsLabel}}` value: which nights THIS guest is down for.
 *
 * Listed night by night rather than given as a range, because a member added to
 * part of somebody else's stay needs to check the actual nights, and because a
 * range would read as a check-in/check-out pair the guest row does not
 * necessarily have. A long contiguous run collapses to a range — past three
 * nights the list stops being scannable and a contiguous run loses nothing by
 * being stated as its ends.
 *
 * Dates are formatted with `formatNZDate`, the codebase's single NZ date
 * formatter, so the label reads in the same medium NZ style ("8 Aug 2026") as
 * every other date in every other email — and as the registry's own date
 * sample, so an admin previewing an override sees the real shape.
 */
export function composeGuestNightsLabel(nights: readonly Date[]): string {
  const ordered = Array.from(
    new Map(nights.map((night) => [night.getTime(), night])).values(),
  ).sort((a, b) => a.getTime() - b.getTime());

  if (ordered.length === 0) return "";

  const count = ordered.length;
  const suffix = `(${count} night${count === 1 ? "" : "s"})`;
  const contiguous = ordered.every(
    (night, index) =>
      index === 0 ||
      addDaysDateOnly(ordered[index - 1], 1).getTime() === night.getTime(),
  );

  if (count > 3 && contiguous) {
    return `${formatNZDate(ordered[0])} to ${formatNZDate(ordered[count - 1])} ${suffix}`;
  }

  return `${ordered.map((night) => formatNZDate(night)).join(", ")} ${suffix}`;
}

// ---------------------------------------------------------------------------
// member-guest-consent-request
// ---------------------------------------------------------------------------

/**
 * Who is reading the consent request.
 *
 * Owner decision D-9 makes a target with no login of their own the NORMAL case,
 * not an edge case, so the request routinely goes to a family delegate instead
 * of to the member being added. The approved copy in the mockup pack was written
 * for the direct case only ("has put YOU down as a guest"), which would tell a
 * parent they are being added to a lodge booking when it is their nine-year-old
 * who is. There is no conditional in the template language, so the two
 * recipient-relative sentences are composed here instead. The direct case is
 * word-for-word the approved copy.
 */
export type MemberGuestConsentAudience =
  /** The member being added is reading it and answers for themselves. */
  | { kind: "TARGET" }
  /** A family delegate is reading it and answers on the target's behalf (D-5/D-9). */
  | { kind: "DELEGATE"; guest: MemberGuestPartyMember };

export interface MemberGuestConsentAskCopy {
  /** `{{askHeading}}` — the first block, and therefore the email's heading. */
  heading: string;
  /** `{{askContextNote}}` — what is being asked, of whom, and why them. */
  contextNote: string;
}

export function composeMemberGuestConsentAsk(params: {
  bookerName: string;
  audience: MemberGuestConsentAudience;
}): MemberGuestConsentAskCopy {
  const { bookerName, audience } = params;

  if (audience.kind === "TARGET") {
    return {
      heading: `Can ${bookerName} add you to this booking?`,
      contextNote:
        `${bookerName} has put you down as a guest on a lodge booking. ` +
        "Nothing is settled until you answer - a bed is held for you in the meantime.",
    };
  }

  const guestName = `${audience.guest.firstName} ${audience.guest.lastName}`.trim();
  const guestFirstName = audience.guest.firstName;
  return {
    heading: `Can ${bookerName} add ${guestName} to this booking?`,
    contextNote:
      `${bookerName} has put ${guestName} down as a guest on a lodge booking. ` +
      `${guestFirstName} does not have a login of their own, so you are being asked as an ` +
      `adult in their family group — your answer counts as ${guestFirstName}'s, and your ` +
      `name is recorded against it. Nothing is settled until you answer - a bed is held ` +
      `for ${guestFirstName} in the meantime.`,
  };
}

// ---------------------------------------------------------------------------
// member-guest-added
// ---------------------------------------------------------------------------

/**
 * Why the member is on the booking without having been asked.
 *
 * ONE template covers all three, told apart by this one composed sentence, so an
 * admin editing the wording has one place to edit rather than three near-copies
 * to keep in step. MG4 reuses the template unchanged for the booking-request
 * pipeline, which is the reason it is one template and not three.
 */
export type MemberGuestAddedContext =
  /** The club runs notify-only (D-3 opt-down): told, not asked. */
  | "NOTIFY_ONLY"
  /** An admin or booking officer added them on somebody's behalf (MG4-D-a). */
  | "ADMIN"
  /** The row came from an approved public booking request (MG4-D-a). */
  | "BOOKING_REQUEST";

export function composeMemberGuestAddedContextNote(params: {
  context: MemberGuestAddedContext;
  bookerName: string;
}): string {
  const { context, bookerName } = params;
  switch (context) {
    case "NOTIFY_ONLY":
      return (
        `${bookerName} has added you as a guest on a lodge booking. Your place is ` +
        "already held — this club does not ask first for member guests."
      );
    case "ADMIN":
      return `the club has added you as a guest on a lodge booking on behalf of ${bookerName}.`;
    case "BOOKING_REQUEST":
      return (
        "the club has added you as a guest on a lodge booking created from " +
        `${bookerName}'s booking request.`
      );
  }
}

/**
 * The `{{removalNote}}` value when the member CAN take themselves off.
 *
 * Exported because it is the phrase the agreement test looks for: the note must
 * offer this exactly when `evaluateGuestSelfRemoval` says the removal would be
 * allowed, and must never offer it when it would be refused.
 */
export const MEMBER_GUEST_SELF_REMOVAL_OFFER =
  "If you would rather not go, you can take yourself off the booking from your account.";

/**
 * What to say instead, per refusal reason.
 *
 * Owner decision D-14 makes the ORDINARY self-removal blockers apply to a member
 * who never consented, so these are reached in normal operation and not only in
 * theory. Three reuse `describeGuestSelfRemovalBlocker`'s wording verbatim
 * because it already names a real remedy (cancel the booking, ask the owner or
 * the club). Two do not:
 *
 *  - QUOTE_PRICED. The shared wording ends "ask the person who made the booking,
 *    or the club, to take you off it" — but the person who made the booking
 *    CANNOT, and asking them is a dead end. The real remedy is that the club
 *    re-quotes the request, so that is what this says.
 *  - OWN_BOOKING / NOT_THEIR_OWN_GUEST. Neither is reachable from this email
 *    (the recipient is the guest named on the row, and is never the booking's
 *    owner), and the shared wording for OWN_BOOKING points at "the booking
 *    details above" — a page the reader of an email is not looking at. Rather
 *    than print a UI-relative instruction, they fall back to the honest general
 *    statement, which is true whichever of the two it was.
 *
 * A `Record` keyed by the blocker union rather than a `switch`, so adding a
 * blocker to `booking-guest-self-removal.ts` is a COMPILE error here instead of
 * a silently missing sentence.
 */
export const MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER: Record<
  GuestSelfRemovalBlocker,
  string
> = {
  BOOKING_STATUS:
    "This booking is no longer in a state you can take yourself off. Ask the person who made the booking, or the club, if you need to come off it.",
  STAY_NOT_FUTURE:
    "This stay starts today or has already started, so you can no longer take yourself off it here. Ask the person who made the booking, or the club, if your plans have changed.",
  LAST_GUEST:
    "You are the only person on this booking, so taking yourself off would leave it empty. Ask the person who made the booking, or the club, to cancel it instead.",
  QUOTE_PRICED:
    "This booking was priced by hand, so guests cannot be taken off it from your account. Only the club can take you off — it will re-quote the request.",
  OWN_BOOKING:
    "Only the club can change who is on this booking. Contact the club if you need to come off it.",
  NOT_THEIR_OWN_GUEST:
    "Only the club can change who is on this booking. Contact the club if you need to come off it.",
};

/** Everything `evaluateGuestSelfRemoval` needs, threaded from the caller. */
export type MemberGuestRemovalFacts = {
  actorMemberId: string;
  guestMemberId: string | null;
  bookingOwnerMemberId: string;
  bookingStatus: string;
  bookingCheckIn: Date;
  bookingGuestCount: number;
  isQuotePriced?: boolean;
  today?: Date;
};

/**
 * The `{{removalNote}}` value, decided by the SHARED predicate rather than by a
 * second copy of the rule.
 *
 * This calls `evaluateGuestSelfRemoval` itself instead of taking a pre-computed
 * answer, so the email cannot promise a "take yourself off" link the server
 * would refuse: there is no second decision to get wrong. A test walks the whole
 * blocker matrix and asserts the note and the predicate never disagree.
 */
export function composeMemberGuestRemovalNote(
  facts: MemberGuestRemovalFacts,
): string {
  const { canSelfRemove, blocker } = evaluateGuestSelfRemoval(facts);
  if (canSelfRemove || !blocker) return MEMBER_GUEST_SELF_REMOVAL_OFFER;
  return MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER[blocker];
}

// ---------------------------------------------------------------------------
// member-guest-consent-outcome
// ---------------------------------------------------------------------------

/**
 * What happened to the request, as the person who made the booking needs to
 * hear it.
 *
 * FOUR outcomes and ONE template, because the heading, the outcome sentence and
 * the consequence are all composed here. The fourth is the one that could have
 * been left out and must not be: owner decision D-15 lets the expiry sweep
 * settle the money as account credit so an ORDINARY paid booking always lapses
 * cleanly, but a booking that is quote-priced, has only this guest on it, is in
 * a status that forbids changes, or has already started genuinely cannot be
 * changed automatically. Those land on the admin exception list, and the owner
 * is told the real remedy instead of being left to believe the guest came off.
 */
export type MemberGuestConsentOutcome =
  /** The member (or their delegate) said yes. Nothing about the booking changes. */
  | { kind: "APPROVED" }
  /** They said no and the place was released. `creditCents` is D-15's credit. */
  | { kind: "DECLINED"; creditCents: number }
  /** The request lapsed with no answer and the place was released. */
  | { kind: "EXPIRED_REMOVED"; expiredAt: Date; creditCents: number }
  /** The request lapsed but the place could NOT be released; an admin must act. */
  | {
      kind: "EXPIRED_STILL_ON_BOOKING";
      expiredAt: Date;
      blocker: GuestSelfRemovalBlocker;
    };

export interface MemberGuestConsentOutcomeCopy {
  /** `{{outcomeHeading}}` — the first block, and therefore the email's heading. */
  heading: string;
  /** `{{outcomeSentence}}` — follows "Hi <first name>, ". */
  sentence: string;
  /** `{{consequenceNote}}` — what it means for the booking and the money. */
  consequenceNote: string;
}

/**
 * Why the guest is still on the booking, per refusal reason — the clause that
 * makes variant D honest.
 *
 * These are the only four reasons that reach the admin exception list, and they
 * are exactly the shared predicate's blockers, so they are keyed by the same
 * union: a new blocker is a compile error here rather than a missing
 * explanation. The two unreachable-from-here blockers get the general statement
 * for the same reason as in `MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER`.
 */
const STILL_ON_BOOKING_REASON_BY_BLOCKER: Record<
  GuestSelfRemovalBlocker,
  string
> = {
  QUOTE_PRICED:
    "because this booking was priced by hand and only the club can change it — the club will re-quote the request",
  LAST_GUEST:
    "because they are the only guest on it, so taking them off would leave the booking empty",
  BOOKING_STATUS:
    "because this booking is in a state the system cannot change on its own",
  STAY_NOT_FUTURE: "because the stay has already started",
  OWN_BOOKING: "because the system could not change this booking on its own",
  NOT_THEIR_OWN_GUEST:
    "because the system could not change this booking on its own",
};

/**
 * The credit sentence, and the one case where there is no credit.
 *
 * Owner decision D-15 settles the money for an expired or declined place as
 * ACCOUNT CREDIT to the booking's owner. A booking that had not been paid for
 * yet simply reprices, and saying "credit has been added" there would be a
 * false promise, so zero cents gets its own sentence rather than "$0.00".
 */
function composeRepricedConsequence(creditCents: number): string {
  if (creditCents > 0) {
    return (
      "Your booking has been repriced. " +
      `${formatCents(creditCents)} has been added to your account credit and will come ` +
      "off your next booking."
    );
  }
  return (
    "Your booking has been repriced. Nothing had been paid for that place, so there " +
    "is no credit to return."
  );
}

export function composeMemberGuestConsentOutcome(params: {
  guest: MemberGuestPartyMember;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  outcome: MemberGuestConsentOutcome;
}): MemberGuestConsentOutcomeCopy {
  const { guest, lodgeName, checkIn, checkOut, outcome } = params;
  const guestName = `${guest.firstName} ${guest.lastName}`.trim();
  const guestFirstName = guest.firstName;
  const stay = `${lodgeName}, ${formatNZDate(checkIn)} - ${formatNZDate(checkOut)}`;

  switch (outcome.kind) {
    case "APPROVED":
      return {
        heading: `${guestName} has accepted`,
        sentence: `${guestName} has accepted your invitation and is confirmed on your booking at ${stay}.`,
        consequenceNote: `Nothing has changed on your booking — the bed that was being held for ${guestFirstName} is now theirs.`,
      };
    case "DECLINED":
      return {
        heading: `${guestName} has declined`,
        sentence: `${guestName} has declined and has been taken off your booking at ${stay}.`,
        consequenceNote: composeRepricedConsequence(outcome.creditCents),
      };
    case "EXPIRED_REMOVED":
      return {
        heading: `${guestName} did not answer in time`,
        sentence:
          `your request to add ${guestName} lapsed on ${formatNZDate(outcome.expiredAt)} ` +
          `with no answer, and ${guestFirstName} has been taken off your booking at ${stay}.`,
        consequenceNote: composeRepricedConsequence(outcome.creditCents),
      };
    case "EXPIRED_STILL_ON_BOOKING":
      return {
        heading: `${guestName} did not answer in time`,
        sentence: `your request to add ${guestName} lapsed on ${formatNZDate(outcome.expiredAt)} with no answer.`,
        consequenceNote:
          `${guestFirstName} is still on the booking, ` +
          `${STILL_ON_BOOKING_REASON_BY_BLOCKER[outcome.blocker]}. The club has been ` +
          "told and will be in touch.",
      };
  }
}
