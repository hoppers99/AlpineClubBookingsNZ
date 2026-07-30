import type { MemberGuestConsentStatus } from "@prisma/client";

/**
 * Member-guest consent model — the pure, database-free half of "+ Add Member
 * Guest" (epic #2305). Everything here is provisioned by MG1 (#2306) and
 * exercised by MG2 (#2307) onwards.
 *
 * MG1 SHIPS DARK. That is not a slogan, it is the single load-bearing property
 * of this release, and `MEMBER_GUEST_WIDENING_ENABLED` below is where it is
 * enforced. Read the note on that constant before changing anything in this
 * file.
 */

/**
 * THE WIDENING PREDICATE — the one switch MG2 flips.
 *
 * `false` means: a member may still only add guests from inside their own
 * family group, exactly as before this feature existed. A request to add any
 * other member is refused with the identical error `main` returns today, with
 * no reference to member guests, in EVERY module state and for every actor.
 *
 * Why the module flag does not do this job. `ClubModuleSettings.memberGuests`
 * exists from this release and an admin can switch it on — but switching it on
 * must change NOTHING, because MG1 has no consent request, no approval surface,
 * and no expiry sweep. If module-on widened the boundary here, an admin on an
 * MG1-only release could create capacity-holding `PENDING` guest rows that no
 * released code can ever resolve or expire. So the refusal is gated on this
 * constant, which is `false` unconditionally, and the module flag gates nothing
 * yet. The widening, the approval surface, and the expiry sweep all go live
 * together in MG2.
 *
 * A second consequence, equally deliberate: because nothing can widen the
 * boundary, nothing in this release can write a non-null
 * `BookingGuest.consentStatus` — so no ROW ever carries one of the new enum
 * labels, which is what makes the reverse blue/green direction safe (see the
 * ledger row for `20260731120100_add_booking_guest_consent`). Note the precise
 * claim: the labels are not "registered but never used" — the migration's
 * partial index names 'PENDING' in its predicate — they are never carried by
 * data, which is the property an old-colour Prisma client actually cares about.
 *
 * MG2's change here is one line: flip this to a policy read. The dark-guarantee
 * tests (the module ON/OFF identity matrix, the beyond-family refusal, and the
 * mutation probe that flips this constant) are written to fail the moment it
 * moves, so the flip cannot land quietly.
 *
 * Annotated `: boolean` on purpose — a bare `false` narrows to the literal
 * type, which makes every guard that reads it look like dead code to the
 * compiler and to reviewers.
 */
export const MEMBER_GUEST_WIDENING_ENABLED: boolean = false;

/**
 * Where a prospective guest sits relative to the booker's family boundary.
 *
 * This is computed for EVERY resolved member on EVERY path — including the
 * admin `skipAuthorization` paths — see `resolveLinkedBookingMembersWithBoundary`
 * in `booking-guests.ts`. In this release the value drives no outcome; in MG2 it
 * is what decides whether a guest row needs consent at all.
 */
export type MemberGuestBoundaryScope =
  /** Inside the booker's own family group (or the booker themselves): D-6, no consent needed. */
  | "FAMILY"
  /** Outside it: the case this whole epic exists for. Refused in this release. */
  | "BEYOND_FAMILY";

/** The computed boundary for one `resolveLinkedBookingMembers` call. */
export interface MemberGuestBoundaryState {
  /** Every normalised member id that was resolved, mapped to its scope. */
  scopeByMemberId: ReadonlyMap<string, MemberGuestBoundaryScope>;
  /** The `BEYOND_FAMILY` subset, in the order the ids were requested. */
  beyondFamilyMemberIds: readonly string[];
}

/** The consent columns MG1 provisions on `BookingGuest`. */
export interface MemberGuestConsentColumns {
  consentStatus: MemberGuestConsentStatus | null;
  consentRequestedAt: Date | null;
  consentRespondedAt: Date | null;
  consentRespondedByMemberId: string | null;
  consentExpiresAt: Date | null;
}

