"use client";

import type { AgeTier } from "@prisma/client";
import type { MinimumStayViolation } from "@/lib/booking-policies";
import type { AggregatedPolicyExceptions } from "@/lib/booking-policy-exceptions";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCents } from "@/lib/utils";
import { getAgeTierLabel, useAgeTierOptions } from "@/lib/use-age-tier-options";
import { GuestNightGrid } from "@/components/guest-night-grid";
import { EditMemberGuestFinder } from "@/components/booking/edit-member-guest-section";
// The create wizard's own prediction + column translation, imported rather than
// re-implemented (MG4 #2309). The first cut of this panel wrote its own copy of
// both and the two immediately disagreed about an admin add — see
// `predictMemberGuestConsent`'s note on `actorKind`.
import {
  memberGuestConsentPreviewColumns,
  predictMemberGuestConsent,
} from "@/app/(authenticated)/book/_components/member-guest-preview";
import { describeMemberGuestConsentBadge } from "@/lib/member-guest-consent-card";
import type { MemberGuestCandidate } from "@/lib/member-guest-find";
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import {
  RequestOfficerApprovalCard,
  type ExceptionRequestSubmitResult,
} from "@/components/booking/request-officer-approval-card";
import {
  readExceptionOffer,
  type ExceptionOffer,
} from "@/lib/booking-exception-offer";
import { countNightsDateOnly, parseDateOnly } from "@/lib/date-only";
import { PromoCodeInput, type PromoResult } from "@/components/promo-code-input";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
// Both constants live in `member-guest-refusal.ts`, which has NO imports of its
// own — so recognising D-8's collapsed refusal here costs the client bundle two
// strings rather than the booking-guest server module they used to sit beside.
import {
  MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE,
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
  MEMBER_GUEST_NOT_ADDABLE_CODE,
} from "@/lib/member-guest-refusal";

// #2104: mirror of requiresAdultSupervisionReview (src/lib/booking-review.ts).
// Inlined (not imported) to match the create wizard's client-side predicate
// (use-booking-wizard.ts:180-187) and keep server-leaning modules out of the
// client bundle. The server remains the enforcer; this only drives the UI.
function editTripsAdultSupervisionReview(
  guests: Array<{ ageTier: string }>,
): boolean {
  const hasAdult = guests.some((g) => g.ageTier === "ADULT");
  const hasMinor = guests.some(
    (g) => g.ageTier === "CHILD" || g.ageTier === "YOUTH" || g.ageTier === "INFANT",
  );
  return hasMinor && !hasAdult;
}

/**
 * Did the quote request this panel just sent actually try to ADD anybody?
 *
 * Finding 3 of the MG3 (#2308) privacy re-review. Once a booking carries a
 * cross-family member guest, C1's marking makes every date change re-ask the
 * person-night question about that member, so `modify-quote` can answer D-8's
 * collapsed refusal — "This member can't be added to this booking right now." —
 * to a request whose body contains no `addGuests` at all. The booker changed two
 * dates and is told they failed to add somebody. It reads as a bug, and the
 * natural response to a bug is to try again, which is the behaviour #2388's
 * throttle is least able to tell apart from probing.
 *
 * The payload is this component's own JSON, one parse per quote, so reading it
 * back is cheap and cannot be wrong about what was sent. It fails CLOSED — an
 * unparseable payload is treated as an add, which keeps the server's own wording
 * — because the alternative is silently re-writing a refusal that WAS about an
 * add.
 */
function quotePayloadAddsGuests(payloadJson: string): boolean {
  try {
    const body = JSON.parse(payloadJson) as { addGuests?: unknown };
    return Array.isArray(body.addGuests) && body.addGuests.length > 0;
  } catch {
    return true;
  }
}

/**
 * The sentence to show for a refused quote.
 *
 * Only ONE case is re-worded: D-8's collapsed member-guest refusal on a request
 * that added nobody. Everything else — including the same collapsed refusal on a
 * request that DID add somebody — is shown exactly as the server sent it. The
 * server's answer is unchanged either way; this only stops the panel asserting
 * an act the booker did not perform. See `MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE`.
 */
function quoteRefusalMessage(
  data: { code?: unknown; error?: unknown },
  requestAddsGuests: boolean,
): string {
  if (!requestAddsGuests && data?.code === MEMBER_GUEST_NOT_ADDABLE_CODE) {
    return MEMBER_GUEST_CHANGE_REFUSAL_MESSAGE;
  }
  return typeof data?.error === "string" && data.error
    ? data.error
    : "Failed to get quote";
}

/**
 * The pre-save consent badge and helper line for one newly added guest.
 *
 * Two composed strings, both from shared code rather than from wording written
 * here: the badge from `describeMemberGuestConsentBadge`'s WIZARD audience —
 * the warmer, name-bearing form the create path already uses — and the helper
 * from a tense-corrected version of the same sentence.
 *
 * The columns handed to the badge function are a REAL sub-state of the eight-
 * shape table, not an approximation: `AWAITING_TARGET` without its expiry (the
 * wizard audience shows no date, and a null cannot leak into a rendered
 * deadline the way an invented one could), or `NOTIFY_ONLY_AUTO_CONFIRMED`
 * exactly. Returns null for every other added guest.
 */
function renderAddedGuestConsent(guest: NewGuest) {
  const columns = memberGuestConsentPreviewColumns(guest);
  if (!columns) return null;
  const preview = guest.memberGuestConsentPreview;
  const badge = describeMemberGuestConsentBadge({
    guest: { memberId: guest.memberId ?? null, ...columns },
    audience: "WIZARD",
    targetFirstName: guest.firstName,
  });
  const name = guest.firstName.trim() || "They";
  return (
    <>
      {badge ? (
        <span
          className={
            badge.tone === "pending"
              ? "mt-1 inline-block rounded-md border border-warning-6 bg-warning-3 px-2 py-0.5 text-xs font-semibold text-warning-11"
              : badge.tone === "ok"
                ? "mt-1 inline-block rounded-md border border-success-6 bg-success-3 px-2 py-0.5 text-xs font-semibold text-success-11"
                : "mt-1 inline-block rounded-md border border-danger-6 bg-danger-3 px-2 py-0.5 text-xs font-semibold text-danger-11"
          }
        >
          {badge.label}
        </span>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">
        {preview === "PENDING"
          ? `${name} will be emailed when you save this change, and their bed is held until they answer.`
          : preview === "ADMIN_ASSIGNED"
            ? // MG4-D-a, both halves, and the second is the one an officer is
              // likely to assume away. Tensed for the edit panel — nothing is
              // written until the save — exactly as the PENDING line above is.
              `Added by the club and told by email. ${name} will not be asked first.`
            : "Your club adds member guests straight away and emails them to say so."}
      </p>
    </>
  );
}

/**
 * The one explanatory sentence under an EXISTING member-guest row (MG4 #2309).
 *
 * Two rows carry one, and both come from the signed-off mockup:
 *
 *  - a row still waiting for an answer, where the control below it says "Cancel
 *    request" rather than "Remove" and the booker deserves to know that
 *    pressing it sends an email and frees a held bed;
 *  - a row the club placed (`ADMIN_ASSIGNED`), where MG4-D-a's second half —
 *    they were told, and they were never asked — is the part that goes without
 *    saying and therefore goes unsaid.
 *
 * Every other row returns null and is byte-identical to before: family guests,
 * non-member guests, ordinary consents, and every booking that predates the
 * feature.
 */
function renderExistingGuestConsentHelper(guest: Guest) {
  const name = guest.firstName.trim() || "They";
  if (guest.consent?.tone === "pending") {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        Cancelling withdraws the request. {name} is told, and their held bed is
        released.
      </p>
    );
  }
  if (guest.consent?.subState === "ADMIN_ASSIGNED") {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        Added by the club and told by email. {name} was not asked first.
      </p>
    );
  }
  return null;
}

function shiftDateKey(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** All night keys (yyyy-mm-dd) from checkIn (inclusive) to checkOut (exclusive). */
function eachNightKey(checkIn: string, checkOut: string): string[] {
  const keys: string[] = [];
  let current = checkIn;
  for (let i = 0; current < checkOut && i < 1000; i++) {
    keys.push(current);
    current = shiftDateKey(current, 1);
  }
  return keys;
}

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: string[] | null;
  priceCents: number;
  /**
   * The member-guest consent badge, composed server-side (#2307) and threaded
   * through unchanged. MG4 (#2309) reads only its TONE, and only to name the
   * remove control honestly: taking a row off while its consent request is
   * still unanswered is cancelling a request, not removing a guest, and the
   * person on the other end gets a different email for each. Absent - not
   * null-valued - on family and non-member rows.
   */
  consent?: {
    tone: "pending" | "ok" | "blocked";
    label: string;
    /**
     * The classified sub-state (`member-guest-consent.ts`'s eight-shape table),
     * computed server-side from the persisted columns.
     *
     * The TONE cannot stand in for it: `"ok"` covers an ordinary consent, a
     * notify-only auto-confirm and an admin placement alike, and the helper
     * sentence under the row is different for the last of those. Absent on
     * every row that has no badge.
     */
    subState?: string | null;
  };
}

interface FamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  relationship: "self" | "partner" | "dependent";
}

interface PromoInfo {
  code: string;
  type: string;
  description: string | null;
  // Set when this discount came from a work party (working bee) event's
  // internal promo rather than a manually entered code.
  workPartyEventName?: string | null;
}

interface BookingData {
  id: string;
  checkIn: string;
  checkOut: string;
  guests: Guest[];
  viewerRole: string;
  finalPriceCents: number;
  totalPriceCents: number;
  discountCents: number;
  promoAdjustmentCents: number;
  promo: PromoInfo | null;
  canEditNonMemberGuestNames: boolean;
  // Fully paid: only an identity-preserving spelling correction is allowed on a
  // free-text non-member guest (#1386). The server enforces the similarity guard.
  canFixNonMemberGuestNameTypos: boolean;
  editPolicy: {
    mode: "future" | "in-progress" | null;
    today: string;
    editableFrom: string | null;
    checkInEditable: boolean;
    // Issue #1668: an admin may override the date-window locks for this booking.
    // Optional so pre-existing fixtures stay valid; the booking page sets it.
    adminOverrideAvailable?: boolean;
  };
  // #2104: an already-flagged/reviewed booking (requiresAdminReview && a
  // non-null adminReviewStatus) must not re-prompt for a justification — the
  // server only demands a reason on the FIRST no-adult trip. Optional so
  // pre-existing fixtures/callers stay valid.
  requiresAdminReview?: boolean;
  adminReviewStatus?: string | null;
  // #2259 honesty rule: the booking's "No emails" switch. With it on, the
  // change-notification email is withheld by the mailer whatever the admin
  // picks, so the notify dialog stops offering the choice and states the
  // position instead. Optional so pre-existing fixtures/callers stay valid;
  // the booking page sets it. NEVER surfaced on a member-facing control — a
  // member must not learn the switch exists — and the panel only reads it on
  // the admin (`actingAsAdmin`) dialog path.
  noEmails?: boolean;
  // #2266: the account-credit card (owner-decided: its own card above the
  // Return-method radio). Null/absent when this booking cannot carry a credit
  // election — the card is then not rendered at all. `electionCents` is the
  // stored #2265 election; `appliedCents` is ledger credit already applied.
  credit?: {
    availableCents: number;
    electionCents: number | null;
    appliedCents: number;
  } | null;
  // #2266: booking OWNER's member id, for on-behalf promo validation.
  memberId?: string;
  // #2266: the booking's lodge, so promo lodge restrictions validate against
  // the right lodge in the shared PromoCodeInput.
  lodgeId?: string | null;
  /**
   * MG4 (#2309): the member-guest surface's server-computed shape.
   *
   * SERVER-PROVIDED, NOT A CLIENT GUESS, and threaded through the booking page
   * rather than fetched by the panel: the module flag and both policy values are
   * settings reads, and a client that decided for itself would show a finder
   * that 404s when used. Absent entirely — not false-valued — when the module is
   * off, so a club that never adopted the feature ships the same payload it did
   * before MG4.
   */
  memberGuest?: {
    /** The `memberGuests` module, effectively enabled for this club. */
    enabled: boolean;
    /**
     * Whether the name type-ahead is available to THIS reader: the club's
     * open-search setting for a member, `membership:view` for an officer (D-20).
     */
    openSearchEnabled: boolean;
    /** `MemberGuestSettings.approvalRequired` (D-3) — copy only. */
    approvalRequired: boolean;
  };
  /**
   * #2337: true when this booking is a MEMBER whole-lodge booking (not a SCHOOL
   * one) AND the viewer is an admin/officer — the exact audience and booking
   * class the placeholder→member link is fenced to. Server-computed
   * (`isMemberWholeLodgeBooking`), never guessed here, so the panel only offers
   * the "Link to member" control where the save path will honour it. Absent — not
   * false-valued — on every other booking, so their payload is unchanged.
   */
  memberWholeLodge?: boolean;
}

// #2266: an eligible promo chip, as returned by GET /api/promo-codes/available
// (the same endpoint and shape the create wizard's review step consumes).
interface AvailablePromoCode {
  code: string;
  description: string | null;
}

interface NewGuest {
  key: string; // client-side key for React
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: string;
  stayEnd?: string;
  // Explicit included nights (issue #713), set in the multi date range grid.
  nights?: string[];
  // #1746 (admin only): this guest is added as the second occupant of a
  // shared double with their confirmed partner (a member already on the
  // booking) — capacity runs through the reserved partner slots.
  partnerSharedWithMemberId?: string;
  /**
   * MG4 (#2309): what SAVING this edit will do to this person's consent, for
   * the badge and helper line shown before the booker saves.
   *
   * A PREDICTION, and undefined for every other kind of added guest — family
   * quick-adds (consent-free under D-6), partner adds and typed-in non-members
   * all stay byte-identical to before. Predicted rather than fetched because
   * nothing has been written yet: the row does not exist, so there is no
   * `consentRequestedAt` and no real expiry to show, and inventing one is how a
   * fake deadline ends up on screen. The server recomputes the family boundary
   * and is the only thing that decides what is persisted.
   */
  memberGuestConsentPreview?: "PENDING" | "NOTIFY_ONLY" | "ADMIN_ASSIGNED";
}

// Server-computed partner-sharer quick-add candidate (#1746): a confirmed
// partner of a member already on the booking.
interface PartnerSharingCandidate {
  id: string;
  firstName: string;
  lastName: string;
  partnerOfMemberId: string;
  partnerOfName: string;
}

interface ItemizedChange {
  label: string;
  amountCents: number;
}

interface SettlementOptions {
  basisAmountCents: number;
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  accountCreditAmountCents: number;
  accountCreditPercentage: number;
  daysUntilCheckIn: number;
  requiresSettlementMethod: boolean;
}

