import { APP_TIME_ZONE } from "@/config/operational";
import {
  SELF_REMOVABLE_GUEST_BOOKING_STATUSES,
} from "@/lib/booking-guest-self-removal";
import { getTodayDateOnly, normalizeDateOnlyForTimeZone } from "@/lib/date-only";
import {
  classifyMemberGuestConsent,
  type MemberGuestConsentColumns,
} from "@/lib/member-guest-consent";

/**
 * The member-visible consent surfaces' shared brain ("+ Add Member Guest",
 * epic #2305, MG2 #2307): what card the booking page shows the viewer, which
 * decline refusals are PREDICTABLE and what they say, and the per-guest badge
 * every viewer of the guest list reads.
 *
 * All of it is pure and database-free so the booking page, the delegate page
 * and the tests consume one rule. The copy is the copy the owner signed off on
 * the #2307 mockup pack (30 Jul) and must not drift from it casually — the
 * badge wording in particular is a ticked owner decision (MG2-M-2).
 *
 * THE REFUSAL MODEL FOLLOWS #2250 EXACTLY, per the mockups. Owner decision
 * D-14 subjects a member who never consented to the ordinary self-removal
 * blockers, so "No thanks" is sometimes refused. Four of those refusals are
 * predictable from facts the page already holds (booking status, check-in,
 * guest count, quote-priced), so the card warns BEFORE the click and drops the
 * "No thanks" button. The settled-payment election is NOT predictable — only
 * the full repricing pass inside the removal transaction can know it — so the
 * card keeps both buttons and repeats the server's refusal word for word if it
 * comes back. Predicting it by guessing from "has a captured payment" would
 * hide the action from members the server would in fact allow.
 */

/** The four decline refusals the page can know about before the click. */
export type PredictableConsentDeclineBlocker =
  | "BOOKING_STATUS"
  | "STAY_NOT_FUTURE"
  | "LAST_GUEST"
  | "QUOTE_PRICED";

/**
 * Predict whether the shared removal path would refuse this guest's decline.
 *
 * Mirrors `evaluateGuestSelfRemoval`'s gate ORDER (status, stay, last guest,
 * quote) so the reason shown is the one the server would actually raise first.
 * The two actor-identity blockers (`OWN_BOOKING` / `NOT_THEIR_OWN_GUEST`) do
 * not exist here: a consent decline runs under the consent authority, which
 * names the target's own row by construction.
 */
export function predictConsentDeclineRefusal(params: {
  bookingStatus: string;
  bookingCheckIn: Date;
  bookingGuestCount: number;
  isQuotePriced: boolean;
  today?: Date;
}): PredictableConsentDeclineBlocker | null {
  const {
    bookingStatus,
    bookingCheckIn,
    bookingGuestCount,
    isQuotePriced,
    today = getTodayDateOnly(),
  } = params;

  if (!SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(bookingStatus)) {
    return "BOOKING_STATUS";
  }
  if (normalizeDateOnlyForTimeZone(bookingCheckIn) <= today) {
    return "STAY_NOT_FUTURE";
  }
  if (bookingGuestCount <= 1) {
    return "LAST_GUEST";
  }
  if (isQuotePriced) {
    return "QUOTE_PRICED";
  }
  return null;
}

/** Who is reading the warning: the member themselves, or a family delegate. */
export type ConsentRefusalVoice =
  | { kind: "TARGET" }
  | { kind: "DELEGATE"; guestFirstName: string };

/**
 * The pre-click warning for a predictable decline refusal.
 *
 * The LAST_GUEST and QUOTE_PRICED sentences are the mockup's variant A and
 * variant C copy verbatim (member voice). BOOKING_STATUS and STAY_NOT_FUTURE
 * were not drawn on the mockup pack, so their sentences are composed in the
 * same voice from the shared self-removal wording, still naming who CAN act.
 * The delegate voice restates each in the third person, since the delegate is
 * not the person whose place it is.
 */