/**
 * The reachable consent sub-states, and exactly which columns each one sets.
 *
 * Five nullable columns are 2^5 shapes on paper; only these eight are legal.
 * Pinning the table here (rather than leaving it implied by whichever code
 * happens to write the columns) is what lets MG2, MG3, and MG4 each add a
 * writer without any of them having to re-derive the rules — and what lets a
 * reviewer check a new writer against a list instead of against their memory.
 *
 * The table is mirrored in `docs/DOMAIN_INVARIANTS.md`, quoted in the
 * `BookingGuest` schema comment, and pinned by
 * `src/lib/__tests__/member-guest-consent.test.ts`.
 *
 * `requestedAt` is the discriminator that does the most work: it separates a
 * consent that was actually ASKED FOR from one the club granted without asking.
 * `respondedByMemberId` is the second: it distinguishes the target answering
 * for themselves from a delegate or an admin answering for them, which is why
 * MG4's admin-assigner audit needs no extra column.
 *
 * NONE of these is reachable in this release except `FAMILY_OR_LEGACY`.
 */
export const MEMBER_GUEST_CONSENT_SUB_STATES = [
  {
    id: "FAMILY_OR_LEGACY",
    /** Family-scope add (D-6), or any row written before this feature existed. */
    status: null,
    requestedAt: "null",
    respondedAt: "null",
    respondedBy: "null",
    expiresAt: "null",
    reachableInMg1: true,
    note:
      "No consent was ever needed. NULL is NOT the same value as CONFIRMED and " +
      "the two must stay distinguishable forever: CONFIRMED means somebody said " +
      "yes, NULL means nobody was ever asked because nobody had to be.",
  },
  {
    id: "AWAITING_TARGET",
    /** Approval-required policy: the target has been asked and has not answered. */
    status: "PENDING",
    requestedAt: "set",
    respondedAt: "null",
    respondedBy: "null",
    expiresAt: "set",
    reachableInMg1: false,
    note:
      "Holds the bed (D-4) until expiresAt, which MG2 sets from " +
      "MemberGuestSettings.pendingHoldExpiryDays. MG2's sweep reads exactly this " +
      "shape through the partial index BookingGuest_pendingConsent_expiresAt_idx.",
  },
  {
    id: "TARGET_APPROVED",
    status: "CONFIRMED",
    requestedAt: "set",
    respondedAt: "set",
    /** Equals the guest's own memberId. */
    respondedBy: "target",
    expiresAt: "any",
    reachableInMg1: false,
    note: "The member who was asked said yes themselves.",
  },
  {
    id: "DELEGATE_APPROVED",
    status: "CONFIRMED",
    requestedAt: "set",
    respondedAt: "set",
    /** Differs from the guest's memberId (D-5/D-10: a target with no login). */
    respondedBy: "other",
    expiresAt: "any",
    reachableInMg1: false,
    note:
      "A delegate answered for a target who cannot log in. Audited distinctly " +
      "from TARGET_APPROVED — that distinction is the whole reason " +
      "consentRespondedByMemberId exists as its own column.",
  },
  {
    id: "NOTIFY_ONLY_AUTO_CONFIRMED",
    status: "CONFIRMED",
    /** Nobody was asked, so there is no request and no response. */
    requestedAt: "null",
    respondedAt: "null",
    respondedBy: "null",
    expiresAt: "null",
    reachableInMg1: false,
    note:
      "The club runs notify-only (approvalRequired false): the add is allowed " +
      "immediately and the target is told, not asked. CONFIRMED with a null " +
      "requestedAt AND a null respondedBy is the signature — it is what tells a " +
      "later reader that this consent was never actually solicited. It is " +
      "deliberately NOT written as FAMILY_OR_LEGACY: the guest IS cross-family " +
      "and that must stay visible. expiresAt is null because nothing is being " +
      "waited for: a CONFIRMED row carrying an expiry would look to MG2's sweep " +
      "like a hold with a deadline, so it is not a legal shape.",
  },
  {
    id: "ADMIN_ASSIGNED",
    status: "CONFIRMED",
    /** Nobody was asked: an admin (or a copy/pipeline flow) placed the guest. */
    requestedAt: "null",
    respondedAt: "set",
    /** The acting admin — MG4's audit rides this column, no new column needed. */
    respondedBy: "admin",
    expiresAt: "null",
    reachableInMg1: false,
    note:
      "Admin adds, admin booking-copy, and pipeline rows are consent-free by " +
      "owner decision (MG4-D-a/b) but are NOT recorded as FAMILY_OR_LEGACY: the " +
      "row keeps a CONFIRMED status naming the admin who stood behind it. This " +
      "is also the booking-copy rule — consent is NOT transitive across " +
      "bookings, so a copied cross-family guest is re-stamped here against the " +
      "copying admin and never inherits the source row's TARGET_APPROVED. " +
      "expiresAt is null for the same reason as NOTIFY_ONLY_AUTO_CONFIRMED: " +
      "nobody is being waited for, so there is no deadline to record.",
  },
  {
    id: "DECLINED",
    status: "DECLINED",
    requestedAt: "set",
    respondedAt: "set",
    /** Non-null, but the model does not care WHICH of them refused. */
    respondedBy: "set",
    expiresAt: "any",
    reachableInMg1: false,
    note:
      "The target (or their delegate) said no. Terminal for that request. A " +
      "refusal is an ATTRIBUTED act, so respondedBy must name somebody: MG4's " +
      "audit rides that column, and a decline nobody is recorded as making is " +
      "a broken row, not an anonymous one.",
  },
  {
    id: "EXPIRED",
    status: "EXPIRED",
    requestedAt: "set",
    respondedAt: "null",
    respondedBy: "null",
    expiresAt: "set",
    reachableInMg1: false,
    note:
      "The hold lapsed with no answer and MG2's sweep released the bed. " +
      "Distinct from DECLINED: nobody refused, the clock ran out.",
  },
] as const;