interface QuoteResult {
  newTotalPriceCents: number;
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  newFinalPriceCents: number;
  priceDiffCents: number;
  changeFeeCents: number;
  netChargeCents: number;
  settlementOptions: SettlementOptions | null;
  // #2266: the member's live credit balance (create-flow quote parity).
  availableCreditCents?: number;
  capacityAvailable: boolean;
  // #1746: why a partner-shared admission was rejected (shown verbatim).
  partnerSharedReason?: string | null;
  promoStillValid: boolean;
  // #2390: present only when a promotion's usage cap stops it reaching somebody
  // this edit adds. The edit still saves and everyone already covered keeps
  // their discount — the member is simply told, before they save, who is
  // covered and who is at the normal rate.
  promoCoverage?: {
    promoCode: string;
    coveredNames: string[];
    excludedNames: string[];
    message: string;
  } | null;
  promoValidation: {
    valid: boolean;
    error?: string;
    code?: string;
    discountCents?: number;
    promoAdjustmentCents?: number;
  } | null;
  itemizedChanges: ItemizedChange[];
  nightDetails?: { date: string; availableBeds: number }[];
  // Issue #1668: set under an admin override when the target nights are over
  // capacity — the UI shows a warning and an explicit confirm rather than a
  // hard block.
  overCapacityConfirmRequired?: boolean;
  // #2124: whole-stay minimum-stay verdict. ADVISORY on this self-service path
  // — rendered as a warning, never gates Save (matching the pre-existing
  // future-edit semantics; the hard block lives on the create path).
  minimumStayValid?: boolean;
  minimumStayViolations?: MinimumStayViolation[];
  exceptionReview?: AggregatedPolicyExceptions;
  // #2543: the server's own member-facing sentence saying that a membership
  // subscription on this booking is unpaid, so member rates are not available
  // for those nights. Rendered VERBATIM beside the repriced totals — never
  // re-worded here. Null whenever nobody on the party is being repriced; absent
  // only on an old cached response predating the field, which renders as null.
  // Read straight off `quote`, never copied into its own state, so a fresh quote
  // that returns null cannot leave a stale notice on screen.
  //
  // There is deliberately no `paidUpAdultMemberMissing` counterpart here: this
  // path does not warn about the paid-up-adult rule, it is REFUSED by it —
  // modify-quote answers 409 `PAID_UP_ADULT_MEMBER_REQUIRED` instead of a quote,
  // so the refusal already lands in the quote-error slot via
  // `quoteRefusalMessage`, and there is no quote body to carry a flag on.
  subscriptionMemberRateNotice?: string | null;
}

/**
 * The parts of a pending modification that a policy-exception proposal cannot
 * carry (#2562), named for the member.
 *
 * The proposal shape is a party and a set of nights — dates, guests added, guests
 * removed, per-guest stay ranges. Everything else this panel can send is a
 * different kind of change, so an approval will not apply it, and the request card
 * says so before the member submits rather than leaving them to discover it. The
 * list is derived from the ACTUAL payload keys, so a key added to the builder
 * later cannot be silently dropped without appearing here.
 */
const EXCEPTION_PROPOSAL_PAYLOAD_KEYS = [
  "checkIn",
  "checkOut",
  "addGuests",
  "removeGuestIds",
  "guestStayRanges",
] as const;

const EXCEPTION_OMITTED_CHANGE_LABELS: Record<string, string> = {
  guestUpdates: "guest name corrections",
  linkGuestToMember: "linking a placeholder guest to a member",
  promoCode: "the promo code",
  removePromoCode: "removing the promo code",
  promoGuestIds: "who the promo code applies to",
  promoAddedGuestIndexes: "who the promo code applies to",
  applyCreditCents: "using account credit",
  partnerSharedGuests: "partner-shared places",
  adminOverride: "the admin date override",
  pricingMode: "the admin pricing mode",
  confirmOverCapacity: "the over-capacity confirmation",
  settlementMethod: "how a refund is settled",
  memberReviewJustification: "the review reason",
};

