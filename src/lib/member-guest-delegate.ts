import type { Prisma, PrismaClient } from "@prisma/client";
import {
  isActiveLoginAdultMember,
  memberIdsShareFamilyGroup,
} from "@/lib/booking-guests";

/**
 * Who may answer a member-guest consent request on somebody else's behalf
 * ("+ Add Member Guest", epic #2305, MG2 #2307).
 *
 * WHY THIS IS AN INTERFACE AND NOT JUST A FUNCTION. Owner decision **D-5** chose
 * delegated approval over emailed invite tokens, and **D-10** set the interim
 * rule — *an active, login-holding ADULT who shares a family group with the
 * target* — while explicitly deferring the final rule to #2284's own decisions.
 * The interface is the seam that lets #2284 replace the rule without touching the
 * state machine, the emails, the sweep, or the approval surfaces. It is the ONLY
 * part of MG2 that waits on anything.
 *
 * WHY THE DELEGATE PATH CARRIES REAL TRAFFIC RATHER THAN EDGE CASES. Owner
 * decision **D-9** makes any active member resolvable as a guest, and a large
 * share of a club's members — children, and adults on a household login — have no
 * login of their own. A target with no login is therefore the NORMAL case, not an
 * exception, so `resolveNotificationRecipients` is on the hot path for both the
 * consent request and the notify-only notice.
 */

type MemberGuestDelegateDb =
  | Pick<PrismaClient, "familyGroupMember" | "member">
  | Pick<Prisma.TransactionClient, "familyGroupMember" | "member">;

export interface MemberGuestConsentRecipient {
  memberId: string;
  email: string;
  firstName: string;
  /** True when this is the target answering for themselves. */
  isTarget: boolean;
}

export interface MemberGuestConsentDelegateResolver {
  /** May `actorMemberId` answer a request addressed to `targetMemberId`? */
  canRespondForTarget(params: {
    actorMemberId: string;
    targetMemberId: string;
    db: MemberGuestDelegateDb;
  }): Promise<boolean>;

  /**
   * Who is told about a request or an add: the target themselves when they hold a
   * login, otherwise every delegate the rule accepts.
   */
  resolveNotificationRecipients(params: {
    targetMemberId: string;
    db: MemberGuestDelegateDb;
  }): Promise<MemberGuestConsentRecipient[]>;
}

/**
 * Family-group adult lookup shared by both resolver methods.
 *
 * Deliberately ONE query pair used by both, so "who may act" and "who is told"
 * cannot drift into two different definitions of the same family.
 */
async function loadFamilyAdults(db: MemberGuestDelegateDb, targetMemberId: string) {
  const targetGroupLinks = await db.familyGroupMember.findMany({
    where: { memberId: targetMemberId },
    select: { familyGroupId: true },
  });

  const groupIds = [
    ...new Set(
      targetGroupLinks
        .map((link) => link.familyGroupId)
        .filter((groupId): groupId is string => Boolean(groupId)),
    ),
  ];

  if (groupIds.length === 0) {
    // A target with no family group has no delegate under D-10's rule. Stated
    // rather than implied: for such a target with no login, nobody can be asked
    // and nobody can be told, and the admin surface must show that plainly
    // instead of the request looking sent.
    return { groupsByMemberId: new Map<string, Set<string>>(), candidates: [] };
  }

  const links = await db.familyGroupMember.findMany({
    where: { familyGroupId: { in: groupIds } },
    select: { memberId: true, familyGroupId: true },
  });

  const groupsByMemberId = new Map<string, Set<string>>();
  for (const link of links) {
    if (!link.memberId) continue;
    const groups = groupsByMemberId.get(link.memberId) ?? new Set<string>();
    groups.add(link.familyGroupId);
    groupsByMemberId.set(link.memberId, groups);
  }
  // The target's own groups must be in the map too, or the shared-group
  // predicate below has nothing to compare against.
  groupsByMemberId.set(targetMemberId, new Set(groupIds));

  const candidateIds = [...groupsByMemberId.keys()].filter(
    (memberId) => memberId !== targetMemberId,
  );

  const candidates =
    candidateIds.length === 0
      ? []
      : await db.member.findMany({
          where: { id: { in: candidateIds } },
          select: {
            id: true,
            active: true,
            canLogin: true,
            ageTier: true,
            email: true,
            firstName: true,
          },
        });

  return { groupsByMemberId, candidates };
}

/**
 * Does this member answer for themselves?
 *
 * THE TARGET SIDE OF THE RULE, AND IT IS HALF THE RULE. Every prose statement of
 * D-10 in this repository — `docs/DOMAIN_INVARIANTS.md`, the docblock at the top
 * of this file, the consent page, the delegate page state machine — says a
 * delegate answers for a member **with no login of their own**. Both resolver
 * methods must therefore ask the same question about the target, not just about
 * the actor. `resolveNotificationRecipients` always did; `canRespondForTarget`
 * did not, which meant one adult in a household could answer — and silently
 * decline, releasing the bed and deleting the guest row — for a spouse who holds
 * a login and was never told. The two methods now share this one predicate so
 * they cannot drift apart again.
 *
 * Only `active` and `canLogin` are consulted, deliberately: whether the member
 * happens to have an email ADDRESS on file changes who can be reached, never who
 * is entitled to decide. A login-holding member with no address is nobody's
 * delegate case — they can sign in and answer, and the request simply cannot be
 * emailed to anyone.
 */
function memberAnswersForThemselves(
  member: { active: boolean | null; canLogin: boolean | null } | null | undefined,
): boolean {
  return member?.active === true && member.canLogin === true;
}

