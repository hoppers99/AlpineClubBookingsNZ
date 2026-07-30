import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import {
  buildMemberGuestConsentWrite,
  computeMemberGuestConsentExpiry,
  MEMBER_GUEST_MODULE_KEY,
  type MemberGuestAddActor,
  type MemberGuestAddNotification,
  type MemberGuestBoundaryState,
  type MemberGuestConsentColumns,
  type MemberGuestConsentSubStateId,
} from "@/lib/member-guest-consent";
import { loadMemberGuestSettings } from "@/lib/member-guest-settings";

/**
 * The per-request half of "+ Add Member Guest" (epic #2305, MG2 #2307): read the
 * policy ONCE, then decide what each new guest row must persist.
 *
 * WHY A SEPARATE MODULE FROM `member-guest-consent.ts`. That file is the pure,
 * database-free model — the eight-shape table, the expiry clamp, the single
 * writer of consent columns — and it stays that way so the state machine can be
 * tested and reasoned about without a Prisma client anywhere near it. This module
 * is the part that touches the world: it reads the module flag and the policy
 * singleton, and it walks a caller's guest array. Six call sites need exactly
 * these two things, and doing them six times by hand is how the six would drift.
 *
 * THE ORDERING RULE THIS MODULE EXISTS TO ENFORCE, and the one thing to check in
 * review: `loadMemberGuestAddPolicy` must be called BEFORE the caller opens its
 * transaction, and `planMemberGuestConsentWrites` is pure so it can be called
 * inside one. A settings read inside a booking transaction holds the per-lodge
 * capacity lock across a second query for no reason, and the guest-add route in
 * particular resolves its members INSIDE `prisma.$transaction` — which is exactly
 * the shape that invites somebody to drop a `loadMemberGuestSettings()` in there.
 * Splitting the impure read from the pure decision makes the correct order the
 * only one that type-checks: the plan takes a policy value, so the caller has to
 * have loaded it already.
 */

export interface MemberGuestAddPolicy {
  /**
   * Whether a beyond-family member may be added at all — the `memberGuests`
   * module flag, which MG2 turns into the real switch it always claimed to be.
   * Passed to `resolveLinkedBookingMembersWithBoundary`'s
   * `memberGuestWideningEnabled`, which defaults to `false` so a caller that
   * forgets keeps MG1's refusal.
   */
  wideningEnabled: boolean;
  /** D-3: ask the target first. `true` is the shipped default. */
  approvalRequired: boolean;
  /** D-4: how long a PENDING request holds its bed before the sweep releases it. */
  pendingHoldExpiryDays: number;
}

/**
 * Read the module flag and the policy singleton for one request.
 *
 * THE SETTINGS READ IS SKIPPED WHEN THE MODULE IS OFF, which is the state every
 * club ships in (D-2). With no widening there is no cross-family guest, so there
 * is no consent row to write and neither policy value can be consulted; issuing
 * the query anyway would put a second round trip on the hot path of every booking
 * create, quote and guest add on every club that never turns this on. The
 * defaults returned in that case are inert, not "assumed": nothing reads them
 * unless `wideningEnabled` is true.
 */
export async function loadMemberGuestAddPolicy(): Promise<MemberGuestAddPolicy> {
  const wideningEnabled = await isEffectiveModuleEnabled(MEMBER_GUEST_MODULE_KEY);
  if (!wideningEnabled) {
    return { wideningEnabled: false, approvalRequired: true, pendingHoldExpiryDays: 0 };
  }

  const settings = await loadMemberGuestSettings();
  return {
    wideningEnabled: true,
    approvalRequired: settings.approvalRequired,
    pendingHoldExpiryDays: settings.pendingHoldExpiryDays,
  };
}

/**
 * The fields MG2 attaches to a guest input on its way to being persisted.
 *
 * Both are optional and both are absent on every non-widened path, so a guest
 * built by any other flow is byte-identical to what it was before MG2.
 */
export interface MemberGuestConsentGuestFields {
  /**
   * The five consent columns this guest row must be created with, from
   * `buildMemberGuestConsentWrite`. Present only for a cross-family member guest:
   * a family-scope add (D-6) leaves this undefined rather than carrying five
   * explicit nulls, so the persistence layer writes exactly what it wrote before.
   */
  memberGuestConsent?: MemberGuestConsentColumns;
  /**
   * D-8: this guest is a cross-family member guest, so the three refusals that
   * would otherwise describe them collapse to one neutral message. Carried
   * separately from `memberGuestConsent` because the QUOTE paths need the
   * collapse and write no rows at all.
   */
  crossFamilyMemberGuest?: boolean;
}