export function exceptionRequestPayloadFromModification(
  body: Record<string, unknown>,
): { payload: Record<string, unknown>; omittedChanges: string[] } {
  const payload: Record<string, unknown> = {};
  for (const key of EXCEPTION_PROPOSAL_PAYLOAD_KEYS) {
    if (body[key] !== undefined) payload[key] = body[key];
  }
  const omitted = new Set<string>();
  for (const key of Object.keys(body)) {
    if ((EXCEPTION_PROPOSAL_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    // An unknown key is still reported, by its own name, rather than dropped
    // silently: a wrong-looking word on screen is recoverable, a change the member
    // believes they submitted is not.
    omitted.add(EXCEPTION_OMITTED_CHANGE_LABELS[key] ?? key);
  }
  return { payload, omittedChanges: [...omitted].sort() };
}

function previousDateOnly(dateString: string | null) {
  if (!dateString) return null;
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function shiftDateOnly(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateString;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatSignedCents(cents: number) {
  const prefix = cents > 0 ? "+" : "-";
  return `${prefix}${formatCents(Math.abs(cents))}`;
}

export function EditBookingPanel({
  booking,
  canAdminOverride = false,
  replaceExceptionRequestId = null,
  onDone,
}: {
  booking: BookingData;
  /**
   * #2562: the open policy-exception request this edit is here to REPLACE, from
   * `/bookings/<id>?replaceRequest=<id>` — the link the member's request area
   * renders. Passed through as `supersedeRequestId`; the service does the guarded
   * claim, so a stale or foreign id loses it and creates nothing.
   */
  replaceExceptionRequestId?: string | null;
  // Issue #1668: admin override lifts the date-window locks for this booking.
  // (Whether the standard self-service path is available is expressed by the
  // booking.editPolicy fields the panel already reads.)
  canAdminOverride?: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const ageTierOptions = useAgeTierOptions();

  // Editable state
  const [checkIn, setCheckIn] = useState(booking.checkIn);
  const [checkOut, setCheckOut] = useState(booking.checkOut);
  const [removedGuestIds, setRemovedGuestIds] = useState<Set<string>>(new Set());
  const [addedGuests, setAddedGuests] = useState<NewGuest[]>([]);
  const [perGuestDatesEnabled, setPerGuestDatesEnabled] = useState(
    booking.guests.some(
      (guest) =>
        (guest.stayStart && guest.stayStart !== booking.checkIn) ||
        (guest.stayEnd && guest.stayEnd !== booking.checkOut)
    )
  );
  // Seeded per-guest state, extracted so the admin-override toggle (#1668) can
  // restore the exact stored baseline — resetting to {} instead would let the
  // night grid's all-nights-on fallback silently collapse a guest's gaps.
  const seedExistingGuestRanges = () =>
    Object.fromEntries(
      booking.guests.map((guest) => [
        guest.id,
        {
          stayStart: guest.stayStart ?? booking.checkIn,
          stayEnd: guest.stayEnd ?? booking.checkOut,
        },
      ])
    );
  const seedExistingGuestNights = () =>
    Object.fromEntries(
      booking.guests.map((guest) => [
        guest.id,
        guest.nights && guest.nights.length > 0
          ? [...guest.nights].sort()
          : eachNightKey(
              guest.stayStart ?? booking.checkIn,
              guest.stayEnd ?? booking.checkOut
            ),
      ])
    );
  const [existingGuestRanges, setExistingGuestRanges] = useState<
    Record<string, { stayStart: string; stayEnd: string }>
  >(seedExistingGuestRanges);
  // Multiple date ranges / per-guest night grid (issue #713). Enabled by default
  // when an existing guest already has a non-contiguous stay so the gaps show.
  const [multiDateRangesEnabled, setMultiDateRangesEnabled] = useState(() =>
    booking.guests.some((guest) => {
      const span = eachNightKey(
        guest.stayStart ?? booking.checkIn,
        guest.stayEnd ?? booking.checkOut
      ).length;
      return Boolean(guest.nights && guest.nights.length < span);
    })
  );
  // Per existing-guest night set (keyed by guest id), seeded from stored nights
  // or the contiguous range so toggling the grid never wipes a guest's gaps.
  const [existingGuestNights, setExistingGuestNights] = useState<
    Record<string, string[]>
  >(seedExistingGuestNights);
  const [guestNameEdits, setGuestNameEdits] = useState<
    Record<string, { firstName: string; lastName: string }>
  >(() =>
    Object.fromEntries(
      booking.guests.map((guest) => [
        guest.id,
        { firstName: guest.firstName, lastName: guest.lastName },
      ])
    )
  );
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  // MG4 (#2309): has the family list ANSWERED yet?
  //
  // Not cosmetic. The consent prediction below asks "is this candidate in the
  // booking owner's family group?", and an empty list makes EVERY candidate look
  // beyond-family — so predicting from an unloaded (or failed) list would
  // promise "waiting for Mia to approve" over the booker's own child, the case
  // where the finder is most likely to be used for one's own household. An
  // unanswered list predicts nothing at all, which under-informs rather than
  // misinforms: the server still asks whoever it must, and the booking page
  // shows the true state as soon as the edit is saved.
  const [familyMembersLoaded, setFamilyMembersLoaded] = useState(false);
  // MG4 (#2309): the server's neutral D-8 refusal for the last member-guest
  // add, kept separate from `quoteError` so it can be drawn beside the person it
  // is about instead of only in the panel's page-level error line.
  const [memberGuestAddError, setMemberGuestAddError] = useState<string | null>(
    null,
  );
  // Owner sign-off, 1 Aug 2026: the finder is opened from a button in the
  // Guests card HEADER, beside "+ Add Non-Member Guest" - the wizard's exact
  // shape - so the open/close state and the trigger ref live here rather than
  // inside the finder, in the same place and for the same reason
  // `guests-step.tsx` owns them for the wizard.
  const [memberGuestFinderOpen, setMemberGuestFinderOpen] = useState(false);
  // Who the last add was about, so a refusal renders beside a chip naming them
  // rather than floating above an empty search box (MG3's F9).
  const [lastMemberGuestAttempt, setLastMemberGuestAttempt] =
    useState<MemberGuestCandidate | null>(null);
  // Focus has to go somewhere when the panel closes, or Escape drops it on the
  // document body and a keyboard user is stranded at the top of a long panel
  // (MG3's F5).
  const memberGuestTriggerRef = useRef<HTMLButtonElement>(null);
  // #1746: partner-sharer quick-adds (admin fetch only — the member family
  // route never returns them, so this stays empty for members).
  const [partnerCandidates, setPartnerCandidates] = useState<
    PartnerSharingCandidate[]
  >([]);
  const [promoAction, setPromoAction] = useState<
    | { type: "keep" }
    | { type: "remove" }
    // #2266: guestIndexes carries a guest-targeted code's beneficiary
    // selection (from the shared PromoCodeInput), positional over
    // [remaining guests..., added guests...] — the order the server prices.
    | { type: "new"; code: string; guestIndexes?: number[] }
  >({ type: "keep" });
  // #2266: the old blind promo text field is gone — the shared PromoCodeInput
  // owns entry + validation of a NEW code (guest selection included).
  const [appliedNewPromo, setAppliedNewPromo] = useState<PromoResult | null>(
    null,
  );
  const [availablePromoCodes, setAvailablePromoCodes] = useState<
    AvailablePromoCode[]
  >([]);
  const [prefillPromoCode, setPrefillPromoCode] = useState<string | undefined>(
    undefined,
  );

  // #2266: account credit. `useCredit` is seeded from the stored election
  // (#2265) so re-opening a draft shows the saved choice; `creditTouched`
  // separates "the member changed their mind" from "the panel recomputed".
  const credit = booking.credit ?? null;
  const storedElectionCents = credit?.electionCents ?? 0;
  const [useCredit, setUseCredit] = useState(storedElectionCents > 0);
  const [creditTouched, setCreditTouched] = useState(false);

  // Issue #1668: admin date override. When enabled, the member-facing date
  // locks are bypassed and the admin chooses how pricing is handled. Every
  // override edit is date-only, audited, and confirmed if over capacity.
  // The override control renders only when the server says this viewer may
  // override (canAdminOverride) AND the serialised edit policy agrees (#1668).
  const adminOverrideAvailable =
    canAdminOverride && booking.editPolicy.adminOverrideAvailable !== false;
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overridePricingMode, setOverridePricingMode] = useState<
    "shift" | "recalculate" | null
  >(null);
  const [confirmOverCapacity, setConfirmOverCapacity] = useState(false);
  // Belt-and-braces (a stale quote): an apply 409 re-surfaces the confirm flow.
  const [saveOverCapacityNights, setSaveOverCapacityNights] = useState<
    { date: string; availableBeds: number }[] | null
  >(null);
  // Owner decision (#1668 review): every override save asks the admin whether
  // the member should receive the change-notification email.
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);
  const originalNights = useMemo(
    () => eachNightKey(booking.checkIn, booking.checkOut).length,
    [booking.checkIn, booking.checkOut],
  );
  const shiftMode = overrideEnabled && overridePricingMode === "shift";

  // Quote state
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [settlementMethod, setSettlementMethod] = useState<"card" | "credit" | null>(null);
  /**
   * #2562 — the server-confirmed offer to ask a Booking Officer, or null.
   *
   * Set ONLY from a refusal the SERVER classified as reviewable, through the one
   * shared rule in `readExceptionOffer`, and set from BOTH refusal points on this
   * path: the quote (modify-quote answers 409 PAID_UP_ADULT_MEMBER_REQUIRED instead
   * of a quote) and the save (the modify paths hard-block a minimum-stay breach with
   * a 400 carrying the frozen review). A hard failure — a full lodge, invalid dates,
   * a consent or authority refusal — can never open it.
   */
  const [exceptionOffer, setExceptionOffer] = useState<ExceptionOffer | null>(
    null,
  );

  // #2337: the placeholder→member links this edit will apply, keyed by the
  // existing guest row id. `linkFinderGuestId` is the row currently choosing a
  // member through the reused member finder.
  const [linkedGuestMembers, setLinkedGuestMembers] = useState<
    Record<string, MemberGuestCandidate>
  >({});
  const [linkFinderGuestId, setLinkFinderGuestId] = useState<string | null>(null);
  // The link control is fenced to exactly the audience + booking class the save
  // path honours, and requires the member finder (the reused member search).
  // #2534: it is also hidden on an in-progress (mid-stay) edit, because the save
  // path REFUSES a placeholder→member link mid-stay (the in-progress pricing
  // path re-rates the original rows, not the link-modified ones, so an in-place
  // re-rate would silently no-op — see the modify-quote in-progress guard). The
  // officer is pointed to remove-and-re-add, which settles correctly mid-stay,
  // rather than being offered a control that only ever returns a quote-time
  // refusal. `booking.editPolicy.mode === "in-progress"` is the same signal
  // `isInProgressEdit` derives from below (declared after this line); using it
  // directly keeps the fence self-contained here.
  const memberLinkEnabled =
    Boolean(booking.memberWholeLodge) &&
    booking.viewerRole === "ADMIN" &&
    Boolean(booking.memberGuest?.enabled) &&
    !overrideEnabled &&
    booking.editPolicy.mode !== "in-progress";

  // Add guest form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addFirstName, setAddFirstName] = useState("");
  const [addLastName, setAddLastName] = useState("");
  const [addAgeTier, setAddAgeTier] = useState<AgeTier>("ADULT");

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // #2390: the coverage the SAVE came back with, when it differs from what the
  // preview showed. The preview reads the promotion's counters unlocked and the
  // save re-reads them under the row lock, so another booking can take the last
  // slot in between — and then the price the member gets is not the price the
  // panel explained. Holding the panel open with the server's own sentence
  // keeps the explanation at the moment of the edit, which is the whole point
  // of the owner decision; without it the member first learns from the email.
  const [savedPromoCoverage, setSavedPromoCoverage] = useState<string | null>(
    null,
  );
  // #2104: member-facing justification for a modification that leaves minors
  // with no adult on the booking. Shown proactively when the local predicate
  // trips, or reactively when the server returns REVIEW_JUSTIFICATION_REQUIRED.
  const [memberReviewJustification, setMemberReviewJustification] = useState("");
  const [reviewJustificationError, setReviewJustificationError] = useState("");
  const [serverRequiresJustification, setServerRequiresJustification] =
    useState(false);
  const reviewJustificationRef = useRef<HTMLTextAreaElement>(null);
  const { scrollToError } = useScrollToFeedback();
  const [requestReason, setRequestReason] = useState("");
  const [requestSubmitting, setRequestSubmitting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [requestSuccess, setRequestSuccess] = useState("");

  const today = booking.editPolicy.today;
  const minEditableDate = booking.editPolicy.editableFrom ?? today;
  // Issue #1668: an active override lifts the check-in lock and the in-progress
  // clamps entirely (the edit is date-only), and hides the promo controls.
  const checkInLocked = overrideEnabled
    ? false
    : !booking.editPolicy.checkInEditable;
  const isInProgressEdit =
    !overrideEnabled && booking.editPolicy.mode === "in-progress";
  const promoLocked = isInProgressEdit || overrideEnabled;

  function handleCheckInChange(value: string) {
    setCheckIn(value);
    // Shift mode keeps the stay length fixed: deriving the other bound so the
    // preview and apply both see the same night count (parity is required).
    if (shiftMode && value) {
      setCheckOut(shiftDateKey(value, originalNights));
    }
  }

  function handleCheckOutChange(value: string) {
    setCheckOut(value);
    if (shiftMode && value) {
      setCheckIn(shiftDateKey(value, -originalNights));
    }
  }

  useEffect(() => {
    let cancelled = false;
    // Admin on-behalf uses the bookings-scoped picker gated on bookings:edit
    // (the booking owner is resolved server-side from the booking), so a
    // Booking Officer without membership:view still gets the member's family
    // and correct member pricing (#1376). Members use their own family route.
    const familyUrl =
      booking.viewerRole === "ADMIN"
        ? `/api/admin/bookings/${booking.id}/eligible-family`
        : "/api/members/family";

    fetch(familyUrl)
      // A NON-OK RESPONSE IS "UNKNOWN", NOT "NO FAMILY" — the same rule the
      // wizard's loader keeps, and it was broken here (MG4 #2309). Mapping a
      // 500 to `{ familyMembers: [] }` and then setting the loaded flag told
      // the consent prediction "we asked, and this booker has no family at
      // all", which makes EVERY candidate look beyond-family — including the
      // booker's own child, whose quick-add button is missing from the same
      // failed response. The prediction then promises a consent email that is
      // never sent and a held bed that does not exist. Returning null keeps the
      // guard down and predicts nothing, which under-informs instead.
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setFamilyMembers(data.familyMembers || []);
          setPartnerCandidates(data.partnerSharingCandidates || []);
          setFamilyMembersLoaded(true);
        }
      })
      .catch(() => {
        // Nothing to set: a thrown fetch is the same "unknown" as a non-ok
        // response, and clearing the list would only discard whatever a
        // previous successful load had already put on screen.
      });

    return () => {
      cancelled = true;
    };
  }, [booking.id, booking.viewerRole]);

  // #2266: surface the member's eligible promo codes as chips (create-flow
  // parity — review-step fetches the same endpoint). Members only: the
  // endpoint returns the SESSION user's assignments, so an admin editing on
  // behalf would see their own codes, not the member's — the admin create
  // wizard offers no chips either.
  useEffect(() => {
    if (booking.viewerRole === "ADMIN") return;
    let cancelled = false;
    fetch("/api/promo-codes/available")
      .then((res) => (res.ok ? res.json() : []))
      .then((codes) => {
        if (!cancelled) {
          setAvailablePromoCodes(Array.isArray(codes) ? codes : []);
        }
      })
      .catch(() => {
        if (!cancelled) setAvailablePromoCodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [booking.viewerRole]);

  // Check if anything has changed
  const remainingGuests = useMemo(
    () => booking.guests.filter((g) => !removedGuestIds.has(g.id)),
    [booking.guests, removedGuestIds],
  );
  const canEditPerGuestDates =
    !isInProgressEdit && !overrideEnabled && totalGuestCountCandidate() > 1;
  function totalGuestCountCandidate() {
    return remainingGuests.length + addedGuests.length;
  }

  useEffect(() => {
    if (!canEditPerGuestDates && perGuestDatesEnabled) {
      setPerGuestDatesEnabled(false);
    }
  }, [canEditPerGuestDates, perGuestDatesEnabled]);

  const getExistingGuestRange = useCallback((guest: Guest) => {
    return (
      existingGuestRanges[guest.id] ?? {
        stayStart: guest.stayStart ?? booking.checkIn,
        stayEnd: guest.stayEnd ?? booking.checkOut,
      }
    );
  }, [booking.checkIn, booking.checkOut, existingGuestRanges]);

  function updateExistingGuestRange(
    guestId: string,
    field: "stayStart" | "stayEnd",
    value: string
  ) {
    setExistingGuestRanges((prev) => ({
      ...prev,
      [guestId]: {
        stayStart: prev[guestId]?.stayStart ?? booking.checkIn,
        stayEnd: prev[guestId]?.stayEnd ?? booking.checkOut,
        [field]: value,
      },
    }));
  }

  function getGuestNameEdit(guest: Guest) {
    return (
      guestNameEdits[guest.id] ?? {
        firstName: guest.firstName,
        lastName: guest.lastName,
      }
    );
  }

  function updateGuestName(
    guestId: string,
    field: "firstName" | "lastName",
    value: string
  ) {
    setGuestNameEdits((prev) => ({
      ...prev,
      [guestId]: {
        firstName:
          prev[guestId]?.firstName ??
          booking.guests.find((guest) => guest.id === guestId)?.firstName ??
          "",
        lastName:
          prev[guestId]?.lastName ??
          booking.guests.find((guest) => guest.id === guestId)?.lastName ??
          "",
        [field]: value,
      },
    }));
  }

  function updateAddedGuestRange(
    key: string,
    field: "stayStart" | "stayEnd",
    value: string
  ) {
    setAddedGuests((prev) =>
      prev.map((guest) =>
        guest.key === key
          ? {
              ...guest,
              [field]: value,
            }
          : guest
      )
    );
  }

  const guestRangesChanged =
    perGuestDatesEnabled &&
    remainingGuests.some((guest) => {
      const range = getExistingGuestRange(guest);
      return (
        range.stayStart !== (guest.stayStart ?? booking.checkIn) ||
        range.stayEnd !== (guest.stayEnd ?? booking.checkOut)
      );
    });
  const nonMemberGuestNamesEditable =
    booking.canEditNonMemberGuestNames || booking.canFixNonMemberGuestNameTypos;
  const guestNameUpdates = useMemo(
    () =>
      nonMemberGuestNamesEditable
        ? booking.guests
            .filter((guest) => !guest.isMember && !removedGuestIds.has(guest.id))
            .map((guest) => {
              const edit = guestNameEdits[guest.id] ?? {
                firstName: guest.firstName,
                lastName: guest.lastName,
              };
              return {
                guestId: guest.id,
                firstName: edit.firstName.trim(),
                lastName: edit.lastName.trim(),
                changed:
                  edit.firstName.trim() !== guest.firstName ||
                  edit.lastName.trim() !== guest.lastName,
              };
            })
            .filter((update) => update.changed)
            .map((update) => ({
              guestId: update.guestId,
              firstName: update.firstName,
              lastName: update.lastName,
            }))
        : [],
    [
      nonMemberGuestNamesEditable,
      booking.guests,
      guestNameEdits,
      removedGuestIds,
    ]
  );
  const guestNamesChanged = guestNameUpdates.length > 0;
  // A night toggle in the grid (issue #713) is a change even when it leaves the
  // guest's overall envelope unchanged (e.g. switching off a middle night).
  const guestNightsChanged =
    multiDateRangesEnabled &&
    !isInProgressEdit &&
    remainingGuests.some((guest) => {
      const original =
        guest.nights && guest.nights.length > 0
          ? [...guest.nights].sort()
          : eachNightKey(
              guest.stayStart ?? booking.checkIn,
              guest.stayEnd ?? booking.checkOut
            );
      const current = existingGuestNights[guest.id] ?? original;
      return current.join(",") !== original.join(",");
    });
  // #2266: account-credit derivations. When the member TOUCHES the control,
  // the checkbox carries the create-flow semantics — "put my credit towards
  // this booking, up to its price" — so the newly elected amount is
  // min(balance, what is still uncovered). An UNTOUCHED stored election is
  // different (MED-3): it is the member's saved choice, stored RAW with the
  // clamp living at the pay-time consumer (#2265/#2319), so the panel may
  // follow only the booking-local PRICE (a reprice this very edit causes) and
  // NEVER the live balance — otherwise an unrelated guest-name fix while the
  // balance happened to be low would silently rewrite (or clear) the stored
  // value, contradicting the card's own "it will only apply if credit returns
  // before you pay" copy. The election is STORED on the booking (#2265) and
  // consumed at payment; nothing moves here.
  const quoteFinalPriceCents =
    quote?.newFinalPriceCents ?? booking.finalPriceCents;
  const availableCreditCents =
    quote?.availableCreditCents ?? credit?.availableCents ?? 0;
  const ledgerAppliedCreditCents = credit?.appliedCents ?? 0;
  const uncoveredPriceCents = Math.max(
    0,
    quoteFinalPriceCents - ledgerAppliedCreditCents,
  );
  const desiredElectionCents = useCredit
    ? creditTouched
      ? Math.min(availableCreditCents, uncoveredPriceCents)
      : Math.min(storedElectionCents, uncoveredPriceCents)
    : 0;
  // Send the election when the member changed it, or when a stored election
  // must follow a reprice (untouched but the price cap moved) — never invent
  // one, and never rewrite a stored value for a balance change.
  const includeCreditInPayload =
    Boolean(credit) &&
    !overrideEnabled &&
    desiredElectionCents !== storedElectionCents &&
    (creditTouched || storedElectionCents > 0);
  const creditChanged =
    Boolean(credit) &&
    !overrideEnabled &&
    creditTouched &&
    desiredElectionCents !== storedElectionCents;
  const creditCardVisible =
    Boolean(credit) &&
    !overrideEnabled &&
    (availableCreditCents > 0 ||
      storedElectionCents > 0 ||
      ledgerAppliedCreditCents > 0);

  const hasChanges =
    checkIn !== booking.checkIn ||
    checkOut !== booking.checkOut ||
    removedGuestIds.size > 0 ||
    addedGuests.length > 0 ||
    guestRangesChanged ||
    guestNightsChanged ||
    guestNamesChanged ||
    promoAction.type !== "keep" ||
    creditChanged;

  // Debounced quote fetch
  const quoteTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Monotonic id per quote request so a slow, superseded response can never
  // overwrite the quote for the user's latest edit.
  const quoteRequestSeqRef = useRef(0);

  const buildModificationPayload = useCallback(() => {
    // Issue #1668: an admin override is strictly date-only. Send only the dates,
    // the override flags, and the capacity confirm — never guest/promo inputs,
    // which the route/service reject anyway.
    if (overrideEnabled && overridePricingMode) {
      const overrideBody: Record<string, unknown> = {
        adminOverride: true,
        pricingMode: overridePricingMode,
      };
      if (checkIn !== booking.checkIn) overrideBody.checkIn = checkIn;
      if (checkOut !== booking.checkOut) overrideBody.checkOut = checkOut;
      if (confirmOverCapacity) overrideBody.confirmOverCapacity = true;
      return overrideBody;
    }

    const body: Record<string, unknown> = {};
    const gridMode = multiDateRangesEnabled && !isInProgressEdit;
    const rangeMode = perGuestDatesEnabled && !isInProgressEdit && !gridMode;
    let effectiveCheckIn = checkIn;
    let effectiveCheckOut = checkOut;
    let rangeAwareAddedGuests: Array<{
      firstName: string;
      lastName: string;
      ageTier: AgeTier;
      isMember: boolean;
      memberId?: string;
      stayStart?: string;
      stayEnd?: string;
      nights?: string[];
    }> = addedGuests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId,
    }));

    if (gridMode) {
      // Multi date range mode (issue #713): send each guest's explicit night
      // set; the server reprices, re-allocates and recomputes the envelope.
      const existingRanges = remainingGuests.map((guest) => ({
        guestId: guest.id,
        nights:
          existingGuestNights[guest.id] ??
          eachNightKey(
            guest.stayStart ?? booking.checkIn,
            guest.stayEnd ?? booking.checkOut
          ),
      }));
      rangeAwareAddedGuests = addedGuests.map((g) => ({
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId,
        nights: g.nights ?? eachNightKey(checkIn, checkOut),
      }));
      const allNights = [
        ...existingRanges.flatMap((range) => range.nights),
        ...rangeAwareAddedGuests.flatMap((guest) => guest.nights ?? []),
      ].filter(Boolean);
      if (allNights.length > 0) {
        effectiveCheckIn = allNights.reduce((a, b) => (b < a ? b : a), allNights[0]);
        const lastNight = allNights.reduce((a, b) => (b > a ? b : a), allNights[0]);
        effectiveCheckOut = shiftDateKey(lastNight, 1);
      }
      body.guestStayRanges = existingRanges;
    } else if (rangeMode) {
      const existingRanges = remainingGuests.map((guest) => ({
        guestId: guest.id,
        ...getExistingGuestRange(guest),
      }));
      rangeAwareAddedGuests = addedGuests.map((g) => ({
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId,
        stayStart: g.stayStart ?? checkIn,
        stayEnd: g.stayEnd ?? checkOut,
      }));
      const rangeValues = [
        ...existingRanges.map((range) => ({
          stayStart: range.stayStart,
          stayEnd: range.stayEnd,
        })),
        ...rangeAwareAddedGuests.map((guest) => ({
          stayStart: guest.stayStart ?? checkIn,
          stayEnd: guest.stayEnd ?? checkOut,
        })),
      ].filter((range) => range.stayStart && range.stayEnd);

      if (rangeValues.length > 0) {
        const firstRange = rangeValues[0];
        effectiveCheckIn = rangeValues.reduce(
          (earliest, range) => (range.stayStart < earliest ? range.stayStart : earliest),
          firstRange.stayStart
        );
        effectiveCheckOut = rangeValues.reduce(
          (latest, range) => (range.stayEnd > latest ? range.stayEnd : latest),
          firstRange.stayEnd
        );
      }

      body.guestStayRanges = existingRanges;
    }

    if (effectiveCheckIn !== booking.checkIn) body.checkIn = effectiveCheckIn;
    if (effectiveCheckOut !== booking.checkOut) body.checkOut = effectiveCheckOut;
    if (addedGuests.length > 0) {
      body.addGuests = rangeAwareAddedGuests;
      // #1746: partner-sharer flags for admin-added partner guests still in
      // the proposal — capacity then runs through the reserved double slots.
      const partnerSharedGuests = addedGuests
        .filter((g) => g.memberId && g.partnerSharedWithMemberId)
        .map((g) => ({
          memberId: g.memberId as string,
          partnerMemberId: g.partnerSharedWithMemberId as string,
        }));
      if (partnerSharedGuests.length > 0) {
        body.partnerSharedGuests = partnerSharedGuests;
      }
    }
    if (removedGuestIds.size > 0) {
      body.removeGuestIds = Array.from(removedGuestIds);
    }
    if (guestNameUpdates.length > 0) {
      body.guestUpdates = guestNameUpdates;
    }
    // #2337: the placeholder→member links, keyed to existing guest rows.
    const links = Object.entries(linkedGuestMembers).map(
      ([guestId, candidate]) => ({ guestId, memberId: candidate.memberId }),
    );
    if (links.length > 0) {
      body.linkGuestToMember = links;
    }
    if (promoAction.type === "remove") {
      body.removePromoCode = true;
    } else if (promoAction.type === "new") {
      body.promoCode = promoAction.code;
      // #2266 (MED-4): beneficiary selection for guest-targeted codes, carried
      // from the shared PromoCodeInput through quote and apply alike. The
      // input's indexes are positional over [remaining guests..., added
      // guests...]; convert EXISTING guests to their bookingGuestId so the
      // server binds people, not positions — a concurrent edit by another
      // session then refuses loudly instead of redeeming the discount for the
      // wrong guest. Only TO-BE-ADDED guests (no id yet) stay positional,
      // relative to this request's addGuests array.
      if (promoAction.guestIndexes?.length) {
        const promoGuestIds: string[] = [];
        const promoAddedGuestIndexes: number[] = [];
        for (const index of promoAction.guestIndexes) {
          if (index < remainingGuests.length) {
            const guest = remainingGuests[index];
            if (guest) promoGuestIds.push(guest.id);
          } else {
            promoAddedGuestIndexes.push(index - remainingGuests.length);
          }
        }
        if (promoGuestIds.length) body.promoGuestIds = promoGuestIds;
        if (promoAddedGuestIndexes.length) {
          body.promoAddedGuestIndexes = promoAddedGuestIndexes;
        }
      }
    }

    // #2266: the credit election (#2265) — stored on the booking, applied when
    // the member confirms. 0 clears a saved election.
    if (includeCreditInPayload) {
      body.applyCreditCents = desiredElectionCents;
    }

    return body;
  }, [
    addedGuests,
    booking.checkIn,
    booking.checkOut,
    checkIn,
    checkOut,
    getExistingGuestRange,
    guestNameUpdates,
    linkedGuestMembers,
    isInProgressEdit,
    perGuestDatesEnabled,
    multiDateRangesEnabled,
    existingGuestNights,
    promoAction,
    remainingGuests,
    removedGuestIds,
    overrideEnabled,
    overridePricingMode,
    confirmOverCapacity,
    includeCreditInPayload,
    desiredElectionCents,
  ]);

  const fetchQuote = useCallback(
    async (payloadJson: string) => {
      const seq = ++quoteRequestSeqRef.current;
      setQuoteError("");
      setQuoteLoading(true);

      try {
        const res = await fetch(`/api/bookings/${booking.id}/modify-quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadJson,
        });

        const data = await res.json();
        // A newer edit superseded this request; drop the stale response.
        if (seq !== quoteRequestSeqRef.current) return;
        if (!res.ok) {
          const addsGuests = quotePayloadAddsGuests(payloadJson);
          setQuoteError(quoteRefusalMessage(data, addsGuests));
          // MG4 (#2309): D-8's collapsed refusal about an add the booker just
          // made is ALSO shown inside the find panel, beside the person it is
          // about. Only that one code, and only when the request actually tried
          // to add somebody — see `quotePayloadAddsGuests` for why a refusal on
          // a request that added nobody must not be re-attributed to an add.
          setMemberGuestAddError(
            addsGuests && data?.code === MEMBER_GUEST_NOT_ADDABLE_CODE
              ? MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE
              : null,
          );
          setQuote(null);
          // #2562: a refused QUOTE is a real blockage on this path — the member
          // cannot save what they cannot price — so the reviewable ones open the
          // request door here rather than making them press Save to find out.
          setExceptionOffer(readExceptionOffer(data));
          return;
        }
        setMemberGuestAddError(null);
        setQuote(data);
        // A quote that came back is not a refusal, so no request is on offer.
        // Cleared here rather than only on the next attempt, so a member who fixes
        // the proposal is not still looking at a door they no longer need.
        setExceptionOffer(null);
        // A fresh quote that no longer needs an over-capacity confirm clears any
        // stale apply-side warning (#1668).
        if (!data.overCapacityConfirmRequired) {
          setSaveOverCapacityNights(null);
        }
        if (!data.settlementOptions?.requiresSettlementMethod) {
          setSettlementMethod(null);
        }
      } catch {
        if (seq !== quoteRequestSeqRef.current) return;
        setQuoteError("Failed to get quote");
        setQuote(null);
      } finally {
        if (seq === quoteRequestSeqRef.current) {
          setQuoteLoading(false);
        }
      }
    },
    [booking.id],
  );

  // Auto-fetch quote when changes happen (debounced). The effect is keyed on
  // the serialized payload, not on callback identity: several payload inputs
  // (e.g. remainingGuests) are recomputed objects, so a callback dependency
  // changes on every render — including the render caused by a completed
  // fetch — which re-armed the timer and refetched in an endless 500ms loop.
  // Under an override the pricing-mode radio must be chosen before the quote
  // fires — otherwise a member-shaped quote would run and (for a fully-past
  // booking) error, confusing the admin.
  const overrideQuoteReady = !overrideEnabled || Boolean(overridePricingMode);
  const modificationPayloadJson =
    hasChanges && overrideQuoteReady
      ? JSON.stringify(buildModificationPayload())
      : null;
  useEffect(() => {
    if (quoteTimeoutRef.current) clearTimeout(quoteTimeoutRef.current);
    if (!modificationPayloadJson) {
      setQuote(null);
      setExceptionOffer(null);
      return;
    }
    quoteTimeoutRef.current = setTimeout(
      () => fetchQuote(modificationPayloadJson),
      500,
    );
    return () => {
      if (quoteTimeoutRef.current) clearTimeout(quoteTimeoutRef.current);
    };
  }, [fetchQuote, modificationPayloadJson]);

  /**
   * Put D-8's refusal back on screen, by re-opening the section that draws it.
   *
   * THE BUG THIS FIXES, and it made two props dead code. "Add to booking"
   * CLOSES the finder — the wizard's shape, and the right one — but the
   * server's answer only arrives on the debounced quote that follows, by which
   * time `EditMemberGuestFinder` is unmounted and its `addError` /
   * `refusedCandidate` render nowhere at all. The booker got the panel-level
   * quote error and no statement of who it was about; MG3's F9 shape (the
   * neutral sentence beside a chip naming the candidate) never appeared on this
   * surface, and its unit test asserted a state the integration never produced.
   *
   * ON THE TRANSITION ONLY. A refused member guest STAYS in `addedGuests`, so
   * every later quote re-asks the same question and returns the same refusal;
   * re-opening on each one would spring the section back open under a booker
   * who had closed it and moved on to their dates. The signature remembers what
   * has already been surfaced, and resets when the refusal clears.
   */
  const surfacedMemberGuestRefusalRef = useRef<string | null>(null);
  useEffect(() => {
    if (!memberGuestAddError) {
      surfacedMemberGuestRefusalRef.current = null;
      return;
    }
    const signature = `${lastMemberGuestAttempt?.memberId ?? ""}\u0000${memberGuestAddError}`;
    if (surfacedMemberGuestRefusalRef.current === signature) return;
    surfacedMemberGuestRefusalRef.current = signature;
    setMemberGuestFinderOpen(true);
  }, [memberGuestAddError, lastMemberGuestAttempt]);

  function handleRemoveGuest(guestId: string) {
    setRemovedGuestIds((prev) => new Set([...prev, guestId]));
  }

  function handleUndoRemoveGuest(guestId: string) {
    setRemovedGuestIds((prev) => {
      const next = new Set(prev);
      next.delete(guestId);
      return next;
    });
  }

  // #2337: record that a placeholder row is now linked to a member. Clears the
  // settlement choice and the promo (a re-rate changes the total), exactly as
  // adding a member guest does — the quote is refetched from the serialised
  // payload, and neither is recomputed by that refetch.
  function handleLinkGuestToMember(guestId: string, candidate: MemberGuestCandidate) {
    setAppliedNewPromo(null);
    setPromoAction({ type: "keep" });
    setSettlementMethod(null);
    setLinkedGuestMembers((prev) => ({ ...prev, [guestId]: candidate }));
    setLinkFinderGuestId(null);
  }

  function handleUnlinkGuest(guestId: string) {
    setSettlementMethod(null);
    setLinkedGuestMembers((prev) => {
      const next = { ...prev };
      delete next[guestId];
      return next;
    });
  }

  function handleAddGuest() {
    if (!addFirstName.trim() || !addLastName.trim()) return;
    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: addFirstName.trim(),
        lastName: addLastName.trim(),
        ageTier: addAgeTier,
        isMember: false,
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
    setAddFirstName("");
    setAddLastName("");
    setShowAddForm(false);
  }

  function handleAddFamilyMember(familyMember: FamilyMember) {
    const alreadyAdded = booking.guests.some((guest) => guest.memberId === familyMember.id)
      || addedGuests.some((guest) => guest.memberId === familyMember.id);
    if (alreadyAdded) {
      return;
    }

    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: familyMember.firstName,
        lastName: familyMember.lastName,
        ageTier: familyMember.ageTier,
        isMember: true,
        memberId: familyMember.id,
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
  }

  function handleAddPartnerCandidate(candidate: PartnerSharingCandidate) {
    const alreadyAdded = booking.guests.some((guest) => guest.memberId === candidate.id)
      || addedGuests.some((guest) => guest.memberId === candidate.id);
    if (alreadyAdded) {
      return;
    }

    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        ageTier: "ADULT" as AgeTier,
        isMember: true,
        memberId: candidate.id,
        partnerSharedWithMemberId: candidate.partnerOfMemberId,
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
  }

  /**
   * Add a member the booker (or an officer) found through MG3's finder.
   *
   * THE INVALIDATION LIST IS THE FAMILY QUICK-ADD'S, and it has to be: a member
   * guest changes the party in exactly the same ways a family member does — it
   * prices at member rates, counts toward the group discount, and can collide on
   * person-nights — so it must reset exactly the same derived state. The panel's
   * quote is refetched from the serialised payload, so adding the guest is what
   * invalidates it; the promo and the settlement choice are cleared explicitly
   * because neither is recomputed by that refetch.
   *
   * The consent PREDICTION is computed here rather than on the server for the
   * same reason the create wizard computes it: nothing has been written, so
   * there is no row to read. It is undefined when the target is in the booking
   * owner's own family group — a parent CAN type their child's household address
   * into the finder, and a family-scope add is consent-free under D-6, so
   * promising "waiting for Mia to approve" over one would describe an email that
   * is never sent and a hold that does not exist.
   */
  function closeMemberGuestFinder() {
    setMemberGuestFinderOpen(false);
    memberGuestTriggerRef.current?.focus();
  }

  function handleAddMemberGuest(candidate: MemberGuestCandidate) {
    const alreadyAdded =
      booking.guests.some((guest) => guest.memberId === candidate.memberId) ||
      addedGuests.some((guest) => guest.memberId === candidate.memberId);
    if (alreadyAdded) return;

    const memberGuest = booking.memberGuest;
    // THE SHARED PREDICATE, not a second copy of it (MG4 #2309). The panel's
    // first cut inlined the rule here and dropped the admin branch, so an
    // officer on an ask-first club read "Waiting for consent — the bed is held
    // until they answer" beside a card that said the member would be added
    // immediately. Undefined for a family-scope add and for an unknown family
    // list — see `predictMemberGuestConsent` for both. The list is the booking
    // OWNER's on both paths: a member fetches their own family, an officer
    // fetches the booking's `eligible-family`, which is the owner's.
    const consentPreview = memberGuest
      ? predictMemberGuestConsent({
          candidateMemberId: candidate.memberId,
          familyMemberIds: familyMembers.map((member) => member.id),
          familyMembersLoaded,
          approvalRequired: memberGuest.approvalRequired,
          actorKind: booking.viewerRole === "ADMIN" ? "ADMIN" : "MEMBER",
        })
      : undefined;

    setMemberGuestAddError(null);
    setAppliedNewPromo(null);
    setPromoAction({ type: "keep" });
    setSettlementMethod(null);
    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        ageTier: candidate.ageTier,
        isMember: true,
        memberId: candidate.memberId,
        ...(consentPreview
          ? { memberGuestConsentPreview: consentPreview }
          : {}),
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
  }

  function handleRemoveAddedGuest(key: string) {
    setAddedGuests((prev) => prev.filter((g) => g.key !== key));
  }

  // #2266: the shared PromoCodeInput validated (or cleared) a new code.
  function handleNewPromoApplied(result: PromoResult | null) {
    if (promoLocked) return;
    setAppliedNewPromo(result);
    setPrefillPromoCode(undefined);
    if (result?.code) {
      setPromoAction({
        type: "new",
        code: result.code,
        guestIndexes: result.selectedGuestIndexes,
      });
    } else {
      // Cleared: fall back to the stored promo (kept) or no promo at all.
      setPromoAction({ type: "keep" });
    }
  }

  // #2266: a guest-targeted promo's beneficiary indexes are positional over
  // [remaining guests..., added guests...]; changing that list silently
  // re-points them at different people. Reset the applied code instead and let
  // the member re-apply it against the new guest list.
  const promoGuestSetSignature = useMemo(
    () =>
      JSON.stringify([
        booking.guests
          .filter((guest) => !removedGuestIds.has(guest.id))
          .map((guest) => guest.id),
        addedGuests.map((guest) => guest.key),
      ]),
    [booking.guests, removedGuestIds, addedGuests],
  );
  const appliedPromoGuestSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!(promoAction.type === "new" && promoAction.guestIndexes?.length)) {
      appliedPromoGuestSignatureRef.current = null;
      return;
    }
    if (appliedPromoGuestSignatureRef.current === null) {
      appliedPromoGuestSignatureRef.current = promoGuestSetSignature;
      return;
    }
    if (appliedPromoGuestSignatureRef.current !== promoGuestSetSignature) {
      appliedPromoGuestSignatureRef.current = null;
      setAppliedNewPromo(null);
      setPromoAction({ type: "keep" });
    }
  }, [promoAction, promoGuestSetSignature]);

  // Issue #1696: an admin/booking-officer save goes through the notify dialog
  // first (on EVERY edit, not just overrides); the dialog's two actions call
  // handleSave with the admin's explicit email choice. viewerRole is the same
  // booking-management role the /modify route resolves as actorRole, so the
  // dialog shows exactly when the server will honour the choice. Member
  // self-edits keep the immediate always-notify save.
  const actingAsAdmin = booking.viewerRole === "ADMIN";
  // #2259: read only alongside the admin dialog path below, so a member editing
  // their own booking never renders anything derived from the switch.
  const noEmailsOn = actingAsAdmin && booking.noEmails === true;

  // #2104: does the post-edit guest set (remaining + added) leave minors with no
  // adult? The server (resolveModifyReviewUpdate) only demands a written reason
  // on the FIRST trip, so an already-flagged/reviewed booking never re-prompts.
  const postEditTripsReview = editTripsAdultSupervisionReview([
    ...remainingGuests.map((g) => ({ ageTier: g.ageTier })),
    ...addedGuests.map((g) => ({ ageTier: g.ageTier })),
  ]);
  const bookingAlreadyUnderReview =
    Boolean(booking.requiresAdminReview) && (booking.adminReviewStatus ?? null) !== null;
  // An admin acts through the notify dialog and auto-approves the review, so the
  // field is member-only. serverRequiresJustification covers client/server drift
  // (the reactive REVIEW_JUSTIFICATION_REQUIRED path).
  const showReviewJustification =
    (postEditTripsReview && !actingAsAdmin && !bookingAlreadyUnderReview) ||
    serverRequiresJustification;

  // In the drift case the local predicate is false by definition, so the latch
  // cannot key off it. Instead remember the guest-set signature at latch time:
  // if the member then CHANGES the guests (e.g. re-adds an adult) rather than
  // writing a reason, release the latch so they are not forced to justify a
  // rule the server will no longer apply.
  const guestSetSignature = useMemo(
    () =>
      JSON.stringify([
        remainingGuests.map((g) => g.id),
        addedGuests.map((g) => [g.firstName, g.lastName, g.ageTier]),
      ]),
    [remainingGuests, addedGuests],
  );
  const latchedGuestSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!serverRequiresJustification) {
      latchedGuestSignatureRef.current = null;
      return;
    }
    if (latchedGuestSignatureRef.current === null) {
      // Latch just set: remember the guest set and bring the freshly-mounted
      // field into view (the fetch handler ran before it existed in the DOM).
      latchedGuestSignatureRef.current = guestSetSignature;
      scrollToError(reviewJustificationRef);
      return;
    }
    if (latchedGuestSignatureRef.current !== guestSetSignature) {
      setServerRequiresJustification(false);
      setReviewJustificationError("");
      latchedGuestSignatureRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRequiresJustification, guestSetSignature]);

  function handleSaveClick() {
    if (actingAsAdmin) {
      setNotifyDialogOpen(true);
      return;
    }
    void handleSave();
  }

  /**
   * Send the exception request the current refusal opened the door to (#2562).
   *
   * The delta is the SAME payload the refused quote or save sent, narrowed by
   * `exceptionRequestPayloadFromModification` to the five fields a proposal is
   * made of. Narrowed rather than rebuilt, so the proposal an officer freezes is
   * the change that was actually refused; the fields a proposal cannot carry are
   * named to the member on the card before they submit.
   *
   * Throws an Error carrying the server's own sentence, plus its `code` where it
   * sent one, so the card can name the right next step for the two 409s whose
   * remedy is not "try again".
   */
  async function submitExceptionRequest(input: {
    memberMessage: string;
    supersedeRequestId: string | null;
  }): Promise<ExceptionRequestSubmitResult> {
    const { payload } = exceptionRequestPayloadFromModification(
      buildModificationPayload(),
    );
    const res = await fetch(`/api/bookings/${booking.id}/exception-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        memberMessage: input.memberMessage,
        supersedeRequestId: input.supersedeRequestId ?? undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const failure = new Error(
        typeof data?.error === "string" && data.error
          ? data.error
          : "The request could not be sent. Try again.",
      ) as Error & { code?: string };
      if (typeof data?.code === "string") failure.code = data.code;
      throw failure;
    }
    return {
      id: String(data.id),
      proposal: data.proposal,
      capacityHeld: data.capacityHeld === true,
    };
  }

  async function handleSave(notifyMemberChoice?: boolean) {
    setSaveError("");
    // #2104: block submission with an inline error adjacent to the field (not the
    // bottom saveError slot) when a required justification is missing, and bring
    // the field into view.
    if (showReviewJustification && !memberReviewJustification.trim()) {
      setReviewJustificationError(
        "Please add a reason so an admin can review this booking.",
      );
      scrollToError(reviewJustificationRef);
      return;
    }
    if (quote?.settlementOptions?.requiresSettlementMethod && !settlementMethod) {
      setSaveError("Choose a refund or account credit before saving");
      return;
    }
    setSaving(true);
    // A fresh save attempt retires the previous refusal's offer (#2562).
    setExceptionOffer(null);

    try {
      const body = buildModificationPayload();
      // #2104: attach the justification only when the field is shown (a member
      // trip). buildModificationPayload is shared with the change-request POST,
      // so the field is added here in handleSave, never in that builder.
      if (showReviewJustification) {
        body.memberReviewJustification =
          memberReviewJustification.trim() || undefined;
      }
      if (settlementMethod) {
        body.settlementMethod = settlementMethod;
      }
      // Issue #1696: send the admin's email choice on every admin edit, not just
      // overrides. notifyMemberChoice is only defined on the admin (dialog) path;
      // a member self-edit calls handleSave() with no argument and never sets it.
      if (notifyMemberChoice !== undefined) {
        body.notifyMember = notifyMemberChoice;
      }

      const res = await fetch(`/api/bookings/${booking.id}/modify`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        // #2104: the server tripped the no-adult review rule but the local
        // predicate missed it (client/server drift). Reveal the justification
        // field, show the message adjacent to it, and bring it into view.
        if (data.code === "REVIEW_JUSTIFICATION_REQUIRED") {
          // The effect keyed on serverRequiresJustification scrolls/focuses the
          // field after it mounts on the next commit.
          setServerRequiresJustification(true);
          setReviewJustificationError(
            data.error ||
              "Please add a reason so an admin can review this booking.",
          );
          return;
        }
        // Belt-and-braces (#1668): a stale quote can miss an over-capacity
        // target the apply then rejects. Re-surface the confirm flow.
        if (data.code === "OVER_CAPACITY_CONFIRM_REQUIRED") {
          setSaveOverCapacityNights(
            Array.isArray(data.nightDetails) ? data.nightDetails : [],
          );
          setConfirmOverCapacity(false);
          setSaveError(
            data.error ??
              "These nights are over lodge capacity. Confirm the override to proceed.",
          );
          return;
        }
        // #2363: the save path now hard-blocks a member whose edited dates
        // break a minimum-stay rule, and the 400 carries the frozen review.
        // Surface the rule itself rather than the bare prose so the member can
        // see which nights and which policy stopped the change — the advisory
        // banner above may be stale, or absent entirely if the quote never ran.
        if (data.code === "MINIMUM_STAY_VIOLATION") {
          const violationMessages: string[] = Array.isArray(data.violations)
            ? (data.violations as Array<{ message?: unknown }>)
                .map((violation) => violation?.message)
                .filter((message): message is string => typeof message === "string")
            : [];
          setSaveError(
            violationMessages.length > 0
              ? `These dates do not meet the minimum-stay rules, so the change was not saved. ${violationMessages.join(" ")}`
              : data.error ||
                  "These dates do not meet the minimum-stay rules, so the change was not saved.",
          );
          // #2562: this refusal is exactly what the workflow exists for, so offer
          // the request — subject, as always, to the shared rule's own gates.
          setExceptionOffer(readExceptionOffer(data));
          return;
        }
        setSaveError(data.error || "Failed to save changes");
        // Every other refusal goes through the same shared rule, which answers null
        // for all of them: the reviewable codes are an explicit allowlist and no
        // hard-stop code is on it.
        setExceptionOffer(readExceptionOffer(data));
        return;
      }

      setSaveOverCapacityNights(null);

      // #2390: same shape as the stale-quote handling above, for the same
      // reason — the preview and the apply can disagree, and the member must
      // hear it here rather than from the invoice. Only when it differs from
      // the sentence they already read before pressing Save; an unchanged
      // notice is not news and should not hold the panel open.
      const savedCoverageMessage =
        typeof data?.promoCoverage?.message === "string"
          ? (data.promoCoverage.message as string)
          : null;
      if (
        savedCoverageMessage &&
        savedCoverageMessage !== (quote?.promoCoverage?.message ?? null)
      ) {
        setSavedPromoCoverage(savedCoverageMessage);
        router.refresh();
        return;
      }

      router.refresh();
      onDone();
    } catch {
      setSaveError("Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmitChangeRequest() {
    setRequestError("");
    setRequestSuccess("");
    setRequestSubmitting(true);

    try {
      const body = buildModificationPayload();
      if (!hasChanges) {
        body.requestedEffectiveDate =
          previousDateOnly(booking.editPolicy.editableFrom) ?? today;
      }

      const res = await fetch(`/api/bookings/${booking.id}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          reason: requestReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRequestError(data.error || "Failed to submit request");
        return;
      }

      setRequestReason("");
      setRequestSuccess("Request sent to admins");
    } catch {
      setRequestError("Failed to submit request");
    } finally {
      setRequestSubmitting(false);
    }
  }

  function isLockedChangeError(message: string) {
    return /locked|in-progress|check-in cannot be changed/i.test(message);
  }

  const totalGuestCount = totalGuestCountCandidate();
  const showChangeRequestPath =
    (booking.editPolicy.mode === "in-progress" && !hasChanges) ||
    (hasChanges &&
      (booking.editPolicy.mode === "future" ||
        booking.editPolicy.mode === "in-progress") &&
      (isLockedChangeError(quoteError) || isLockedChangeError(saveError)));
  const settlementRequired = quote?.settlementOptions?.requiresSettlementMethod ?? false;

  // Issue #1668: over-capacity under an admin override is a confirmable warning,
  // not a hard block. The signal can come from the quote (preview) or from a
  // stale-quote apply 409 (saveOverCapacityNights).
  const overCapacityConfirmActive =
    Boolean(quote?.overCapacityConfirmRequired) || Boolean(saveOverCapacityNights);
  const overCapacityNightList = (
    quote?.overCapacityConfirmRequired
      ? quote.nightDetails ?? []
      : saveOverCapacityNights ?? []
  ).filter((night) => night.availableBeds < 0);
  const capacityOk = quote
    ? overCapacityConfirmActive
      ? confirmOverCapacity
      : quote.capacityAvailable
    : false;
  const showQuoteSummary = Boolean(
    quote && (quote.capacityAvailable || (overCapacityConfirmActive && confirmOverCapacity)),
  );

  return (
    <div className="space-y-6">
      {/* Admin override (issue #1668) */}
      {adminOverrideAvailable && (
        <Card className="border-warning-6">
          <CardHeader>
            <CardTitle>Admin override</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={overrideEnabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setOverrideEnabled(enabled);
                  if (enabled) {
                    // An override edit is date-only: discard any pending guest,
                    // range, night, or promo edits so what the cards show is
                    // what the save will send — a stacked edit would otherwise
                    // be silently dropped by the date-only payload. Ranges and
                    // night sets go back to their stored seeds (not {}), so a
                    // later grid edit still sees each guest's real gaps.
                    setRemovedGuestIds(new Set());
                    setAddedGuests([]);
                    setGuestNameEdits({});
                    setExistingGuestRanges(seedExistingGuestRanges());
                    setExistingGuestNights(seedExistingGuestNights());
                    setPromoAction({ type: "keep" });
                    setAppliedNewPromo(null);
                    setPrefillPromoCode(undefined);
                    // #2266: credit is not part of a date-only override edit —
                    // restore the stored election's state.
                    setUseCredit(storedElectionCents > 0);
                    setCreditTouched(false);
                    setShowAddForm(false);
                  } else {
                    setOverridePricingMode(null);
                    setConfirmOverCapacity(false);
                    setSaveOverCapacityNights(null);
                  }
                }}
                className="mt-1 h-4 w-4"
              />
              <span>
                <span className="font-medium">
                  Move locked/past dates (admin override)
                </span>
                <span className="block text-muted-foreground">
                  Bypasses the member-facing date locks so you can move an
                  in-progress or fully-past booking. This is date-only and
                  audited — any pending guest or promo edits are cleared when
                  you turn it on. Choose how pricing is handled below.
                </span>
              </span>
            </label>

            {overrideEnabled && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p className="font-medium">How should pricing be handled?</p>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="overridePricingMode"
                    value="shift"
                    checked={overridePricingMode === "shift"}
                    onChange={() => {
                      setOverridePricingMode("shift");
                      setConfirmOverCapacity(false);
                      setSaveOverCapacityNights(null);
                    }}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">Shift dates only</span> — keep
                    the current price, payments and invoices.
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="overridePricingMode"
                    value="recalculate"
                    checked={overridePricingMode === "recalculate"}
                    onChange={() => {
                      setOverridePricingMode("recalculate");
                      setConfirmOverCapacity(false);
                      setSaveOverCapacityNights(null);
                    }}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">Recalculate price</span> —
                    reprice the new nights and settle the difference (a change
                    fee may apply).
                  </span>
                </label>
                {!overridePricingMode && (
                  <p className="text-warning-11">
                    Choose a pricing mode to preview the change.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Dates */}
      <Card>
        <CardHeader>
          <CardTitle>Dates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="edit-checkin">Check-in</Label>
              <Input
                id="edit-checkin"
                type="date"
                value={checkIn}
                min={overrideEnabled ? undefined : today}
                disabled={checkInLocked}
                onChange={(e) => handleCheckInChange(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-checkout">Check-out</Label>
              <Input
                id="edit-checkout"
                type="date"
                value={checkOut}
                min={isInProgressEdit ? minEditableDate : checkIn || today}
                onChange={(e) => handleCheckOutChange(e.target.value)}
              />
            </div>
          </div>
          {checkIn !== booking.checkIn || checkOut !== booking.checkOut ? (
            <p className="text-sm text-muted-foreground mt-2">
              Originally: {booking.checkIn} to {booking.checkOut}
            </p>
          ) : null}
          {shiftMode ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Shift keeps this {originalNights}-night stay the same length — the
              price stays exactly as booked.
            </p>
          ) : null}
          {isInProgressEdit ? (
            <div className="mt-2 space-y-1 text-sm text-warning-11">
              <p>
                Your stay has started, so the check-in date stays fixed — you
                can extend your check-out night by night from {minEditableDate}{" "}
                onward.
              </p>
              <p>
                Minimum-stay rules apply to your whole stay, not just the added
                nights. Nights up to today can only be changed by an admin.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Guests */}
      <Card>
        <CardHeader>
          {/*
            TWO BUTTONS, member-guest first - owner sign-off, 1 Aug 2026, and the
            wizard's exact header shape (`guest-form.tsx` renders the same pair,
            with `headerActions` before its own non-member button). A member
            guest leads because it is the cheaper, better-recorded outcome and
            should be the one that catches the eye.

            MODULE OFF: the member-guest button is ABSENT - not disabled, and
            with nothing in its place - and the non-member button stays exactly
            where it was. That is what the wizard does, and it is what keeps a
            club that never adopted the feature looking untouched.
          */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Guests ({totalGuestCount})</CardTitle>
            <div className="flex flex-wrap gap-2">
              {booking.memberGuest?.enabled && !overrideEnabled ? (
                // NOT capacity-disabled, deliberately — see the `atCapacity`
                // note on the finder below. The panel holds no capacity signal
                // that is true of the CURRENT party before a quote exists, and
                // an over-capacity add is refused by the quote with a reason
                // rather than by a silent grey button.
                <Button
                  ref={memberGuestTriggerRef}
                  type="button"
                  variant={memberGuestFinderOpen ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setMemberGuestFinderOpen((open) => !open)}
                >
                  + Add Member Guest
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddForm(true)}
                disabled={showAddForm || overrideEnabled}
              >
                {isInProgressEdit
                  ? "+ Add Future Non-Member Guest"
                  : "+ Add Non-Member Guest"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {/*
            The finder, INLINE in the card content directly under the header -
            the wizard's `belowHeader` slot, in the surface that has no such
            slot. Gated on the server's module answer (never guessed here) AND
            on `!overrideEnabled`, which matches both quick-add blocks below for
            the reason they have it: an admin date-override edit is date-only by
            construction, so growing a guest surface on it would offer a change
            the override path does not carry.

            No `isInProgressEdit` gate, deliberately - an in-progress edit can
            still add a future guest, and a member guest is no different from
            any other addition there.
          */}
          {booking.memberGuest?.enabled &&
          !overrideEnabled &&
          memberGuestFinderOpen ? (
            <EditMemberGuestFinder
              bookingId={booking.id}
              actingAsAdmin={booking.viewerRole === "ADMIN"}
              openSearchEnabled={booking.memberGuest.openSearchEnabled}
              approvalRequired={booking.memberGuest.approvalRequired}
              existingMemberIds={[
                ...remainingGuests
                  .map((guest) => guest.memberId)
                  .filter((id): id is string => Boolean(id)),
                ...addedGuests
                  .map((guest) => guest.memberId)
                  .filter((id): id is string => Boolean(id)),
              ]}
              /*
                ALWAYS FALSE, AND THAT IS THE HONEST ANSWER HERE (MG4 #2309).
                The prop means "the party is already at the lodge's capacity, so
                do not let another person be selected", and this panel has no
                signal that answers it. `quote.capacityAvailable` is the wrong
                one twice over: it exists only once the booker has made a change
                (there is no quote on an untouched panel, which is exactly when
                the finder is first opened), and it describes the PROPOSED party
                — including the very guest just added — rather than the current
                one, so a false there would disable the control that caused it.
                Fetching lodge capacity separately would be a second source of
                truth for a rule the quote already enforces.

                WHERE THE REFUSAL SURFACES INSTEAD: the modify-quote round trip.
                An over-capacity add comes back as a quote refusal and is shown
                in the panel's error line, and the over-capacity confirm flow
                (#1668) covers the admin case. A greyed-out button with no
                explanation would be strictly worse than a clear refusal.
              */
              atCapacity={false}
              addError={memberGuestAddError}
              refusedCandidate={memberGuestAddError ? lastMemberGuestAttempt : null}
              onAdd={(candidate) => {
                setLastMemberGuestAttempt(candidate);
                handleAddMemberGuest(candidate);
                closeMemberGuestFinder();
              }}
              onCancel={closeMemberGuestFinder}
            />
          ) : null}
          {/*
            #2337: the SAME member finder, reused to link a placeholder to a
            member rather than to add a new guest. `linkFinderGuestId` names the
            placeholder row that opened it; the chosen candidate becomes that
            row's member identity, and the panel re-quotes to show the re-rate.
          */}
          {memberLinkEnabled && linkFinderGuestId ? (
            <EditMemberGuestFinder
              bookingId={booking.id}
              actingAsAdmin
              openSearchEnabled={booking.memberGuest?.openSearchEnabled ?? false}
              approvalRequired={booking.memberGuest?.approvalRequired ?? false}
              existingMemberIds={[
                ...remainingGuests
                  .map((guest) => guest.memberId)
                  .filter((id): id is string => Boolean(id)),
                ...addedGuests
                  .map((guest) => guest.memberId)
                  .filter((id): id is string => Boolean(id)),
                ...Object.values(linkedGuestMembers).map(
                  (candidate) => candidate.memberId,
                ),
              ]}
              atCapacity={false}
              addError={null}
              refusedCandidate={null}
              onAdd={(candidate) =>
                handleLinkGuestToMember(linkFinderGuestId, candidate)
              }
              onCancel={() => setLinkFinderGuestId(null)}
            />
          ) : null}
          {isInProgressEdit ? (
            <p className="text-sm text-muted-foreground">
              Added guests start on {minEditableDate}. Removing an existing
              guest keeps their past and NZ today occupancy and removes only
              future nights.
            </p>
          ) : null}
          {familyMembers.length > 0 && !overrideEnabled && (
            <div className="space-y-2 rounded-md border border-dashed p-3">
              <p className="text-sm font-medium text-muted-foreground">Quick add family members</p>
              <div className="flex flex-wrap gap-2">
                {familyMembers.map((familyMember) => {
                  const alreadyAdded = booking.guests.some((guest) => guest.memberId === familyMember.id)
                    || addedGuests.some((guest) => guest.memberId === familyMember.id);
                  const label = familyMember.relationship === "self"
                    ? `${familyMember.firstName} ${familyMember.lastName}`
                    : `${familyMember.firstName} ${familyMember.lastName} (${getAgeTierLabel(ageTierOptions, familyMember.ageTier)})`;

                  return (
                    <Button
                      key={familyMember.id}
                      type="button"
                      variant={alreadyAdded ? "secondary" : familyMember.relationship === "self" ? "default" : "outline"}
                      size="sm"
                      disabled={alreadyAdded}
                      onClick={() => handleAddFamilyMember(familyMember)}
                    >
                      {alreadyAdded ? "\u2713 " : "+ "}
                      {label}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {partnerCandidates.length > 0 && !overrideEnabled && (
            <div className="space-y-2 rounded-md border border-dashed p-3">
              <p className="text-sm font-medium text-muted-foreground">
                Add a partner (shares a double bed)
              </p>
              <div className="flex flex-wrap gap-2">
                {partnerCandidates.map((candidate) => {
                  const alreadyAdded = booking.guests.some((guest) => guest.memberId === candidate.id)
                    || addedGuests.some((guest) => guest.memberId === candidate.id);
                  return (
                    <Button
                      key={candidate.id}
                      type="button"
                      variant={alreadyAdded ? "secondary" : "outline"}
                      size="sm"
                      disabled={alreadyAdded}
                      onClick={() => handleAddPartnerCandidate(candidate)}
                    >
                      {alreadyAdded ? "\u2713 " : "+ "}
                      {candidate.firstName} {candidate.lastName} \u2014 partner of {candidate.partnerOfName}
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                A partner can be added even when the lodge is full by beds:
                they use a reserved double-bed slot (one per double) and must
                then be placed as the second occupant on the allocation board.
              </p>
            </div>
          )}

          {canEditPerGuestDates && !multiDateRangesEnabled ? (
            <label className="flex items-center gap-2 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={perGuestDatesEnabled}
                onChange={(e) => setPerGuestDatesEnabled(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="font-medium">Per guest booking dates</span>
            </label>
          ) : null}

          {!isInProgressEdit && !overrideEnabled ? (
            <div className="space-y-3 rounded-md border p-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={multiDateRangesEnabled}
                  onChange={(e) => {
                    setMultiDateRangesEnabled(e.target.checked);
                    if (e.target.checked) setPerGuestDatesEnabled(false);
                  }}
                  className="h-4 w-4"
                />
                <span className="font-medium">Multiple date ranges</span>
              </label>
              {multiDateRangesEnabled ? (
                <GuestNightGrid
                  guestLabels={[
                    ...remainingGuests.map(
                      (g) => `${g.firstName} ${g.lastName}`.trim(),
                    ),
                    ...addedGuests.map(
                      (g, i) =>
                        `${g.firstName} ${g.lastName}`.trim() ||
                        `New guest ${i + 1}`,
                    ),
                  ]}
                  nights={eachNightKey(checkIn, checkOut)}
                  isNightOn={(rowIndex, nightKey) => {
                    if (rowIndex < remainingGuests.length) {
                      const guest = remainingGuests[rowIndex];
                      const set = existingGuestNights[guest.id];
                      return set ? set.includes(nightKey) : true;
                    }
                    const added = addedGuests[rowIndex - remainingGuests.length];
                    return added?.nights ? added.nights.includes(nightKey) : true;
                  }}
                  onToggle={(rowIndex, nightKey) => {
                    const toggle = (current: string[]) =>
                      current.includes(nightKey)
                        ? current.filter((key) => key !== nightKey)
                        : [...current, nightKey].sort();
                    if (rowIndex < remainingGuests.length) {
                      const guest = remainingGuests[rowIndex];
                      setExistingGuestNights((prev) => {
                        const base =
                          prev[guest.id] ?? eachNightKey(checkIn, checkOut);
                        const next = toggle(base);
                        if (next.length === 0) return prev;
                        return { ...prev, [guest.id]: next };
                      });
                    } else {
                      const addedIndex = rowIndex - remainingGuests.length;
                      setAddedGuests((prev) =>
                        prev.map((g, i) => {
                          if (i !== addedIndex) return g;
                          const base = g.nights ?? eachNightKey(checkIn, checkOut);
                          const next = toggle(base);
                          if (next.length === 0) return g;
                          return { ...g, nights: next };
                        }),
                      );
                    }
                  }}
                  arrivalLabel={checkIn}
                  departureLabel={checkOut}
                />
              ) : null}
            </div>
          ) : null}

          {/* Existing guests */}
          {booking.guests.map((guest) => {
            const isRemoved = removedGuestIds.has(guest.id);
            // #2337: this placeholder's pending member link, if any.
            const linkedMember = linkedGuestMembers[guest.id];
            const isLinked = Boolean(linkedMember);
            // Only an unlinked, unremoved placeholder on a member whole-lodge
            // booking may be linked — the same fence the server enforces.
            const canLinkGuest =
              memberLinkEnabled && !guest.isMember && !isRemoved && !isLinked;
            const canEditGuestName =
              nonMemberGuestNamesEditable &&
              !guest.isMember &&
              !isRemoved &&
              !isLinked &&
              !overrideEnabled;
            // Fully paid: the field is open only for a spelling correction; a
            // change of who the booking is for must go through the office (#1386).
            const showTypoOnlyHint =
              canEditGuestName &&
              !booking.canEditNonMemberGuestNames &&
              booking.canFixNonMemberGuestNameTypos;
            const nameEdit = getGuestNameEdit(guest);
            return (
              <div
                key={guest.id}
                className={`flex items-center justify-between py-2 ${
                  isRemoved ? "opacity-40 line-through" : ""
                }`}
              >
                <div>
                  {canEditGuestName ? (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-first`} className="text-xs">
                          First Name
                        </Label>
                        <Input
                          id={`guest-${guest.id}-first`}
                          value={nameEdit.firstName}
                          onChange={(e) =>
                            updateGuestName(guest.id, "firstName", e.target.value)
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-last`} className="text-xs">
                          Last Name
                        </Label>
                        <Input
                          id={`guest-${guest.id}-last`}
                          value={nameEdit.lastName}
                          onChange={(e) =>
                            updateGuestName(guest.id, "lastName", e.target.value)
                          }
                        />
                      </div>
                      {showTypoOnlyHint ? (
                        <p className="col-span-2 text-xs text-muted-foreground">
                          Only spelling corrections are allowed after payment.
                          To change who this booking is for, contact the office.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="font-medium">
                      {guest.firstName} {guest.lastName}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {getAgeTierLabel(ageTierOptions, guest.ageTier)} &middot; {guest.isMember ? "Member" : "Non-member"}
                  </p>
                  {/* #2337: what saving this link will do, before it is saved. */}
                  {isLinked ? (
                    <p className="text-sm text-success-11">
                      Linking to {linkedMember.firstName} {linkedMember.lastName} —
                      re-rated at the member rate. The price change is shown below
                      before you save.
                    </p>
                  ) : null}
                  {/*
                    MG4 (#2309): the two helper sentences the signed-off mockup
                    draws under a member-guest row, and the reason they are not
                    decoration. The first tells the booker what pressing the
                    control WILL DO before they press it — a still-unanswered
                    request is withdrawn, the person is told, and the bed they
                    were holding goes back — which is a different act from
                    taking a settled guest off, and the person on the other end
                    gets a different email for each. The second states both
                    halves of MG4-D-a on a row the club placed, including the
                    half an officer is most likely to assume away: the member
                    was not asked, and they were told anyway.
                  */}
                  {!isRemoved && renderExistingGuestConsentHelper(guest)}
                  {(guest.stayStart && guest.stayStart !== booking.checkIn) ||
                  (guest.stayEnd && guest.stayEnd !== booking.checkOut) ? (
                    <p className="text-xs text-muted-foreground">
                      Stay: {guest.stayStart ?? booking.checkIn} to{" "}
                      {guest.stayEnd ?? booking.checkOut}
                    </p>
                  ) : null}
                  {perGuestDatesEnabled && !isRemoved && !overrideEnabled ? (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-stay-start`} className="text-xs">
                          Date In
                        </Label>
                        <Input
                          id={`guest-${guest.id}-stay-start`}
                          type="date"
                          value={getExistingGuestRange(guest).stayStart}
                          min={checkIn}
                          max={shiftDateOnly(getExistingGuestRange(guest).stayEnd, -1)}
                          onChange={(e) =>
                            updateExistingGuestRange(guest.id, "stayStart", e.target.value)
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-stay-end`} className="text-xs">
                          Date Out
                        </Label>
                        <Input
                          id={`guest-${guest.id}-stay-end`}
                          type="date"
                          value={getExistingGuestRange(guest).stayEnd}
                          min={shiftDateOnly(getExistingGuestRange(guest).stayStart, 1)}
                          max={checkOut}
                          onChange={(e) =>
                            updateExistingGuestRange(guest.id, "stayEnd", e.target.value)
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm">{formatCents(guest.priceCents)}</span>
                  {/* #2337: link an unnamed placeholder to a member (admin, member
                      whole-lodge only). Unlink reverts to the placeholder. */}
                  {isLinked ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleUnlinkGuest(guest.id)}
                    >
                      Unlink
                    </Button>
                  ) : canLinkGuest ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setLinkFinderGuestId(guest.id)}
                    >
                      Link to member
                    </Button>
                  ) : null}
                  {isRemoved ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleUndoRemoveGuest(guest.id)}
                    >
                      Undo
                    </Button>
                  ) : (
                    !overrideEnabled &&
                    remainingGuests.length + addedGuests.length > 1 && (
                      /*
                        DECLARED DIVERGENCE FROM THE SIGNED-OFF MOCKUP (MG4
                        #2309), recorded here and stated to the owner in the PR
                        rather than left for a reader to notice.

                        The mockup draws TWO controls on an unanswered row —
                        "Cancel request", which notifies, beside a plain
                        "Remove", which does not. This ships ONE control that
                        always notifies. A non-notifying Remove on a PENDING row
                        would be a silent-disappearance path: the member has an
                        email in their inbox asking them a question, a bed is
                        held in their name, and the row would vanish with no
                        word to them at all. That directly contradicts the
                        plan's own §7.1 trigger, which owes a withdrawal notice
                        for "a still-PENDING request cancelled by the booker or
                        an admin", and it would leave the one population the
                        epic exists to protect worse off than before.

                        What the mockup's second control was really buying — the
                        booker understanding what the first one does — is
                        delivered by the helper sentence above instead.
                      */
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger-11 hover:text-danger-11"
                        onClick={() => handleRemoveGuest(guest.id)}
                      >
                        {guest.consent?.tone === "pending"
                          ? "Cancel request"
                          : isInProgressEdit
                            ? "Remove Future"
                            : "Remove"}
                      </Button>
                    )
                  )}
                </div>
              </div>
            );
          })}

          {/* Newly added guests */}
          {addedGuests.map((guest) => (
            <div key={guest.key} className="flex items-center justify-between py-2 bg-success-3 rounded px-2">
              <div>
                <p className="font-medium">
                  {guest.firstName} {guest.lastName}
                  <span className="ml-2 text-xs text-success-11 font-normal">NEW</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {getAgeTierLabel(ageTierOptions, guest.ageTier)} &middot; {guest.isMember ? "Member" : "Non-member"}
                </p>
                {/*
                  MG4 (#2309): what saving will do to this person's consent,
                  before the booker saves. Rendered from the SHARED badge
                  function so the wording here and on the booking page after the
                  save cannot drift, and only for a cross-family member guest —
                  every other added row is byte-identical to before.
                */}
                {renderAddedGuestConsent(guest)}
                {perGuestDatesEnabled ? (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor={`added-${guest.key}-stay-start`} className="text-xs">
                        Date In
                      </Label>
                      <Input
                        id={`added-${guest.key}-stay-start`}
                        type="date"
                        value={guest.stayStart ?? checkIn}
                        min={checkIn}
                        max={shiftDateOnly(guest.stayEnd ?? checkOut, -1)}
                        onChange={(e) =>
                          updateAddedGuestRange(guest.key, "stayStart", e.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`added-${guest.key}-stay-end`} className="text-xs">
                        Date Out
                      </Label>
                      <Input
                        id={`added-${guest.key}-stay-end`}
                        type="date"
                        value={guest.stayEnd ?? checkOut}
                        min={shiftDateOnly(guest.stayStart ?? checkIn, 1)}
                        max={checkOut}
                        onChange={(e) =>
                          updateAddedGuestRange(guest.key, "stayEnd", e.target.value)
                        }
                      />
                    </div>
                  </div>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-danger-11 hover:text-danger-11"
                onClick={() => handleRemoveAddedGuest(guest.key)}
              >
                Remove
              </Button>
            </div>
          ))}

          {/* Add guest inline form */}
          {showAddForm && (
            <div className="border rounded-md p-3 mt-2 space-y-3 bg-card">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="new-guest-first">First Name</Label>
                  <Input
                    id="new-guest-first"
                    value={addFirstName}
                    onChange={(e) => setAddFirstName(e.target.value)}
                    placeholder="First name"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-guest-last">Last Name</Label>
                  <Input
                    id="new-guest-last"
                    value={addLastName}
                    onChange={(e) => setAddLastName(e.target.value)}
                    placeholder="Last name"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="new-guest-age">Age Category</Label>
                  <select
                    id="new-guest-age"
                    value={addAgeTier}
                    onChange={(e) => setAddAgeTier(e.target.value as AgeTier)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  >
                    {ageTierOptions.map((option) => (
                      <option key={option.tier} value={option.tier}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Typed-in guests are always treated as non-members and charged at non-member rates.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleAddGuest}
                  disabled={!addFirstName.trim() || !addLastName.trim()}
                >
                  Add
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowAddForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Promo Code */}
      {!promoLocked && (
      <Card>
        <CardHeader>
          <CardTitle>Promo Code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {booking.promo && promoAction.type === "keep" && (
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-success-11">
                  {booking.promo.workPartyEventName
                    ? `Working bee: ${booking.promo.workPartyEventName}`
                    : booking.promo.code}
                </span>
                {booking.promo.description && !booking.promo.workPartyEventName && (
                  <span className="text-sm text-muted-foreground ml-2">{booking.promo.description}</span>
                )}
                <span className={`text-sm ml-2 ${booking.promoAdjustmentCents > 0 ? "text-warning-11" : "text-success-11"}`}>
                  ({formatSignedCents(booking.promoAdjustmentCents)})
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-danger-11 hover:text-danger-11"
                onClick={() => setPromoAction({ type: "remove" })}
              >
                Remove
              </Button>
            </div>
          )}

          {promoAction.type === "remove" && booking.promo && (
            <div className="flex items-center justify-between text-muted-foreground">
              <div>
                <span className="line-through">
                  {booking.promo.workPartyEventName
                    ? `Working bee: ${booking.promo.workPartyEventName}`
                    : booking.promo.code}
                </span>
                <span className="text-sm ml-2">(will be removed - available for reuse)</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPromoAction({ type: "keep" })}
              >
                Undo
              </Button>
            </div>
          )}

          {/* #2266: entry area — eligible-code chips plus the shared
              PromoCodeInput (validation, guest selection, applied display),
              replacing the old blind text field. Shown whenever a new code may
              be entered, and while one is applied (the input renders the
              applied chip itself). */}
          {(promoAction.type === "remove" ||
            promoAction.type === "new" ||
            (!booking.promo && promoAction.type === "keep")) && (
            <div className="space-y-3">
              {availablePromoCodes.length > 0 && !appliedNewPromo && (
                <div className="app-callout-brand p-4">
                  <p className="mb-2 text-sm font-medium text-foreground">
                    You have promo codes available:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {availablePromoCodes.map((pc) => (
                      <button
                        key={pc.code}
                        type="button"
                        onClick={() => setPrefillPromoCode(pc.code)}
                        className="app-chip-brand font-mono"
                      >
                        {pc.code}
                        {pc.description && (
                          <span className="font-sans font-normal text-brand-charcoal">
                            — {pc.description}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <PromoCodeInput
                checkIn={checkIn}
                checkOut={checkOut}
                guests={[
                  ...remainingGuests.map((g) => ({
                    firstName: g.firstName,
                    lastName: g.lastName,
                    ageTier: g.ageTier,
                    isMember: g.isMember,
                    memberId: g.memberId ?? undefined,
                    ...(perGuestDatesEnabled && !isInProgressEdit
                      ? getExistingGuestRange(g)
                      : {}),
                  })),
                  ...addedGuests.map((g) => ({
                    firstName: g.firstName,
                    lastName: g.lastName,
                    ageTier: g.ageTier as string,
                    isMember: g.isMember,
                    memberId: g.memberId,
                    ...(perGuestDatesEnabled &&
                    !isInProgressEdit &&
                    g.stayStart &&
                    g.stayEnd
                      ? { stayStart: g.stayStart, stayEnd: g.stayEnd }
                      : {}),
                  })),
                ]}
                onPromoApplied={handleNewPromoApplied}
                appliedPromo={appliedNewPromo}
                forMemberId={
                  booking.viewerRole === "ADMIN" ? booking.memberId : undefined
                }
                lodgeId={booking.lodgeId}
                prefillCode={prefillPromoCode}
              />
              {/* The booking-aware re-validation (modify-quote) can refuse a
                  code the standalone validator accepted (e.g. already redeemed
                  against this booking's dates); surface that honestly. */}
              {promoAction.type === "new" &&
                quote?.promoValidation &&
                !quote.promoValidation.valid && (
                  <p className="text-sm text-danger-11">
                    {quote.promoValidation.error}
                  </p>
                )}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Account credit (#2266). Owner-decided placement: its own card, above
          the Return-method radio (which lives in the Price Summary below). The
          direction tag distinguishes this card (spending credit on the
          booking) from the settlement radio (money coming back to you). The
          checkbox is the create flow's election, stored on the booking (#2265)
          and applied when the member confirms — nothing moves at save time. */}
      {creditCardVisible && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Account credit</CardTitle>
              <span className="rounded-full bg-success-3 px-2 py-0.5 text-xs font-medium text-success-11">
                Credit → booking
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {ledgerAppliedCreditCents > 0 && (
              <p className="text-sm text-muted-foreground">
                {formatCents(ledgerAppliedCreditCents)} of account credit is
                already applied to this booking.
              </p>
            )}
            <p className="text-sm text-success-11">
              {actingAsAdmin ? "The member has" : "You have"}{" "}
              <strong>{formatCents(availableCreditCents)}</strong> in account
              credit
            </p>
            {(useCredit ||
              (availableCreditCents > 0 && uncoveredPriceCents > 0)) && (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-success-11">
                <input
                  type="checkbox"
                  checked={useCredit}
                  disabled={
                    !useCredit &&
                    !(availableCreditCents > 0 && uncoveredPriceCents > 0)
                  }
                  onChange={(e) => {
                    setUseCredit(e.target.checked);
                    setCreditTouched(true);
                  }}
                  className="h-4 w-4 rounded border-success-6"
                />
                Apply credit to this booking
              </label>
            )}
            {useCredit && desiredElectionCents > 0 && (
              <p className="text-sm font-medium text-success-11">
                {(() => {
                  const whose = actingAsAdmin
                    ? `The member's ${formatCents(desiredElectionCents)} credit choice`
                    : `Your ${formatCents(desiredElectionCents)} credit choice`;
                  const confirmer = actingAsAdmin ? "they confirm" : "you confirm";
                  return creditChanged || storedElectionCents === 0
                    ? `${whose} will be saved with these changes and applied when ${confirmer}.`
                    : `${whose} is saved and will be applied when ${confirmer}.`;
                })()}
              </p>
            )}
            {useCredit &&
              desiredElectionCents > 0 &&
              desiredElectionCents >= uncoveredPriceCents && (
                <p className="text-sm font-medium text-success-11">
                  Credit covers the entire booking — no card payment needed
                </p>
              )}
            {useCredit && desiredElectionCents === 0 && (
              <p className="text-sm text-warning-11">
                {availableCreditCents === 0
                  ? actingAsAdmin
                    ? "The member's credit balance is currently $0.00, so this choice cannot be applied right now. It will only apply if credit returns to their account before they pay — or untick it."
                    : "Your credit balance is currently $0.00, so this choice cannot be applied right now. It will only apply if credit returns to your account before you pay — or untick it."
                  : "There is nothing left for account credit to cover on this booking."}
              </p>
            )}
            {/* MED-3: an untouched saved election is never rewritten for a
                balance dip — but the member deserves to know the balance is
                currently short of it. The saved choice stays whole; the pay
                step clamps and reports (#2265). */}
            {useCredit &&
              desiredElectionCents > 0 &&
              availableCreditCents < desiredElectionCents && (
                <p className="text-sm text-warning-11">
                  {actingAsAdmin
                    ? `The member's credit balance is currently ${formatCents(availableCreditCents)} — below this saved choice. The choice stays saved in full; only the credit in their account when they pay will be applied.`
                    : `Your credit balance is currently ${formatCents(availableCreditCents)} — below this saved choice. The choice stays saved in full; only the credit in your account when you pay will be applied.`}
                </p>
              )}
          </CardContent>
        </Card>
      )}

      {/* Price Summary */}
      {hasChanges && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Price Summary</CardTitle>
              {quoteLoading && quote && (
                <span className="text-sm font-normal text-muted-foreground">Updating…</span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {quoteLoading && !quote && (
              <p className="text-sm text-muted-foreground">Calculating price changes...</p>
            )}

            {quoteError && (
              <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">{quoteError}</div>
            )}

            {quote && !quote.capacityAvailable && !overCapacityConfirmActive && (
              <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
                <p className="font-medium">
                  {quote.partnerSharedReason ?? "Not enough beds available"}
                </p>
                {quote.nightDetails && (
                  <ul className="mt-1 list-disc pl-4">
                    {quote.nightDetails
                      .filter((n) => n.availableBeds < 0)
                      .map((n) => (
                        <li key={n.date}>
                          {n.date}: {Math.abs(n.availableBeds)} bed(s) short
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}

            {/* #2124: advisory whole-stay minimum-stay warning — an early,
                client-side heads-up that never gates Save. #2363: the hard
                block is on the server. PUT /api/bookings/[id]/modify now
                refuses a non-admin save that breaks the rule and returns the
                frozen review, which handleSave surfaces in the save-error slot
                below; an admin edit (including on-behalf) is not blocked. Save
                stays enabled here on purpose — the server is authoritative, so
                a stale or missing quote can never decide the outcome. */}
            {quote && quote.minimumStayValid === false && (
              <div
                className="rounded-md bg-warning-3 p-3 text-sm text-warning-11"
                role="status"
              >
                <p className="font-medium">
                  This change would leave your stay under a minimum-stay rule
                </p>
                <ul className="mt-1 list-disc pl-4">
                  {(quote.minimumStayViolations ?? []).map((violation, i) => (
                    <li key={i}>{violation.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* #2543 "tell them why": under the club's NON_MEMBER_PRICING mode a
                member on this booking has an unpaid subscription, so their
                nights are re-rated at non-member rates. Said here, above the
                totals, because the New price below is the repriced figure and a
                member who sees it move without explanation reads it as a bug.

                The sentence is the SERVER's, rendered verbatim, and is read
                straight off `quote` rather than copied into its own state — so a
                later quote that returns null (the subscription was paid, or the
                repriced guest was removed from the edit) drops the notice with
                the quote it came from, and a refused or failed quote clears it
                along with everything else via `setQuote(null)`. Gated only on
                `quote`, like the minimum-stay warning beside it, so it survives a
                render where capacity hides the money summary. */}
            {quote?.subscriptionMemberRateNotice ? (
              <div
                className="rounded-md bg-warning-3 p-3 text-sm text-warning-11"
                role="status"
                data-testid="subscription-member-rate-notice"
              >
                {quote.subscriptionMemberRateNotice}
              </div>
            ) : null}

            {overCapacityConfirmActive && (
              <div className="space-y-2 rounded-md bg-warning-3 p-3 text-sm text-warning-11">
                <p className="font-medium">
                  These nights are over lodge capacity
                </p>
                {overCapacityNightList.length > 0 && (
                  <ul className="list-disc pl-4">
                    {overCapacityNightList.map((night) => (
                      <li key={night.date}>
                        {night.date}: {Math.abs(night.availableBeds)} bed(s) over
                      </li>
                    ))}
                  </ul>
                )}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmOverCapacity}
                    onChange={(e) => setConfirmOverCapacity(e.target.checked)}
                    className="mt-1 h-4 w-4"
                  />
                  <span>
                    Book over capacity anyway — I understand this overbooks the
                    lodge.
                  </span>
                </label>
              </div>
            )}

            {showQuoteSummary && quote && (
              <div className="space-y-3">
                {/* Itemized changes */}
                <div className="space-y-1">
                  {quote.itemizedChanges.map((item, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{item.label}</span>
                      <span
                        className={`font-medium ${
                          item.amountCents > 0
                            ? "text-danger-11"
                            : item.amountCents < 0
                              ? "text-success-11"
                              : ""
                        }`}
                      >
                        {item.amountCents > 0 ? "+" : ""}
                        {formatCents(item.amountCents)}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Totals */}
                <div className="border-t pt-2 space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>Current price</span>
                    <span>{formatCents(booking.finalPriceCents)}</span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span>New price</span>
                    <span>{formatCents(quote.newFinalPriceCents)}</span>
                  </div>
                  {/* #2266: the mockup's credit lines — what account credit
                      already covers, what the saved election will cover at
                      confirmation, and what is then left to pay.

                      MED-5 honesty: when this edit reprices the booking below
                      the credit already applied, the server clamps the applied
                      slice to the new price and refunds the excess to the
                      member's balance (F20, #1887) — so the panel shows the
                      CLAMPED figure and says where the excess goes, instead of
                      advertising a credit line the save will not keep.

                      LOW-6: the late-notice change fee rides the invoice /
                      additional charge, so "Remaining to pay" includes it —
                      with its own line so the sum is transparent. */}
                  {(ledgerAppliedCreditCents > 0 ||
                    (useCredit && desiredElectionCents > 0)) &&
                    (() => {
                      const displayedAppliedCreditCents = Math.min(
                        ledgerAppliedCreditCents,
                        quote.newFinalPriceCents,
                      );
                      const creditReturnedCents =
                        ledgerAppliedCreditCents - displayedAppliedCreditCents;
                      return (
                        <>
                          {ledgerAppliedCreditCents > 0 && (
                            <div className="flex justify-between text-sm text-success-11">
                              <span>Account credit applied</span>
                              <span>
                                -{formatCents(displayedAppliedCreditCents)}
                              </span>
                            </div>
                          )}
                          {creditReturnedCents > 0 && (
                            <div className="flex justify-between text-sm text-success-11">
                              <span>
                                {actingAsAdmin
                                  ? `${formatCents(creditReturnedCents)} returns to the member's account credit`
                                  : `${formatCents(creditReturnedCents)} returns to your account credit`}
                              </span>
                              <span />
                            </div>
                          )}
                          {useCredit && desiredElectionCents > 0 && (
                            <div className="flex justify-between text-sm text-success-11">
                              <span>Account credit (when you confirm)</span>
                              <span>-{formatCents(desiredElectionCents)}</span>
                            </div>
                          )}
                          {quote.changeFeeCents > 0 && (
                            <div className="flex justify-between text-sm">
                              <span>Late-notice change fee</span>
                              <span>+{formatCents(quote.changeFeeCents)}</span>
                            </div>
                          )}
                          <div className="flex justify-between font-medium">
                            <span>Remaining to pay</span>
                            <span>
                              {formatCents(
                                Math.max(
                                  0,
                                  quote.newFinalPriceCents -
                                    displayedAppliedCreditCents -
                                    (useCredit ? desiredElectionCents : 0),
                                ) + quote.changeFeeCents,
                              )}
                            </span>
                          </div>
                        </>
                      );
                    })()}
                </div>

                {/* Net charge/refund */}
                {quote.netChargeCents !== 0 && (
                  <div
                    className={`rounded-md p-3 text-sm ${
                      quote.netChargeCents > 0
                        ? "bg-danger-3 text-danger-11"
                        : "bg-success-3 text-success-11"
                    }`}
                  >
                    {quote.netChargeCents > 0 ? (
                      <p className="font-medium">
                        Additional charge: {formatCents(quote.netChargeCents)}
                      </p>
                    ) : (
                      <p className="font-medium">
                        Booking reduction: {formatCents(Math.abs(quote.netChargeCents))}
                      </p>
                    )}
                  </div>
                )}

                {quote.netChargeCents < 0 && quote.settlementOptions && (
                  <div className="space-y-2 rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">Return method</p>
                      {/* #2266: direction tag pairing with the credit card's
                          "Credit → booking" — this section is money coming
                          back to the member. */}
                      <span className="rounded-full bg-info-3 px-2 py-0.5 text-xs font-medium text-info-11">
                        Booking → you
                      </span>
                    </div>
                    {quote.settlementOptions.requiresSettlementMethod ? (
                      <div className="space-y-2">
                        <label className="flex cursor-pointer items-start gap-2">
                          <input
                            type="radio"
                            name="settlementMethod"
                            value="card"
                            checked={settlementMethod === "card"}
                            onChange={() => setSettlementMethod("card")}
                            className="mt-1"
                          />
                          <span>
                            Refund to original card:{" "}
                            <span className="font-medium">
                              {formatCents(quote.settlementOptions.cardRefundAmountCents)}
                            </span>{" "}
                            <span className="text-muted-foreground">
                              ({quote.settlementOptions.cardRefundPercentage}%)
                            </span>
                          </span>
                        </label>
                        <label className="flex cursor-pointer items-start gap-2">
                          <input
                            type="radio"
                            name="settlementMethod"
                            value="credit"
                            checked={settlementMethod === "credit"}
                            onChange={() => setSettlementMethod("credit")}
                            className="mt-1"
                          />
                          <span>
                            Hold as account credit:{" "}
                            <span className="font-medium">
                              {formatCents(quote.settlementOptions.accountCreditAmountCents)}
                            </span>{" "}
                            <span className="text-muted-foreground">
                              ({quote.settlementOptions.accountCreditPercentage}%)
                            </span>
                          </span>
                        </label>
                      </div>
                    ) : (
                      <p className="text-muted-foreground">
                        No refund or account credit is available for this reduction under the current policy.
                      </p>
                    )}
                  </div>
                )}

                {/* Convention for this card (#2390 review): every advisory that
                    appears on its own when a quote comes back — not in response
                    to a click — carries role="status", so a screen-reader user
                    hears it without hunting for it. That covers the
                    minimum-stay notice above and both promo notices here. The
                    over-capacity block is deliberately excluded: it contains
                    the confirm checkbox the member must operate, and announcing
                    a form control as a live status reads as noise. */}
                {!quote.promoStillValid && promoAction.type === "keep" && booking.promo && (
                  <div
                    className="rounded-md bg-warning-3 p-3 text-sm text-warning-11"
                    role="status"
                  >
                    Your promo code &apos;{booking.promo.code}&apos; is no longer valid and will be removed.
                  </div>
                )}

                {/* #2390: the promotion is keeping everyone who already had it
                    and simply not reaching the people this edit adds. Said
                    here, before Save, because a member who adds two guests and
                    silently gets a different rate for one of them reads that as
                    a bug. The totals above already include it. */}
                {quote.promoCoverage && promoAction.type === "keep" && (
                  <div
                    className="rounded-md bg-warning-3 p-3 text-sm text-warning-11"
                    role="status"
                    data-testid="promo-coverage-notice"
                  >
                    {quote.promoCoverage.message}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {showChangeRequestPath && (
        <Card>
          <CardHeader>
            <CardTitle>Admin Request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="change-request-reason">Requested change</Label>
              <Textarea
                id="change-request-reason"
                value={requestReason}
                maxLength={2000}
                onChange={(event) => setRequestReason(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleSubmitChangeRequest}
              disabled={requestSubmitting || (!hasChanges && !requestReason.trim())}
            >
              {requestSubmitting ? "Sending..." : "Request Admin Review"}
            </Button>
            {requestError && (
              <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
                {requestError}
              </div>
            )}
            {requestSuccess && (
              <div className="rounded-md bg-success-3 p-3 text-sm text-success-11">
                {requestSuccess}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* #2104: required justification when the edit leaves minors with no adult.
          Rendered above the save footer; the inline error sits with the field
          (not the bottom saveError slot) so a member cannot miss it. */}
      {showReviewJustification && (
        <div className="space-y-2 rounded-md border border-warning/20 bg-warning-muted p-4">
          <Label htmlFor="edit-review-justification" className="text-warning">
            Reason for leaving no adult on the booking (required)
          </Label>
          <p className="text-sm text-warning">
            This change would leave the minors on this booking with no adult. Please
            explain why so an admin can review it. The booking is blocked from lodge
            check-in until an admin approves it.
          </p>
          <Textarea
            id="edit-review-justification"
            ref={reviewJustificationRef}
            value={memberReviewJustification}
            onChange={(e) => {
              setMemberReviewJustification(e.target.value);
              if (reviewJustificationError) setReviewJustificationError("");
            }}
            rows={3}
            maxLength={1000}
            placeholder="Explain why an adult is not on the booking..."
            aria-invalid={reviewJustificationError ? true : undefined}
            aria-describedby={
              reviewJustificationError
                ? "edit-review-justification-error"
                : undefined
            }
          />
          {reviewJustificationError && (
            <p
              id="edit-review-justification-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {reviewJustificationError}
            </p>
          )}
        </div>
      )}

      {/* #2390: the save came back saying the promotion reaches fewer people
          than the preview did — another booking took the last slot between the
          two reads. The change IS saved, so Save is replaced by an
          acknowledgement rather than offered again; the member reads why their
          total differs here, at the edit, instead of on the invoice. */}
      {savedPromoCoverage ? (
        <div className="space-y-3">
          <div
            className="rounded-md bg-warning-3 p-3 text-sm text-warning-11"
            role="status"
            data-testid="saved-promo-coverage-notice"
          >
            <p className="font-medium">Your change is saved</p>
            <p className="mt-1">{savedPromoCoverage}</p>
          </div>
          <div className="flex gap-3">
            <Button onClick={onDone}>Done</Button>
          </div>
        </div>
      ) : (
        <>
          {/* Action buttons */}
          <div className="flex gap-3">
            <Button variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveClick}
              disabled={
                !hasChanges ||
                saving ||
                quoteLoading ||
                !quote ||
                !capacityOk ||
                (settlementRequired && !settlementMethod)
              }
            >
              {saving ? "Saving..." : "Save Changes"}
            </Button>
          </div>

          {saveError && (
            <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">{saveError}</div>
          )}

          {/* #2562 — the exception-request door, drawn ONLY when the server's own
              refusal said every blocking failure is reviewable. It sits under Save
              because at this point saving cannot succeed: the member's next honest
              move is to change the proposal or to ask. */}
          {exceptionOffer ? (
            <RequestOfficerApprovalCard
              source="MODIFICATION"
              offer={exceptionOffer}
              replaceRequestId={replaceExceptionRequestId}
              onSubmit={submitExceptionRequest}
              proposal={{
                lodgeName: null,
                checkIn,
                checkOut,
                envelopeNightCount: countNightsDateOnly(
                  parseDateOnly(checkIn),
                  parseDateOnly(checkOut),
                ),
                base: {
                  checkIn: booking.checkIn,
                  checkOut: booking.checkOut,
                  guestCount: booking.guests.length,
                },
                // The server's own figure when it produced one. A refusal answered
                // INSTEAD of a quote leaves this null, and the card then says how
                // pricing actually works rather than inventing a number.
                priceImpact: quote
                  ? {
                      label:
                        quote.netChargeCents >= 0
                          ? "Extra to pay if this is approved"
                          : "Refund due if this is approved",
                      amountCents: Math.abs(quote.netChargeCents),
                    }
                  : null,
                omittedChanges: exceptionRequestPayloadFromModification(
                  buildModificationPayload(),
                ).omittedChanges,
                guests: [
                  ...remainingGuests.map((guest) => ({
                    firstName: guest.firstName,
                    lastName: guest.lastName,
                    ageTierLabel:
                      ageTierOptions.find((option) => option.tier === guest.ageTier)
                        ?.label ?? guest.ageTier,
                    isMember: guest.isMember,
                    nights: existingGuestNights[guest.id] ?? [],
                    stay:
                      guest.stayStart && guest.stayEnd
                        ? { start: guest.stayStart, end: guest.stayEnd }
                        : null,
                  })),
                  ...addedGuests.map((guest) => ({
                    firstName: guest.firstName,
                    lastName: guest.lastName,
                    ageTierLabel:
                      ageTierOptions.find((option) => option.tier === guest.ageTier)
                        ?.label ?? guest.ageTier,
                    isMember: guest.isMember,
                    nights: guest.nights ?? [],
                    stay:
                      guest.stayStart && guest.stayEnd
                        ? { start: guest.stayStart, end: guest.stayEnd }
                        : null,
                  })),
                ],
              }}
            />
          ) : null}
        </>
      )}

      {/* Owner decision (#1668/#1696): the admin explicitly chooses, per edit,
          whether the member is emailed. Both choices save the booking; the
          choice itself is recorded in the audit log.

          #2259: with the booking's "No emails" switch on there is no choice to
          make — the mailer withholds the change notification either way — so
          the dialog states that and offers only the send-nothing action. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => !saving && setNotifyDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {noEmailsOn
                ? "Save this change?"
                : "Email the member about this change?"}
            </DialogTitle>
            <DialogDescription>
              {noEmailsOn
                ? "The booking will be updated."
                : "The booking will be updated either way. Choose whether the member receives the standard change-notification email — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          {noEmailsOn && <BookingNoEmailsNotice />}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => {
                setNotifyDialogOpen(false);
                // #2259 H1: with the switch on, send NO choice rather than
                // notifyMember:false. `false` makes the route skip the send, so
                // the mailer's gate never runs and no withheld row is recorded —
                // the banner would then omit the very change just made.
                void handleSave(noEmailsOn ? undefined : false);
              }}
            >
              {noEmailsOn ? "Save changes" : "Save without emailing"}
            </Button>
            {!noEmailsOn && (
              <Button
                disabled={saving}
                onClick={() => {
                  setNotifyDialogOpen(false);
                  void handleSave(true);
                }}
              >
                Save and email member
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