export type MemberGuestConsentSubStateId =
  (typeof MEMBER_GUEST_CONSENT_SUB_STATES)[number]["id"];

/**
 * Classify a persisted guest row against the table above.
 *
 * Returns `null` when the row matches no legal sub-state, which is the useful
 * answer: it means a writer has invented a combination the model does not
 * define. MG2+ writers are expected to assert a non-null classification.
 *
 * `targetMemberId` is the guest's own `memberId` — it is what separates
 * TARGET_APPROVED from DELEGATE_APPROVED — and may be null for a non-member
 * guest row, in which case a set responder classifies as ADMIN_ASSIGNED.
 */
export function classifyMemberGuestConsent(
  row: MemberGuestConsentColumns,
  targetMemberId: string | null,
): MemberGuestConsentSubStateId | null {
  const {
    consentStatus,
    consentRequestedAt,
    consentRespondedAt,
    consentRespondedByMemberId,
    consentExpiresAt,
  } = row;

  const requested = consentRequestedAt !== null;
  const responded = consentRespondedAt !== null;
  const responder = consentRespondedByMemberId;

  if (consentStatus === null) {
    // A NULL status with any other consent column set is not "family scope with
    // extra data" — it is a broken row, and saying so is the point of the model.
    return !requested && !responded && responder === null && consentExpiresAt === null
      ? "FAMILY_OR_LEGACY"
      : null;
  }

  if (consentStatus === "PENDING") {
    return requested && !responded && responder === null && consentExpiresAt !== null
      ? "AWAITING_TARGET"
      : null;
  }

  if (consentStatus === "CONFIRMED") {
    if (!requested) {
      // Never solicited: either the club runs notify-only, or an admin placed
      // the guest. The presence of a responder is what tells them apart —
      // and NEITHER shape is waiting for anything, so a set expiresAt is a
      // stale hold deadline on an already-settled row, i.e. a broken row. Both
      // table rows say `expiresAt: "null"`, and this is where that is enforced.
      if (consentExpiresAt !== null) return null;
      if (!responded && responder === null) return "NOTIFY_ONLY_AUTO_CONFIRMED";
      if (responded && responder !== null) return "ADMIN_ASSIGNED";
      return null;
    }
    if (!responded || responder === null) return null;
    return responder === targetMemberId ? "TARGET_APPROVED" : "DELEGATE_APPROVED";
  }

  if (consentStatus === "DECLINED") {
    // A refusal is an attributed act (MG4's audit rides respondedBy), so a
    // decline with nobody recorded as refusing is not an anonymous decline —
    // it is a row no writer should have produced.
    return requested && responded && responder !== null ? "DECLINED" : null;
  }

  // EXPIRED
  return requested && !responded && responder === null && consentExpiresAt !== null
    ? "EXPIRED"
    : null;
}

/**
 * The consent columns a guest row created in THIS release carries: all null.
 *
 * Every add MG1 can reach is family-scope (D-6), because a beyond-family add is
 * refused before any row is written. Exported as the single place a future
 * writer has to change, and asserted by the dark-guarantee tests.
 */
export const CONSENT_FREE_GUEST_COLUMNS: MemberGuestConsentColumns = {
  consentStatus: null,
  consentRequestedAt: null,
  consentRespondedAt: null,
  consentRespondedByMemberId: null,
  consentExpiresAt: null,
};
