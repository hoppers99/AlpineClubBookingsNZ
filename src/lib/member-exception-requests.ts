/**
 * "My booking-rule requests" — the member-facing view of their own
 * booking-policy exception requests (#2562).
 *
 * This module is the ONE place a policy-exception request row is reduced to
 * something a member may see, for BOTH request flavours (a new booking nobody has
 * made yet, and a change to a live booking). It is a separate module, as
 * `member-whole-lodge-requests.ts` is for #2263, so the reduction is testable in
 * isolation and cannot drift per-surface.
 *
 * Four rules it enforces, three of them privacy rules rather than presentation
 * ones:
 *
 *  1. STRICT ALLOWLIST. The DTO names every field it carries and the mapper
 *     never spreads a row, so a column added to either table tomorrow cannot
 *     arrive on a member's screen by accident. In particular `internalNotes` —
 *     the officer's private commentary (#2562) — has NO SLOT HERE, and the input
 *     type does not accept it, so a caller cannot hand it over "just in case".
 *     `adminNotes` IS carried, deliberately: it is the officer's member-facing
 *     decision explanation, the officer UI says so before they submit it, and a
 *     refusal the member cannot read is a refusal they cannot act on.
 *
 *  2. NO INVENTED DECISION. A REQUESTED row with a recorded capacity conflict
 *     reads as "the lodge was full when an officer tried", not as "nobody has
 *     looked yet" — those are different facts and the second one is a lie the
 *     member would act on. `pending-capacity-conflict` is the state that says so.
 *
 *  3. HONEST CAPACITY, PER PATH. `capacityHeld` is derived from what the request
 *     ACTUALLY reserves, never from the policy's capacity mode alone. A
 *     new-booking request reserves nothing whatever its mode says — the
 *     provisional reservation ledger is keyed on an existing booking and there is
 *     no booking yet — so its answer is always false. A modification request
 *     answers from its real reservation-night rows.
 *
 *     The frozen capacity MODE is carried as well, for the sentence and never for
 *     that answer. "Nothing is held" has two causes — a HOLD request that needs no
 *     extra bed (a pure shrink) and a NO_HOLD request that may need plenty — and a
 *     member told the first when the second is true stops watching a lodge they are
 *     racing.
 *
 *  4. EXHAUSTIVE STATUS MAPPING over the Prisma enum: the `never` assignment in
 *     the mapper is a compile-time proof that every status is classified, so a
 *     new status cannot default into a friendly word.
 */
import type { BookingChangeRequestStatus } from "@prisma/client";

import type {
  PolicyExceptionCapacityMode,
  PolicyExceptionReasonCode,
} from "@/lib/booking-policy-exceptions";

/**
 * The states a member may see, one per row. Every state the owner's #2562
 * decision lists is here, and nothing collapses two different facts into one
 * word.
 *
 * `pending` — with the Booking Officer, nobody has tried to apply it yet.
 * `pending-capacity-conflict` — an officer HAS tried and the lodge was full.
 * `approved` — approved AND executed; there is a real booking behind it.
 * `refused` — an officer decided against it.
 * `withdrawn` — the member withdrew it.
 * `superseded` — the member replaced it with a corrected proposal.
 * `expired` — the hold ran out before anybody decided it (#2553).
 */
export type MemberExceptionRequestStatus =
  | "pending"
  | "pending-capacity-conflict"
  | "approved"
  | "refused"
  | "withdrawn"
  | "superseded"
  | "expired";

/** Which workflow the request came from. Decides the capacity wording. */
export type MemberExceptionRequestSource = "NEW_BOOKING" | "MODIFICATION";

/** One guest in the frozen proposal, as the member may see them. */
export interface MemberExceptionProposalGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  /** The exact NZ lodge nights this guest is proposed for, in night order. */
  nights: string[];
}

