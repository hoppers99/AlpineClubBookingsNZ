import {
  participantQualifiesAsHost,
  type HostingMemberFacts,
  type HostingParticipant,
} from "@/lib/policies/adult-member-hosting";

/**
 * Subscription-lockout booking pricing + paid-up-adult presence (#2533).
 *
 * OWNER DECISION (2 Aug 2026), extending the #2364 lapsed-member framing (D-R3)
 * from "not in good standing" to "not paid up":
 *
 *   > A subscription-locked member can still book for others in their family,
 *   > but if that individual's subscription is not paid they get charged
 *   > **non-member rates** (and are **told why** this is the case), and there
 *   > still has to be **at least one paid-up adult member on the booking**.
 *
 * This module is the PURE evaluator for that rule, deliberately mirroring
 * `policies/adult-member-hosting.ts`: it takes already-loaded facts and returns
 * decisions and member-facing sentences. It performs no I/O, so it is
 * deterministic and directly testable, and the decision about WHICH client reads
 * the facts belongs to the booking paths that consume it.
 *
 * THE RELATIONSHIP TO #2364 IS DELIBERATE, NOT INCIDENTAL. #2364 already treats a
 * lapsed member (inactive/cancelled/archived) as a non-member for hosting: they
 * cannot host, and their own nights need hosting. #2533 adds the second half of
 * the same idea on the money axis — a member who is in good standing but whose
 * season subscription is unpaid is, for PRICING, treated as a non-member, and for
 * the "responsible adult present" test does not count as a qualifying adult.
 * `participantQualifiesAsHost` (the #2364 predicate) is REUSED here rather than
 * re-derived, so the standing/adult/operationally-present half can never drift;
 * #2533 only ANDs the subscription-settled fact on top.
 *
 * ENFORCEMENT IS A SEPARATE, OWNER-GATED DECISION. Today an unpaid required
 * member is HARD-BLOCKED from booking (a 403 on the create, confirm-draft,
 * group-join and modify paths), not repriced. Turning that block into the soft
 * "reprice + require a paid-up adult" behaviour above is a Critical money-regime
 * change with coupled decisions (opt-in vs. replace, capacity, Xero narration)
 * that only the owner can settle. This module is the pure, reviewed foundation
 * those paths will consume once the rollout is decided; it moves no money and
 * changes no path on its own. See `docs/DOMAIN_INVARIANTS.md` →
 * "Subscription-lockout booking pricing (#2533)".
 */

// ---------------------------------------------------------------------------
// Requirement 1 — an unpaid member's own nights price at non-member rates.
// ---------------------------------------------------------------------------

export interface UnpaidSubscriptionPricingFacts {
  /**
   * The guest is a member (the pricing-time snapshot). A true non-member is not
   * this rule's concern — they already price at non-member rates.
   */
  isMember: boolean;
  /**
   * The booking-time subscription gate says this member owes a paid subscription
   * for the season (the result of `requiresPaidSubscriptionForMemberForBooking`,
   * which already folds in the Xero-off bypass, the membership-type opt-outs and
   * the per-age-tier rule). False means the lockout does not apply to them, so
   * their rate is never forced.
   */
  subscriptionRequired: boolean;
  /**
   * A PAID subscription row exists for the season (or a NOT_REQUIRED row
   * dominates). When `subscriptionRequired` is true and this is false, the member
   * is the "subscription-locked" case the owner's rule is about.
   */
  subscriptionPaid: boolean;
}

/**
 * Whether this member's nights must price at the built-in NON_MEMBER rate because
 * their season subscription is required but unpaid.
 *
 * Returns false for a non-member (they are already non-member-priced), for a
 * member the lockout does not apply to, and for a paid-up member. The caller
 * turns a `true` into the existing `rateSource: "TYPE_POLICY_FORCED"` →
 * NON_MEMBER resolution (`resolveGuestRateMembershipTypes`), which already routes
 * the correct non-member Xero item code, so no new pricing or invoicing path is
 * introduced.
 */
export function memberUnpaidSubscriptionForcesNonMemberRate(
  facts: UnpaidSubscriptionPricingFacts,
): boolean {
  return (
    facts.isMember === true &&
    facts.subscriptionRequired === true &&
    facts.subscriptionPaid === false
  );
}