export function describeConsentDeclineRefusal(params: {
  blocker: PredictableConsentDeclineBlocker;
  voice: ConsentRefusalVoice;
  bookerFirstName: string;
}): string {
  const { blocker, voice, bookerFirstName } = params;

  if (voice.kind === "TARGET") {
    switch (blocker) {
      case "LAST_GUEST":
        return (
          `You are the only guest on this booking, so taking you off would leave it empty. ` +
          `Only ${bookerFirstName} or the club can cancel it. Ask ${bookerFirstName} to ` +
          `cancel the booking if you do not want to go.`
        );
      case "QUOTE_PRICED":
        return (
          "This booking was priced by hand, so guests cannot be taken off it here. " +
          "Only the club can take you off — it will re-quote the request. " +
          "Reply to the club and they will sort it."
        );
      case "BOOKING_STATUS":
        return (
          "This booking is in a state where guests cannot be taken off it, so saying no " +
          `cannot release your place. Ask ${bookerFirstName} or the club to take you off ` +
          "if you do not want to go."
        );
      case "STAY_NOT_FUTURE":
        return (
          "This stay starts today or has already started, so your place can no longer be " +
          `released here. Ask ${bookerFirstName} or the club if your plans have changed.`
        );
    }
  }

  const name = voice.guestFirstName;
  switch (blocker) {
    case "LAST_GUEST":
      return (
        `${name} is the only guest on this booking, so taking ${name} off would leave it ` +
        `empty. Only ${bookerFirstName} or the club can cancel it. Ask ${bookerFirstName} ` +
        `to cancel the booking if ${name} does not want to go.`
      );
    case "QUOTE_PRICED":
      return (
        `This booking was priced by hand, so guests cannot be taken off it here. ` +
        `Only the club can take ${name} off — it will re-quote the request. ` +
        "Reply to the club and they will sort it."
      );
    case "BOOKING_STATUS":
      return (
        "This booking is in a state where guests cannot be taken off it, so saying no " +
        `cannot release ${name}'s place. Ask ${bookerFirstName} or the club to take ` +
        `${name} off if they do not want to go.`
      );
    case "STAY_NOT_FUTURE":
      return (
        "This stay starts today or has already started, so the place can no longer be " +
        `released here. Ask ${bookerFirstName} or the club if ${name}'s plans have changed.`
      );
  }
}

/** What the booking page renders for the viewer's own consent state, if anything. */
export type BookingConsentCard =
  | {
      kind: "PENDING_ASK";
      /** The viewer's own `BookingGuest` row on this booking. */
      guestId: string;
      /** When the request lapses; never null on a legal PENDING row. */
      consentExpiresAt: Date | null;
      /** A predictable decline refusal, or null when both buttons render. */
      refusalBlocker: PredictableConsentDeclineBlocker | null;
    }
  | { kind: "NOTIFY_ONLY_NOTICE" };

/**
 * Which consent card — if any — the booking detail page shows THIS viewer.
 *
 * Mirrors `resolveBookingSelfRemovalCard`'s "never offer what the server would
 * refuse" contract: the decision is made from the same facts the removal
 * service enforces, extracted here so it is unit testable rather than living
 * inline in a server component.
 *
 * Two cards exist and both are about the viewer's OWN row:
 *
 *  - `PENDING_ASK` — the viewer is the target of an unanswered request (owner
 *    decision D-11 gives that row full booking-page access, so the card sits
 *    inside the real page). Carries the predictable-refusal answer.
 *  - `NOTIFY_ONLY_NOTICE` — the viewer was told, not asked (D-3 opt-down).
 *    There is no question to answer, so the card only points at the #2250
 *    self-removal card below it — which is why it renders ONLY when that card
 *    is present: a pointer at a card that is not there would dangle.
 *
 * A soft-deleted booking gets neither. An ADMIN_ASSIGNED viewer gets neither —
 * their row was placed by the club and the ordinary page already tells the
 * truth about it. Unlike the self-removal card this does NOT hide from admin
 * viewers: a pending request is the viewer's own business whatever hat they
 * wear, and hiding it would strand their answer.
 */