/**
 * The proposal EXACTLY as it was frozen, so the member reads back what they
 * submitted rather than a summary of it.
 *
 * Nothing here is recomputed: every field is read out of the immutable
 * `proposalSnapshot` the officer will decide on. `guestNights` is the sum of the
 * per-guest night counts — the guest-night allocation the club charges and holds
 * beds by — and is stated because a party whose members stay different nights has
 * a headcount that says almost nothing about what was asked for.
 */
export interface MemberExceptionProposal {
  lodgeId: string | null;
  /** YYYY-MM-DD NZ lodge nights: the proposed stay envelope. */
  checkIn: string | null;
  checkOut: string | null;
  guests: MemberExceptionProposalGuest[];
  /** Total guest-nights across the party — the allocation, not the headcount. */
  guestNights: number;
  /**
   * The live booking's envelope on a MODIFICATION request, frozen at submit
   * time, so the member can see what the change moves FROM. Null on a
   * new-booking request, which has no base.
   */
  baseCheckIn: string | null;
  baseCheckOut: string | null;
  /** Guest-nights on the live booking as frozen. Null on a new-booking request. */
  baseGuestNights: number | null;
}

/** One rule the request asks to be let past, in the member's words. */
export interface MemberExceptionRule {
  reasonCode: PolicyExceptionReasonCode;
  /** The policy's own plain-language sentence, frozen with the evidence. */
  message: string;
  /** Sorted NZ lodge nights the rule bites on. */
  affectedNights: string[];
}

export interface MemberExceptionRequestItem {
  id: string;
  source: MemberExceptionRequestSource;
  status: MemberExceptionRequestStatus;
  /** ISO timestamp of submission, for ordering and the "asked on" line. */
  createdAt: string;
  /** When an officer decided it, if they have. */
  reviewedAt: string | null;
  /** The exact frozen proposal. */
  proposal: MemberExceptionProposal;
  /** Every covered rule, so all of them are explained at once. */
  rules: MemberExceptionRule[];
  /** The member's own submitted explanation. */
  memberMessage: string | null;
  /**
   * The officer's MEMBER-FACING decision explanation (`adminNotes`). Never the
   * internal note, which this DTO has no field for.
   */
  decisionExplanation: string | null;
  /** Whether this request is holding beds RIGHT NOW. Never a policy guess. */
  capacityHeld: boolean;
  /**
   * The frozen HOLD-if-any-HOLD capacity mode, or null where the row has none.
   *
   * Carried ONLY so the capacity sentence can distinguish "needs no extra beds"
   * from "needs beds that this rule does not hold". It is never an answer to
   * "are beds held" — `capacityHeld` is, and it comes from the ledger.
   */
  capacityMode: PolicyExceptionCapacityMode | null;
  /** The most recent capacity conflict an approval attempt ran into. */
  lastConflictReason: string | null;
  lastConflictAt: string | null;
  /** The live booking a MODIFICATION request targets. Null on a new booking. */
  bookingId: string | null;
  /** The booking a successful approval produced, once it exists. */
  createdBookingId: string | null;
  /**
   * Whether that created booking is holding its beds right now — the booking's
   * own capacity answer, not the request's. Null on every row that created no
   * booking, and null when the caller could not read the booking.
   *
   * Separate from `capacityHeld` on purpose: `capacityHeld` is about the REQUEST's
   * provisional reservation, which an approved request no longer has. This is
   * about the thing the approval produced, and the two are never the same fact.
   */
  createdBookingHoldsCapacity: boolean | null;
  /** The replacement request, once this one has been superseded. */
  supersededByRequestId: string | null;
  /** Whether the withdraw affordance is offered — derived, not restated. */
  canWithdraw: boolean;
  /** Whether the replace affordance is offered — same derivation. */
  canReplace: boolean;
}

/**
 * Map the stored status onto the member-visible one.
 *
 * `hasUndecidedConflict` splits REQUESTED in two, which is the whole point of
 * this function existing rather than being a lookup table: a request an officer
 * has already tried to approve, and which the lodge's occupancy stopped, is a
 * materially different thing to tell somebody than a request nobody has opened.
 * Exhaustive over the enum — the `never` assignment fails the build if a status
 * is added and not classified.
 */