// ---------------------------------------------------------------------------
// Requirement 3 — at least one paid-up adult member on the booking.
// ---------------------------------------------------------------------------

/**
 * The facts a participant is judged by for the paid-up-adult presence test. The
 * `member`/`operationallyPresent` pair is exactly `participantQualifiesAsHost`'s
 * input (#2364), reused verbatim; `subscriptionSettled` is the one fact #2533
 * adds.
 */
export interface PaidUpAdultParticipant {
  /** Resolved live Member row, or null for a non-member / unresolved guest. */
  member: HostingMemberFacts | null;
  /**
   * Whether this row is operationally present at the lodge (D-12). Absent means
   * present, matching #2364 — the pre-persist create path has no consent facts
   * yet and every other participant is a row that really is coming.
   */
  operationallyPresent?: boolean;
  /**
   * Whether this member's season subscription is settled: PAID, or the season
   * gate says a subscription is not required for them. False for a member who
   * owes an unpaid subscription. Only consulted once the #2364 host predicate
   * already passes, so a lapsed or non-member participant is excluded on standing
   * before this fact is even read.
   */
  subscriptionSettled: boolean;
}

/**
 * Whether this participant is a paid-up adult member: a qualifying #2364 host
 * (active, present, ADULT, in good standing) whose subscription is ALSO settled.
 *
 * The two dimensions are ANDed deliberately. A lapsed adult with a paid
 * subscription fails the standing half (via `participantQualifiesAsHost`); a
 * paid-up-membership adult whose *subscription* is unpaid fails the money half.
 * Only somebody clear on both counts is the "paid-up adult member" the owner's
 * rule requires to be present.
 */
export function participantIsPaidUpAdultMember(
  participant: PaidUpAdultParticipant,
): boolean {
  return (
    participantQualifiesAsHost(participant) &&
    participant.subscriptionSettled === true
  );
}

export interface PaidUpAdultPresenceResult {
  /** True when at least one participant is a paid-up adult member. */
  hasPaidUpAdult: boolean;
  /** The member-facing refusal sentence when none is present; null otherwise. */
  refusalReason: string | null;
}

/**
 * Evaluate whether a booking party contains at least one paid-up adult member.
 *
 * This is the "there still has to be at least one paid-up adult member on the
 * booking" half of the owner's rule, expressed as a pure predicate over the
 * party. A booking with no such member is refused; the reason names the two ways
 * to fix it (renew a subscription, or add a paid-up adult member) without naming
 * anyone, keeping it safe to render straight into a booking response.
 */
export function evaluatePaidUpAdultPresence(
  participants: readonly PaidUpAdultParticipant[],
): PaidUpAdultPresenceResult {
  const hasPaidUpAdult = participants.some(participantIsPaidUpAdultMember);
  return {
    hasPaidUpAdult,
    refusalReason: hasPaidUpAdult ? null : formatMissingPaidUpAdultRefusal(),
  };
}

// ---------------------------------------------------------------------------
// Requirement 2 — tell the member why.
// ---------------------------------------------------------------------------

/**
 * The member-facing sentence explaining that an unpaid subscription removes
 * member rates. Worded to be TRUE under both the current hard-block regime (an
 * unpaid member cannot book at member rates because they cannot book at all) and
 * the decided soft regime (they are charged non-member rates), so it can be
 * surfaced today without misdescribing behaviour: it never promises a booking,
 * only states that member rates are unavailable and how to restore them.
 */
export function formatUnpaidSubscriptionRateReason(seasonDisplay: string): string {
  return (
    `Your ${seasonDisplay} membership subscription isn't paid, so member rates ` +
    `aren't available to you — renew your subscription to restore member rates.`
  );
}

/**
 * The member-facing sentence refusing a booking that has no paid-up adult member
 * on it. Names neither a person nor an amount — the two escape routes only.
 */
export function formatMissingPaidUpAdultRefusal(): string {
  return (
    "This booking needs at least one paid-up adult member staying on it. " +
    "Renew a subscription, or add an adult member whose subscription is paid, " +
    "and try again."
  );
}

/** Re-export so consumers can name the reused #2364 shapes from one import. */
export type { HostingMemberFacts };