/**
 * The D-10 interim rule: an active, login-holding ADULT sharing a family group
 * with the target, answering for a target who has NO login of their own.
 *
 * The first two conjuncts are imported from `booking-guests.ts` rather than
 * re-written here — `isActiveLoginAdultMember` and `memberIdsShareFamilyGroup`
 * are the same two predicates the existing delegated-details-confirmation rule
 * uses, lifted out of their closures for exactly this reason. Re-implementing
 * either one would create a second, drifting definition of a family boundary on
 * an authorization path, which is the failure mode worth spending a refactor to
 * avoid. The third conjunct is `memberAnswersForThemselves` above, applied to the
 * TARGET.
 *
 * Mutation-verify (three probes, three DISTINCT failures — one test covering
 * them all would pass for the wrong reason): drop the shared-family-group
 * conjunct and a cross-family-adult test fails; drop the active-login-adult
 * conjunct and a minor/no-login/inactive ACTOR test fails; drop the target
 * conjunct and the login-holding-TARGET test fails.
 */
export const familyAdultDelegateResolver: MemberGuestConsentDelegateResolver = {
  async canRespondForTarget({ actorMemberId, targetMemberId, db }) {
    if (!actorMemberId || !targetMemberId) return false;
    // The target answering for themselves is not delegation, and callers check
    // that case first. Returning false here keeps this function about one thing.
    if (actorMemberId === targetMemberId) return false;

    const target = await db.member.findUnique({
      where: { id: targetMemberId },
      select: { id: true, active: true, canLogin: true },
    });
    // A member who can sign in decides for themselves, full stop. Nobody in
    // their household may answer on their behalf — not to accept, and above all
    // not to decline, which would release their bed and delete their guest row.
    if (memberAnswersForThemselves(target)) return false;

    const { groupsByMemberId, candidates } = await loadFamilyAdults(db, targetMemberId);
    const actor = candidates.find((candidate) => candidate.id === actorMemberId);

    return (
      isActiveLoginAdultMember(actor) &&
      memberIdsShareFamilyGroup(groupsByMemberId, targetMemberId, actorMemberId)
    );
  },

  async resolveNotificationRecipients({ targetMemberId, db }) {
    const target = await db.member.findUnique({
      where: { id: targetMemberId },
      select: {
        id: true,
        active: true,
        canLogin: true,
        email: true,
        firstName: true,
      },
    });

    // A target who holds a login is asked directly, and no delegate is copied in
    // — being added to a booking is that member's own business, and fanning the
    // request out to their household would disclose it to people who have no
    // part in it. That holds even when we have no address for them: since
    // `canRespondForTarget` refuses every delegate for a login-holding target,
    // falling back to the household here would email people an invitation only
    // the target can answer.
    if (memberAnswersForThemselves(target) && target) {
      return target.email
        ? [
            {
              memberId: target.id,
              email: target.email,
              firstName: target.firstName ?? "",
              isTarget: true,
            },
          ]
        : [];
    }

    if (target?.active !== true) {
      // An inactive member cannot be resolved as a guest at all, so this is
      // unreachable through the add paths; it is here so a stale row cannot
      // email somebody the club has deactivated.
      return [];
    }

    const { groupsByMemberId, candidates } = await loadFamilyAdults(db, targetMemberId);

    return candidates
      .filter(
        (candidate) =>
          isActiveLoginAdultMember(candidate) &&
          Boolean(candidate.email) &&
          memberIdsShareFamilyGroup(groupsByMemberId, targetMemberId, candidate.id),
      )
      .map((candidate) => ({
        memberId: candidate.id,
        email: candidate.email as string,
        firstName: candidate.firstName ?? "",
        isTarget: false,
      }));
  },
};

/**
 * Who is told that a DELEGATE answered — the missing half of the delegate story.
 *
 * A delegate answering is the one transition nobody downstream hears about
 * otherwise. The booking's owner is told the outcome, and the person who clicked
 * obviously knows; but the member the answer was GIVEN FOR, and the other adults
 * in the household who were sent the same request, would have learnt nothing —
 * and a decline releases a bed and takes that member off a booking somebody put
 * them on. "They just made the decision themselves" is true of a target
 * answering for themselves and false of a delegate, so this list exists.
 *
 * The target comes first and is included whenever we hold an address for them,
 * even though they have no login to have answered with: not being able to ACT is
 * not a reason not to be TOLD. The rest of the list is the same recipient set the
 * request itself went to, minus whoever answered, resolved through the injected
 * resolver so #2284 can replace the rule in one place.
 */
export async function resolveDelegateAnswerRecipients(params: {
  resolver: MemberGuestConsentDelegateResolver;
  targetMemberId: string;
  actorMemberId: string;
  db: MemberGuestDelegateDb;
}): Promise<MemberGuestConsentRecipient[]> {
  const { resolver, targetMemberId, actorMemberId, db } = params;

  const target = await db.member.findUnique({
    where: { id: targetMemberId },
    select: { id: true, active: true, email: true, firstName: true },
  });

  const recipients: MemberGuestConsentRecipient[] = [];
  if (target?.active === true && target.email) {
    recipients.push({
      memberId: target.id,
      email: target.email,
      firstName: target.firstName ?? "",
      isTarget: true,
    });
  }

  const asked = await resolver.resolveNotificationRecipients({ targetMemberId, db });
  for (const recipient of asked) {
    if (recipient.memberId === actorMemberId) continue;
    if (recipients.some((existing) => existing.memberId === recipient.memberId)) continue;
    recipients.push(recipient);
  }

  return recipients;
}