export function resolveBookingConsentCard(params: {
  actorMemberId: string;
  bookingDeletedAt: Date | null;
  bookingStatus: string;
  bookingCheckIn: Date;
  guests: readonly ({ id: string; memberId: string | null } & MemberGuestConsentColumns)[];
  /** `isQuotePricedBooking`'s answer; the page supplies it (one indexed lookup). */
  isQuotePriced: boolean;
  /** Whether the #2250 self-removal card renders on this page for this viewer. */
  selfRemovalCardPresent: boolean;
  today?: Date;
}): BookingConsentCard | null {
  const {
    actorMemberId,
    bookingDeletedAt,
    bookingStatus,
    bookingCheckIn,
    guests,
    isQuotePriced,
    selfRemovalCardPresent,
    today,
  } = params;

  if (bookingDeletedAt) return null;
  if (!actorMemberId) return null;

  const viewerGuest = guests.find((guest) => guest.memberId === actorMemberId);
  if (!viewerGuest) return null;

  if (viewerGuest.consentStatus === "PENDING") {
    return {
      kind: "PENDING_ASK",
      guestId: viewerGuest.id,
      consentExpiresAt: viewerGuest.consentExpiresAt,
      refusalBlocker: predictConsentDeclineRefusal({
        bookingStatus,
        bookingCheckIn,
        bookingGuestCount: guests.length,
        isQuotePriced,
        ...(today ? { today } : {}),
      }),
    };
  }

  const subState = classifyMemberGuestConsent(viewerGuest, viewerGuest.memberId);
  if (subState === "NOTIFY_ONLY_AUTO_CONFIRMED" && selfRemovalCardPresent) {
    return { kind: "NOTIFY_ONLY_NOTICE" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Guest-list consent badges (owner decision MG2-M-2)
// ---------------------------------------------------------------------------

export type MemberGuestConsentBadgeTone = "pending" | "ok" | "blocked";

export interface MemberGuestConsentBadge {
  tone: MemberGuestConsentBadgeTone;
  label: string;
}

/**
 * The per-guest consent badge, or null for the rows that must not change.
 *
 * Family and non-member guests — the overwhelming majority of rows, forever —
 * return null: no badge, no layout change. Member and admin read the same
 * page, so this is the ONE badge set both see; the wording is owner decision
 * MG2-M-2 as ticked (30 Jul).
 *
 * `responderName` is the display name of `consentRespondedByMemberId`, looked
 * up by the caller (this module stays database-free). When the responder's
 * member record has since vanished, the delegate badge falls back to a plain
 * "Consented" and the admin badge to "Added by the club" — both still true.
 *
 * A row that matches NO legal sub-state still gets an honest badge from its
 * raw status rather than disappearing: a broken row a viewer cannot see is a
 * broken row nobody ever fixes.
 */
export function describeMemberGuestConsentBadge(params: {
  guest: { memberId: string | null } & MemberGuestConsentColumns;
  responderName?: string | null;
}): MemberGuestConsentBadge | null {
  const { guest, responderName } = params;

  if (guest.consentStatus === null) return null;

  const subState = classifyMemberGuestConsent(guest, guest.memberId);

  switch (guest.consentStatus) {
    case "PENDING":
      return {
        tone: "pending",
        label: guest.consentExpiresAt
          ? `Waiting for consent · expires ${formatConsentShortDate(guest.consentExpiresAt)}`
          : "Waiting for consent",
      };
    case "CONFIRMED":
      if (subState === "NOTIFY_ONLY_AUTO_CONFIRMED") {
        return { tone: "ok", label: "Told, not asked" };
      }
      if (subState === "ADMIN_ASSIGNED") {
        return {
          tone: "ok",
          label: responderName ? `Added by ${responderName}` : "Added by the club",
        };
      }
      if (subState === "DELEGATE_APPROVED" && responderName) {
        return {
          tone: "ok",
          label: guest.consentRespondedAt
            ? `Consented by ${responderName}, ${formatConsentShortDate(guest.consentRespondedAt)}`
            : `Consented by ${responderName}`,
        };
      }
      return { tone: "ok", label: "Consented" };
    case "DECLINED":
      return { tone: "blocked", label: "Said no — could not be removed" };
    case "EXPIRED":
      return { tone: "blocked", label: "Lapsed — could not be removed" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Date labels — NZ lodge dates, in the shapes the mockups draw
// ---------------------------------------------------------------------------

/** "7 Aug" — the badge / inline-sentence shape. */
export function formatConsentShortDate(date: Date): string {
  return date.toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    timeZone: APP_TIME_ZONE,
  });
}

/** "Sat 8 Aug" — one night in a nights list, or the lapse sentence's deadline.
 * en-NZ renders "Sat, 8 Aug"; the comma is stripped because the signed-off
 * mockups write the bare "Sat 8 Aug" shape throughout. */
export function formatConsentWeekdayDate(date: Date): string {
  return date
    .toLocaleDateString("en-NZ", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: APP_TIME_ZONE,
    })
    .replace(/,/g, "");
}

/** "Fri 7 Aug 2026" — the facts-table shape (comma stripped, as above). */
export function formatConsentFullDate(date: Date): string {
  return date
    .toLocaleDateString("en-NZ", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: APP_TIME_ZONE,
    })
    .replace(/,/g, "");
}

/** "Sat 8 Aug – Mon 10 Aug 2026 (2 nights)" — the facts-table stay row. */
export function formatConsentStayLabel(checkIn: Date, checkOut: Date): string {
  const nights = Math.max(
    1,
    Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000),
  );
  return (
    `${formatConsentWeekdayDate(checkIn)} – ${formatConsentFullDate(checkOut)} ` +
    `(${nights} night${nights === 1 ? "" : "s"})`
  );
}

/** "Sat 8 Aug, Sun 9 Aug" — the guest's own nights row. */
export function formatConsentNightsLabel(nights: readonly Date[]): string {
  return nights.map((night) => formatConsentWeekdayDate(night)).join(", ");
}

const NIGHT_COUNT_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

/** "two nights" — the intro sentence's count, in words as the mockup writes it. */
export function describeConsentNightsCount(count: number): string {
  const word =
    count >= 0 && count < NIGHT_COUNT_WORDS.length
      ? NIGHT_COUNT_WORDS[count]
      : String(count);
  return `${word} night${count === 1 ? "" : "s"}`;
}