/** One row's worth of "who has to be told what", collected for after the commit. */
export interface MemberGuestConsentWritePlanEntry {
  targetMemberId: string;
  notification: MemberGuestAddNotification;
  /** The sub-state `classifyMemberGuestConsent` must agree these columns are. */
  subState: MemberGuestConsentSubStateId;
}

export interface MemberGuestConsentWritePlan<Guest> {
  /** The caller's guests, with the MG2 fields attached where they apply. */
  guests: Array<Guest & MemberGuestConsentGuestFields>;
  /**
   * The cross-family rows this add creates, keyed by target member id — the input
   * to `member-guest-consent-notifications.ts` once the transaction has committed.
   * Empty on every family-scope add, which is what makes the post-commit send a
   * no-op for the overwhelming majority of bookings.
   */
  entriesByMemberId: Map<string, MemberGuestConsentWritePlanEntry>;
}

type GuestWithMemberId = { memberId?: string | null; isMember?: boolean };

function crossFamilyMemberIdOf(
  guest: GuestWithMemberId,
  boundary: MemberGuestBoundaryState,
): string | null {
  const memberId = guest.memberId?.trim();
  if (!memberId) return null;
  return boundary.scopeByMemberId.get(memberId) === "BEYOND_FAMILY" ? memberId : null;
}

/**
 * Decide the consent columns for every guest in one add, and collect the
 * notifications the caller owes after it commits.
 *
 * PURE. No database, no clock of its own — `now` is passed in so a test can pin
 * the expiry and so every row in one add carries the SAME timestamp. Safe to call
 * inside a transaction; see the ordering rule at the top of this file.
 *
 * The rules themselves are NOT re-derived here. Every decision comes from
 * `buildMemberGuestConsentWrite`, which is the single writer of consent columns
 * and the only place the eight-shape table is encoded, so a path that reached the
 * wrong conclusion would have to be wrong in that one function rather than in one
 * of six call sites.
 */
export function planMemberGuestConsentWrites<Guest extends GuestWithMemberId>(params: {
  guests: readonly Guest[];
  boundary: MemberGuestBoundaryState;
  actor: MemberGuestAddActor;
  now: Date;
  /**
   * The booking's check-in, for the D-4 expiry clamp. The stated check-in is the
   * right value even where guest nights could later expand the booking's envelope
   * earlier (#713): the clamp only ever moves the deadline EARLIER than
   * `now + pendingHoldExpiryDays`, and an envelope that expands backwards makes
   * the true first night sooner, so the clamp computed here is never later than
   * the one the final envelope would have produced.
   */
  bookingCheckIn: Date;
  policy: MemberGuestAddPolicy;
}): MemberGuestConsentWritePlan<Guest> {
  const { guests, boundary, actor, now, bookingCheckIn, policy } = params;
  const entriesByMemberId = new Map<string, MemberGuestConsentWritePlanEntry>();

  if (!policy.wideningEnabled) {
    // MODULE OFF — plan NOTHING, on every path including the admin ones, and this
    // is the case that needs stating because it is not the one it looks like.
    //
    // The widening flag gates RESOLUTION only on the paths that enforce
    // authorization. A `skipAuthorization` path (an admin or officer acting on
    // behalf, the admin booking-copy) has ALWAYS been able to resolve any member
    // id — that is what skipping authorization means, and it was true throughout
    // MG1. So without this early return, a club that never turned the module on
    // would still get consent columns written the moment an admin copied a booking
    // or added a guest on somebody's behalf, and MG1's promise — that a club which
    // has not opted in sees NO change whatsoever — would hold for members and
    // quietly fail for admins.
    //
    // The consequence, stated rather than hidden: with the module off, an admin
    // add of a cross-family member writes the same all-null row it wrote before
    // MG2 existed, so it is indistinguishable from a family-scope add. That is
    // MG1's behaviour exactly, and it is the right trade — the alternative is
    // writing feature data on a club that has not adopted the feature.
    return {
      guests: guests as Array<Guest & MemberGuestConsentGuestFields>,
      entriesByMemberId,
    };
  }

  const plannedGuests = guests.map((guest) => {
    const memberId = crossFamilyMemberIdOf(guest, boundary);
    if (!memberId) {
      // Family scope (D-6) or a non-member guest: nothing is attached, so the
      // persistence layer writes exactly the columns it wrote before MG2.
      return guest as Guest & MemberGuestConsentGuestFields;
    }

    const write = buildMemberGuestConsentWrite({
      scope: "BEYOND_FAMILY",
      approvalRequired: policy.approvalRequired,
      actor,
      now,
      // Only the approval-required MEMBER add consumes this; every other branch
      // of the writer ignores it and stores a null expiry. Computing it
      // unconditionally keeps the branch logic in one place — the writer's.
      consentExpiresAt: computeMemberGuestConsentExpiry({
        now,
        pendingHoldExpiryDays: policy.pendingHoldExpiryDays,
        bookingCheckIn,
      }),
    });

    if (write.notification !== "NONE") {
      // Keyed by member id, so two guest rows for the same member in one
      // malformed payload cannot mint two requests. The resolver de-duplicates
      // ids as well, so this is belt and braces rather than the only guard.
      entriesByMemberId.set(memberId, {
        targetMemberId: memberId,
        notification: write.notification,
        subState: write.subState,
      });
    }

    return {
      ...guest,
      memberGuestConsent: write.columns,
      crossFamilyMemberGuest: true,
    };
  });

  return { guests: plannedGuests, entriesByMemberId };
}