export function toMemberExceptionRequestStatus(
  status: BookingChangeRequestStatus,
  hasUndecidedConflict: boolean,
): MemberExceptionRequestStatus {
  switch (status) {
    case "REQUESTED":
      return hasUndecidedConflict ? "pending-capacity-conflict" : "pending";
    // APPROVED is only ever written in the same transaction that created the
    // booking or applied the change (#2525), so it always means "done", never
    // "about to happen".
    case "APPROVED":
      return "approved";
    case "REJECTED":
      return "refused";
    // The member's own withdrawal.
    case "CANCELLED":
      return "withdrawn";
    case "SUPERSEDED":
      return "superseded";
    // #2553: the hold reaper closed it. The member is emailed at the time; this
    // is the state their list then shows.
    case "EXPIRED":
      return "expired";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * The one sentence about capacity for a request in this state, on this path.
 *
 * Written here, once, because the honest sentence differs per path and per
 * moment, and the tempting generic wording ("your beds are held while we
 * review") is FALSE for the whole new-booking population. Approval never
 * overrides capacity on either path, and every branch below says so or implies
 * it without ever promising a bed.
 */
export function memberExceptionCapacityWording(args: {
  source: MemberExceptionRequestSource;
  status: MemberExceptionRequestStatus;
  capacityHeld: boolean;
  /**
   * The request's own frozen capacity mode, where the caller has it.
   *
   * REQUIRED to tell the truth about a pending modification, and this is why:
   * `capacityHeld` is false in two materially different situations — a HOLD
   * request whose incremental footprint came out empty (a pure shrink: it needs no
   * extra bed, so none is held) and ANY NO_HOLD request (which reserves nothing
   * even when the change needs beds on nights the booking does not have). Deciding
   * the sentence on `capacityHeld` alone asserted the first of those about both,
   * so a member racing for a bed was told they had nothing to race for.
   */
  capacityMode?: PolicyExceptionCapacityMode | null;
  /**
   * Whether the booking an APPROVED new-booking request created is holding its
   * beds RIGHT NOW, read from that booking's own status through
   * `bookingHoldsCapacity`. Null when the caller cannot establish it (and on
   * every path that has no such booking).
   *
   * REQUIRED to tell the truth about an approved new booking, and this is why.
   * The approval creates the booking the member's own wizard would have created
   * — PENDING or PAYMENT_PENDING (`calculateBookingHoldDecision`) — and neither
   * of those holds capacity on its own: no `originBookingRequest`, no
   * `adminCapacityHoldAt`, so `bookingHoldsCapacity` is false and another member
   * can still take those nights until it is paid. The sentence this function used
   * to return said the opposite ("the beds are on the booking this created"), which
   * is a held-beds promise about a booking that holds nothing — the one thing the
   * owner's #2562 decision forbids on this path. It becomes true later, when the
   * member pays, so the answer has to come from the booking rather than from the
   * approval.
   */
  createdBookingHoldsCapacity?: boolean | null;
}): string {
  if (args.status === "approved") {
    // A MODIFICATION approval created no booking: it changed one the member
    // already had. Its beds are that booking's, held on the booking's own terms,
    // and the request holds nothing of its own any more — so this says what
    // happened and makes no capacity claim it cannot stand behind.
    if (args.source === "MODIFICATION") {
      return "The change has been applied to your booking. This request holds nothing of its own any more — the beds are the booking's, on the booking's own terms.";
    }
    if (args.createdBookingHoldsCapacity === true) {
      return "The booking this created is holding its beds.";
    }
    if (args.createdBookingHoldsCapacity === false) {
      return "This created a booking, and it is not holding any beds yet — a new booking holds none until it is paid. Open it and pay it, or the nights can still go to somebody else.";
    }
    // The booking cannot be read from here. State the rule rather than an answer.
    return "This created a booking. A new booking holds no beds until it is paid, so open it and check whether anything is still owing.";
  }
  if (
    args.status === "withdrawn" ||
    args.status === "superseded" ||
    args.status === "refused"
  ) {
    return "No beds are held for this request any more.";
  }
  if (args.status === "expired") {
    return "The hold on the beds ran out and they went back into the pool. You can ask again.";
  }
  if (args.status === "pending-capacity-conflict") {
    return args.capacityHeld
      ? "This request is holding the extra beds it needs, but the last attempt to apply it still ran short. A Booking Officer will look again."
      : "No beds are held for this request. The lodge was full when a Booking Officer last tried to apply it, and availability is checked again every time.";
  }
  // pending
  if (args.source === "NEW_BOOKING") {
    return "No beds are held. Nothing is reserved until a Booking Officer approves this, and availability is checked again at that moment.";
  }
  if (args.capacityHeld) {
    return "The extra beds this change needs are held while it waits. Availability is checked again when a Booking Officer approves it.";
  }
  // Nothing is held. WHY nothing is held decides what is honest to say next.
  if (args.capacityMode === "HOLD") {
    // A HOLD aggregate that reserved no bed genuinely needs none: the change is a
    // shrink, or a reshuffle that adds nobody on any night.
    return "This change needs no extra beds, so none are held. Availability is checked again when a Booking Officer approves it.";
  }
  if (args.capacityMode === "NO_HOLD") {
    // The change may well need beds. The club set this rule up not to hold them,
    // so say that, and say what it means for the member.
    return "No beds are held for this request, so the lodge could fill before it is decided. Availability is checked again when a Booking Officer approves it, and a full lodge means it cannot be approved.";
  }
  // Mode unknown to this caller: state only what is certainly true.
  return "No extra beds are held for this request. Availability is checked again when a Booking Officer approves it, and a full lodge means it cannot be approved.";
}

/**
 * The frozen proposal's guests, read defensively out of the stored JSON.
 *
 * Best-effort by design: a snapshot that will not parse yields an empty party
 * rather than throwing, because the member's list must still render the request's
 * status and the officer's decision. An empty party is visibly wrong on screen,
 * which is the correct outcome for a row nobody can execute.
 */
function proposalGuests(value: unknown): MemberExceptionProposalGuest[] {
  if (!Array.isArray(value)) return [];
  const guests: MemberExceptionProposalGuest[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const guest = raw as Record<string, unknown>;
    if (
      typeof guest.firstName !== "string" ||
      typeof guest.lastName !== "string" ||
      typeof guest.ageTier !== "string"
    ) {
      continue;
    }
    guests.push({
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember === true,
      nights: Array.isArray(guest.nights)
        ? guest.nights.filter((n): n is string => typeof n === "string")
        : [],
    });
  }
  return guests;
}

function partyFacts(value: unknown): {
  checkIn: string | null;
  checkOut: string | null;
  guests: MemberExceptionProposalGuest[];
  guestNights: number;
} {
  const empty = { checkIn: null, checkOut: null, guests: [], guestNights: 0 };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const party = value as Record<string, unknown>;
  const guests = proposalGuests(party.guests);
  return {
    checkIn: typeof party.checkIn === "string" ? party.checkIn : null,
    checkOut: typeof party.checkOut === "string" ? party.checkOut : null,
    guests,
    guestNights: guests.reduce((sum, guest) => sum + guest.nights.length, 0),
  };
}

/** Read the whole proposal out of one stored `proposalSnapshot`. */
export function toMemberExceptionProposal(
  snapshot: unknown,
): MemberExceptionProposal {
  const root =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)
      : {};
  const proposed = partyFacts(root.proposed);
  const hasBase = root.base !== undefined && root.base !== null;
  const base = hasBase ? partyFacts(root.base) : null;
  return {
    lodgeId: typeof root.lodgeId === "string" ? root.lodgeId : null,
    checkIn: proposed.checkIn,
    checkOut: proposed.checkOut,
    guests: proposed.guests,
    guestNights: proposed.guestNights,
    baseCheckIn: base?.checkIn ?? null,
    baseCheckOut: base?.checkOut ?? null,
    baseGuestNights: base ? base.guestNights : null,
  };
}

/**
 * The covered rules out of one stored `frozenEvidence`.
 *
 * The frozen violations are the authority for what an approval may override, so
 * they are also the authority for what the member is told they asked for. Every
 * covered violation is carried — the owner's decision requires all relevant
 * issues to be explained at once rather than revealed one at a time.
 */
export function toMemberExceptionRules(
  frozenEvidence: unknown,
): MemberExceptionRule[] {
  if (
    !frozenEvidence ||
    typeof frozenEvidence !== "object" ||
    Array.isArray(frozenEvidence)
  ) {
    return [];
  }
  const violations = (frozenEvidence as { violations?: unknown }).violations;
  if (!Array.isArray(violations)) return [];
  const rules: MemberExceptionRule[] = [];
  for (const raw of violations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const violation = raw as Record<string, unknown>;
    if (typeof violation.reasonCode !== "string") continue;
    rules.push({
      reasonCode: violation.reasonCode as PolicyExceptionReasonCode,
      message: typeof violation.message === "string" ? violation.message : "",
      affectedNights: Array.isArray(violation.affectedNights)
        ? violation.affectedNights.filter((n): n is string => typeof n === "string")
        : [],
    });
  }
  return rules;
}

/**
 * Reduce one request row to the member DTO.
 *
 * The input type is deliberately a NARROW STRUCTURAL SHAPE, not a Prisma row: a
 * caller cannot satisfy it by handing over the whole record and hoping this
 * function is careful, and `internalNotes` is not a property it accepts, so
 * passing the officer's private note here is a typecheck failure rather than a
 * privacy incident.
 *
 * `holdsReservationNights` is a FACT the caller must establish from the
 * reservation ledger, not something derived here from `aggregateCapacityMode`.
 * The mode says what the POLICY would do; only the ledger says what this request
 * actually holds, and the two differ for every new-booking request and for every
 * modification whose incremental footprint came out empty.
 */
export function toMemberExceptionRequestItem(request: {
  id: string;
  source: MemberExceptionRequestSource;
  status: BookingChangeRequestStatus;
  createdAt: Date;
  reviewedAt: Date | null;
  proposalSnapshot: unknown;
  frozenEvidence: unknown;
  memberMessage: string | null;
  adminNotes: string | null;
  lastConflictReason: string | null;
  lastConflictAt: Date | null;
  bookingId: string | null;
  createdBookingId: string | null;
  supersededByRequestId: string | null;
  /** True only when live PolicyExceptionReservationNight rows exist for it. */
  holdsReservationNights: boolean;
  /**
   * The CREATED booking's own capacity answer, where the caller read it.
   *
   * A FACT about a Booking, established by the caller through
   * `bookingHoldsCapacity`, exactly as `holdsReservationNights` is a fact about
   * the reservation ledger. Never derived here and never inferred from
   * `status === "APPROVED"`: an approval creates a PENDING or PAYMENT_PENDING
   * booking, which holds nothing until it is paid, and "we approved it" is not
   * evidence about beds.
   */
  createdBookingHoldsCapacity?: boolean | null;
  /**
   * The frozen HOLD-if-any-HOLD aggregate, or null on a row that has none.
   *
   * Carried so the capacity SENTENCE can tell "this change needs no extra beds"
   * apart from "this change needs beds and the policy holds none" — two facts
   * `capacityHeld` alone collapses into one, because a NO_HOLD request reserves
   * nothing whatever it needs. It is NEVER the source of `capacityHeld`: the mode
   * says what the policy would do, only the ledger says what this request holds.
   */
  aggregateCapacityMode: PolicyExceptionCapacityMode | null;
  /**
   * NOT A FIELD. Declared as `never` so the officer's private note is rejected by
   * the compiler even when a caller SPREADS a row in — which both production call
   * sites do, and which an excess-property check does not see. Without this the
   * documented "handing the private note to the member projection is a typecheck
   * failure" was only true of a caller who named the field, i.e. of nobody.
   */
  internalNotes?: never;
}): MemberExceptionRequestItem {
  // A conflict counts as "undecided" only while the request is still open. Once
  // it is refused, withdrawn, replaced, expired or executed, an old conflict is
  // history and must not keep colouring the row.
  const hasUndecidedConflict =
    request.status === "REQUESTED" && request.lastConflictAt !== null;
  const status = toMemberExceptionRequestStatus(
    request.status,
    hasUndecidedConflict,
  );
  const isOpen = request.status === "REQUESTED";
  return {
    id: request.id,
    source: request.source,
    status,
    createdAt: request.createdAt.toISOString(),
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    proposal: toMemberExceptionProposal(request.proposalSnapshot),
    rules: toMemberExceptionRules(request.frozenEvidence),
    memberMessage: request.memberMessage,
    // The officer's member-facing explanation, and only ever that field.
    decisionExplanation: request.adminNotes,
    // A new-booking request reserves nothing, so the caller passes false for it;
    // this reads the fact rather than re-deriving it from the capacity mode.
    capacityHeld: request.holdsReservationNights,
    // The frozen mode, carried for the WORDING only. See the field's doc comment
    // and `memberExceptionCapacityWording`: HOLD-with-nothing-held and
    // NO_HOLD-with-nothing-held are different facts and get different sentences.
    capacityMode: request.aggregateCapacityMode,
    lastConflictReason: request.lastConflictReason,
    lastConflictAt: request.lastConflictAt?.toISOString() ?? null,
    bookingId: request.bookingId,
    // Only a request that actually executed has a booking to open.
    createdBookingId: status === "approved" ? request.createdBookingId : null,
    // Scoped to the same condition as the id it describes: a row with no booking
    // to open has no booking-capacity answer either, whatever a caller passed.
    createdBookingHoldsCapacity:
      status === "approved" && request.createdBookingId
        ? (request.createdBookingHoldsCapacity ?? null)
        : null,
    supersededByRequestId: request.supersededByRequestId,
    // DERIVED from the very condition the cancel/supersede services' guarded
    // claims name (`status: "REQUESTED"`), not a restatement of it. Offering a
    // button the API answers with a 409 is worse than offering none.
    canWithdraw: isOpen,
    canReplace: isOpen,
  };
}

/**
 * Whether the member's capacity mode is worth mentioning at all on a submission
 * screen. Exported for the request form, which states the mode's promise in
 * words rather than showing the enum.
 */
export function memberExceptionSubmitCapacityWording(args: {
  source: MemberExceptionRequestSource;
  capacityMode: PolicyExceptionCapacityMode | null;
}): string {
  if (args.source === "NEW_BOOKING") {
    // TRUE for every new-booking request regardless of mode: the reservation
    // ledger is keyed on an existing booking and there is no booking yet.
    return "No beds are held by this request. Availability is checked again when a Booking Officer reviews it, and a full lodge means it cannot be approved.";
  }
  return args.capacityMode === "HOLD"
    ? "Any extra beds this change needs are held while the request waits, so long as they are free when you submit it. Availability is checked again at approval, and approval can never put the lodge over capacity."
    : "No extra beds are held by this request. Availability is checked again when a Booking Officer reviews it, and approval can never put the lodge over capacity.";
}

// ---------------------------------------------------------------------------
// Member-facing wording (#2562)
// ---------------------------------------------------------------------------

/**
 * The words a member sees for each state. Kept beside the mapping rather than in
 * a component so both the submission screen and the request list say the same
 * thing, and so a test can pin the sentence a `pending-capacity-conflict` row
 * shows — which is the one the owner's decision is most specific about.
 */
export const MEMBER_EXCEPTION_STATUS_LABELS: Record<
  MemberExceptionRequestStatus,
  string
> = {
  pending: "With the Booking Officer",
  "pending-capacity-conflict": "Waiting — the lodge was full",
  approved: "Approved and booked",
  refused: "Not approved",
  withdrawn: "Withdrawn by you",
  superseded: "Replaced by a newer request",
  expired: "Lapsed",
};

/**
 * The one-line explanation under each state badge. `pending` and
 * `pending-capacity-conflict` are deliberately different sentences: the owner's
 * decision requires a REQUESTED row with a recorded conflict to read as "the
 * lodge is full", never as "nobody has looked".
 */
export const MEMBER_EXCEPTION_STATUS_EXPLANATIONS: Record<
  MemberExceptionRequestStatus,
  string
> = {
  pending:
    "A Booking Officer has this and has not decided yet. It is not booked and it is not confirmed.",
  "pending-capacity-conflict":
    "A Booking Officer has looked at this and tried to apply it, but the lodge did not have room. It is still open — they will try again if space comes up.",
  approved:
    "A Booking Officer approved this and it has been applied. There is a real booking behind it.",
  refused: "A Booking Officer decided not to allow this one.",
  withdrawn: "You withdrew this request. Nothing was booked or changed.",
  superseded:
    "You replaced this with a corrected request. This one was not decided.",
  expired:
    "Nobody decided this before its hold ran out, so the beds went back into the pool. You can ask again.",
};

/**
 * Member-facing names for the rules a request may ask to be let past.
 *
 * Typed against the reason-code union on purpose, exactly as the officer queue's
 * table is: adding a code to the #2363 allowlist without deciding what to call it
 * for a member fails typecheck here, so a new violation class can never reach a
 * member's screen as a raw enum.
 */
export const MEMBER_EXCEPTION_RULE_LABELS: Record<
  PolicyExceptionReasonCode,
  string
> = {
  MINIMUM_STAY: "Minimum length of stay",
  ADULT_MEMBER_HOSTING_REQUIRED: "An adult member has to be staying too",
  PAID_UP_ADULT_MEMBER_REQUIRED:
    "A paid-up adult member has to be on the booking",
};

export function memberExceptionRuleLabel(code: string): string {
  return (
    (MEMBER_EXCEPTION_RULE_LABELS as Record<string, string>)[code] ?? code
  );
}

/**
 * The two sentences the owner's decision requires on every submission screen,
 * verbatim and in one place so neither wizard can soften them.
 *
 * They are separate constants because they say two different things and a member
 * needs both: submitting is not approval (a state-of-the-world fact), and approval
 * is not guaranteed (a fact about how the club decides).
 */
/**
 * "ABOVE", not "below", and the direction is load-bearing.
 *
 * The exception this sentence points at is the capacity sentence, and the card
 * draws that sentence immediately BEFORE this one (the honest per-path answer has
 * to be the first capacity thing a member reads, not a footnote to a general
 * denial). Pointing "below" sent a member on the one path where something IS
 * reserved — a HOLD modification — looking past this notice for an exception that
 * was never there, and left a new-booking member wondering what the exception had
 * been.
 */
export const MEMBER_EXCEPTION_NOT_APPROVED_YET_NOTICE =
  "Sending this request does not book anything and does not confirm anything. Nothing is reserved by the request itself except where the note above says otherwise.";

export const MEMBER_EXCEPTION_DISCRETIONARY_NOTICE =
  "Booking Officers allow exceptions at their discretion. There is no guarantee this one will be approved, and approval can never put the lodge over capacity.";

/**
 * What changing a submitted proposal means, in the member's words.
 *
 * The owner's decision asks specifically that a member understand that changing
 * dates, guests or other material details needs a REPLACEMENT request rather than
 * a silent edit of the original — because the original is what an officer froze
 * and reviewed, and editing it under them is how an officer approves something
 * nobody read.
 */
export const MEMBER_EXCEPTION_REPLACE_NOTICE =
  "A request cannot be edited after you send it: a Booking Officer decides the exact proposal you submitted. To change the dates, the guests or anything else material, replace it with a new request — the old one is closed as replaced and the new one starts from the corrected proposal.";