/** One committed guest row and the notification it owes. */
export interface MemberGuestAddNotificationRow {
  bookingGuestId: string;
  targetMemberId: string;
  notification: MemberGuestAddNotification;
}

/**
 * Match a plan built before the write to the guest rows the write created.
 *
 * The persisting paths know WHICH MEMBER owes a notification — the plan is keyed
 * by member id, because that is what the family boundary is computed over — but
 * only learn the guest ROW ids once the rows exist. Matching on `memberId` is
 * exact: `resolveLinkedBookingMembers` de-duplicates the requested ids, so one add
 * creates at most one row per member, and the plan carries only cross-family
 * members, so a family-scope guest for the same member cannot collide because it
 * is not in the plan at all. Rows created for members not in the plan are ignored,
 * so a caller may pass its whole created-guest list without filtering.
 *
 * WHY THIS LIVES HERE AND NOT WITH THE DISPATCHER. It is pure, and it is called
 * from INSIDE the transaction (that is the only place the created rows are in
 * hand), whereas the dispatcher pulls in the whole email/template graph. Keeping
 * the two apart lets every persisting call site import this statically and load
 * the sender with a dynamic import only when a notification is actually owed —
 * so a club with the module off, or any ordinary family booking, never loads the
 * mailer at all.
 */
export function matchMemberGuestNotificationRows(params: {
  createdGuests: ReadonlyArray<{ id: string; memberId: string | null }>;
  entriesByMemberId: ReadonlyMap<string, { notification: MemberGuestAddNotification }>;
}): MemberGuestAddNotificationRow[] {
  const rows: MemberGuestAddNotificationRow[] = [];
  for (const guest of params.createdGuests) {
    if (!guest.memberId) continue;
    const entry = params.entriesByMemberId.get(guest.memberId);
    if (!entry || entry.notification === "NONE") continue;
    rows.push({
      bookingGuestId: guest.id,
      targetMemberId: guest.memberId,
      notification: entry.notification,
    });
  }
  return rows;
}

/**
 * The quote-path half: mark the cross-family guests for D-8 and write nothing.
 *
 * `POST /api/bookings/quote` and `POST /api/bookings/[id]/modify-quote` must
 * resolve a cross-family member so the party PRICES correctly — a member guest
 * prices at member rates and counts toward the group discount, so a quote that
 * refused them would show the booker a figure the create path then contradicts —
 * but they persist no rows, so there is no consent to write and nobody to notify.
 * They still need the marker, and they need it MORE than the persisting paths do:
 * a quote is side-effect-free and rate-limited as a read, which makes it the
 * cheapest place to probe a stranger's occupancy or subscription status.
 */
export function markCrossFamilyMemberGuests<Guest extends GuestWithMemberId>(
  guests: readonly Guest[],
  boundary: MemberGuestBoundaryState,
): Array<Guest & MemberGuestConsentGuestFields> {
  return guests.map((guest) =>
    crossFamilyMemberIdOf(guest, boundary)
      ? { ...guest, crossFamilyMemberGuest: true }
      : (guest as Guest & MemberGuestConsentGuestFields),
  );
}
