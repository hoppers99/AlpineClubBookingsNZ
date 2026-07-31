// "+ Add Member Guest" (epic #2305) MG2 (#2307) — WHO MAY ANSWER FOR SOMEBODY
// ELSE, AND WHO GETS TOLD.
//
// Owner decision D-5 chose delegated approval over emailed invite tokens, and
// D-10 set the interim rule this file pins: an ACTIVE, LOGIN-HOLDING ADULT who
// SHARES A FAMILY GROUP with the target. #2284 owns the final rule, which is why
// the production code is an interface rather than a function — but until then
// this is an authorization predicate on a path that can take a bed off a booking,
// so every conjunct of it is asserted separately.
//
// THE DELEGATE PATH IS NOT AN EDGE CASE. Owner decision D-9 makes any active
// member resolvable as a guest, and a large share of a club's members — children,
// and adults who share a household login — have no login of their own. A target
// with no login is therefore the NORMAL case, so `resolveNotificationRecipients`
// is on the hot path for both the consent request and the notify-only notice.
//
// TWO MUTATION PROBES, AND THEY MUST FAIL DIFFERENTLY. The rule is a conjunction
// of two imported predicates, and one test covering both would pass for the wrong
// reason — it would still fail if either conjunct were deleted, telling a reviewer
// nothing about which one is doing the work. So:
//
//   * Delete the `memberIdsShareFamilyGroup(...)` conjunct in
//     `canRespondForTarget` and exactly this test fails:
//     "refuses an adult the link query returned but who shares no group".
//   * Delete the `isActiveLoginAdultMember(actor)` conjunct and a DIFFERENT test
//     fails: "refuses a minor in the target's own family group".
//
// Both are named again at the tests themselves.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  familyAdultDelegateResolver,
  resolveDelegateAnswerRecipients,
} from "@/lib/member-guest-delegate";

// ---------------------------------------------------------------------------
// Fixture world
// ---------------------------------------------------------------------------
// Family group "fg-1" is the target's household and holds one of each kind of
// candidate, so the accept/reject matrix is exercised against a single query
// result rather than against four separately primed mocks. "fg-2" is somebody
// else's household; LONER belongs to no group at all.
const TARGET = "m-target";
const ADULT_DELEGATE = "m-adult-delegate";
const MINOR_SIBLING = "m-minor-sibling";
const NO_LOGIN_ADULT = "m-no-login-adult";
const INACTIVE_ADULT = "m-inactive-adult";
const NO_EMAIL_ADULT = "m-no-email-adult";
const OUTSIDE_ADULT = "m-outside-adult";
const LONER = "m-loner";
const LOGIN_TARGET = "m-login-target";
// A household adult who sits in the login-holding target's OWN family group, so
// "the rule refuses a delegate for a login-holding target" is a real refusal
// rather than "there was nobody to refuse".
const LOGIN_TARGET_HOUSEHOLD_ADULT = "m-login-target-spouse";
// Same again, but the club never captured an address for the target.
const LOGIN_TARGET_NO_EMAIL = "m-login-target-no-email";
const INACTIVE_TARGET = "m-inactive-target";
const UNGROUPED_TARGET = "m-ungrouped-target";

type MemberFixture = {
  active: boolean;
  canLogin: boolean;
  ageTier: string;
  email: string | null;
  firstName: string | null;
};

const MEMBERS: Record<string, MemberFixture> = {
  [TARGET]: { active: true, canLogin: false, ageTier: "ADULT", email: "target@example.com", firstName: "Tania" },
  [ADULT_DELEGATE]: { active: true, canLogin: true, ageTier: "ADULT", email: "adult@example.com", firstName: "Ada" },
  // A youth with a login of their own: the club gives teenagers logins, and a
  // teenager must still not be able to answer for another member.
  [MINOR_SIBLING]: { active: true, canLogin: true, ageTier: "YOUTH", email: "minor@example.com", firstName: "Milo" },
  [NO_LOGIN_ADULT]: { active: true, canLogin: false, ageTier: "ADULT", email: "nologin@example.com", firstName: "Nate" },
  [INACTIVE_ADULT]: { active: false, canLogin: true, ageTier: "ADULT", email: "lapsed@example.com", firstName: "Ivy" },
  // Everything the rule asks for, but nowhere to send the request.
  [NO_EMAIL_ADULT]: { active: true, canLogin: true, ageTier: "ADULT", email: null, firstName: "Nell" },
  [OUTSIDE_ADULT]: { active: true, canLogin: true, ageTier: "ADULT", email: "outside@example.com", firstName: "Otto" },
  [LONER]: { active: true, canLogin: true, ageTier: "ADULT", email: "loner@example.com", firstName: "Lou" },
  [LOGIN_TARGET]: { active: true, canLogin: true, ageTier: "ADULT", email: "login-target@example.com", firstName: "Lena" },
  [LOGIN_TARGET_HOUSEHOLD_ADULT]: { active: true, canLogin: true, ageTier: "ADULT", email: "spouse@example.com", firstName: "Sam" },
  [LOGIN_TARGET_NO_EMAIL]: { active: true, canLogin: true, ageTier: "ADULT", email: null, firstName: "Noa" },
  [INACTIVE_TARGET]: { active: false, canLogin: true, ageTier: "ADULT", email: "gone@example.com", firstName: "Gus" },
  [UNGROUPED_TARGET]: { active: true, canLogin: false, ageTier: "ADULT", email: "solo@example.com", firstName: "Sol" },
};

const FAMILY_LINKS: Record<string, string[]> = {
  [TARGET]: ["fg-1"],
  [ADULT_DELEGATE]: ["fg-1"],
  [MINOR_SIBLING]: ["fg-1"],
  [NO_LOGIN_ADULT]: ["fg-1"],
  [INACTIVE_ADULT]: ["fg-1"],
  [NO_EMAIL_ADULT]: ["fg-1"],
  // Deliberately households of their own: these two are TARGETS in their own
  // right, and putting them in fg-1 would make them incidental delegates for the
  // main target and blur what each test is asserting.
  [LOGIN_TARGET]: ["fg-3"],
  [LOGIN_TARGET_HOUSEHOLD_ADULT]: ["fg-3"],
  [LOGIN_TARGET_NO_EMAIL]: ["fg-3"],
  [INACTIVE_TARGET]: ["fg-4"],
  [OUTSIDE_ADULT]: ["fg-2"],
  [LONER]: [],
  [UNGROUPED_TARGET]: [],
};

type FindManyArgs = { where?: Record<string, unknown> };

/**
 * A stand-in for the two Prisma delegates the resolver touches, written by hand
 * rather than primed per call: the family-group queries ARE the thing under test,
 * so the fake has to answer them the way the database would.
 *
 * `extraLinks` exists for one specific test — see mutation probe 1 — where the
 * link query is made to return a member outside the requested groups, which is
 * how the in-memory family check is shown to be doing real work rather than
 * merely restating the `where` clause.
 */
function makeDb(options: { extraLinks?: { memberId: string; familyGroupId: string }[] } = {}) {
  const familyGroupMemberFindMany = vi.fn(async (args: FindManyArgs) => {
    const where = (args.where ?? {}) as {
      memberId?: string;
      familyGroupId?: { in: string[] };
    };
    if (where.memberId) {
      return (FAMILY_LINKS[where.memberId] ?? []).map((familyGroupId) => ({ familyGroupId }));
    }
    const groupIds = where.familyGroupId?.in ?? [];
    const rows: { memberId: string; familyGroupId: string }[] = [];
    for (const [memberId, groups] of Object.entries(FAMILY_LINKS)) {
      for (const familyGroupId of groups) {
        if (groupIds.includes(familyGroupId)) rows.push({ memberId, familyGroupId });
      }
    }
    return [...rows, ...(options.extraLinks ?? [])];
  });

  const memberFindMany = vi.fn(async (args: FindManyArgs) => {
    const ids = ((args.where ?? {}) as { id?: { in: string[] } }).id?.in ?? [];
    return ids
      .filter((id) => id in MEMBERS)
      .map((id) => ({ id, ...MEMBERS[id] }));
  });

  const memberFindUnique = vi.fn(async (args: FindManyArgs) => {
    const id = ((args.where ?? {}) as { id?: string }).id;
    return id && id in MEMBERS ? { id, ...MEMBERS[id] } : null;
  });

  return {
    db: {
      familyGroupMember: { findMany: familyGroupMemberFindMany },
      member: { findMany: memberFindMany, findUnique: memberFindUnique },
    } as never,
    familyGroupMemberFindMany,
    memberFindMany,
    memberFindUnique,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("canRespondForTarget — the D-10 accept/reject matrix", () => {
  async function canRespond(actorMemberId: string, targetMemberId = TARGET) {
    const { db } = makeDb();
    return familyAdultDelegateResolver.canRespondForTarget({
      actorMemberId,
      targetMemberId,
      db,
    });
  }

  it("accepts an active, login-holding adult in the target's family group", () => {
    // The only accepting case in the whole matrix. Everything below is a refusal,
    // and each refusal is for exactly one reason.
    return expect(canRespond(ADULT_DELEGATE)).resolves.toBe(true);
  });

  it("refuses a minor in the target's own family group", () => {
    // MUTATION PROBE 2 (the active-login-adult conjunct): delete
    // `isActiveLoginAdultMember(actor)` from `canRespondForTarget` and THIS test
    // fails, while the cross-family test still passes. A youth with their own
    // login shares the household and would otherwise sail through the family
    // check — deciding whether an adult may be put on somebody else's booking is
    // not a child's call to make.
    return expect(canRespond(MINOR_SIBLING)).resolves.toBe(false);
  });

  it("refuses a household adult who holds no login", () => {
    // Same probe as above, second conjunct of the same predicate. A member with no
    // login cannot have authenticated, so an actor id claiming to be them on this
    // path is not a person acting — it is a caller passing an id.
    return expect(canRespond(NO_LOGIN_ADULT)).resolves.toBe(false);
  });

  it("refuses a deactivated household adult", () => {
    // Membership having lapsed is exactly when somebody should stop being able to
    // act for their household.
    return expect(canRespond(INACTIVE_ADULT)).resolves.toBe(false);
  });

  it("refuses an adult in somebody else's family group", () => {
    // The ordinary cross-family refusal: OUTSIDE_ADULT satisfies every personal
    // conjunct and fails only on the family boundary. Note that the link query
    // alone already excludes them, which is why the probe below exists.
    return expect(canRespond(OUTSIDE_ADULT)).resolves.toBe(false);
  });

  it("refuses an adult the link query returned but who shares no group", async () => {
    // MUTATION PROBE 1 (the shared-family-group conjunct): delete
    // `memberIdsShareFamilyGroup(...)` from `canRespondForTarget` and THIS test
    // fails, while every minor/no-login/inactive test above still passes.
    //
    // Why the fixture has to be built this way. The candidate query already
    // filters to links in the target's own groups, so on a faithful database the
    // in-memory family check restates the `where` clause and deleting it changes
    // nothing observable. That redundancy is the point: the authorization answer
    // must not rest on a query filter alone, because #2284 is expected to WIDEN
    // that query when it replaces the rule. So the fake hands the resolver a link
    // row it did not ask for — an active login-holding adult carrying a group the
    // target is not in — and the in-memory check is the only thing left that can
    // refuse them.
    const { db } = makeDb({
      extraLinks: [{ memberId: OUTSIDE_ADULT, familyGroupId: "fg-2" }],
    });
    await expect(
      familyAdultDelegateResolver.canRespondForTarget({
        actorMemberId: OUTSIDE_ADULT,
        targetMemberId: TARGET,
        db,
      }),
    ).resolves.toBe(false);
  });

  it("refuses an adult in no family group at all", () => {
    return expect(canRespond(LONER)).resolves.toBe(false);
  });

  it("refuses a household adult answering for a target who holds their own login", async () => {
    // THE TARGET SIDE OF THE RULE, and it is half the rule. Every prose statement
    // of D-10 in this repository says a delegate answers for a member with NO
    // login of their own, but the predicate used to look only at the ACTOR. Two
    // spouses both added to the same booking is all it took: one signs in, reads
    // the other's guest id off the guest list the booking page serialises to
    // every viewer, and declines for them — releasing their bed, deleting their
    // guest row, and telling them nothing.
    //
    // `LOGIN_TARGET_HOUSEHOLD_ADULT` satisfies every ACTOR conjunct — active,
    // login-holding, adult, same family group — so this refusal can only come
    // from the target conjunct.
    //
    // Mutation probe 3: delete the `memberAnswersForThemselves(target)` check in
    // `canRespondForTarget` and exactly this test fails.
    await expect(
      canRespond(LOGIN_TARGET_HOUSEHOLD_ADULT, LOGIN_TARGET),
    ).resolves.toBe(false);
  });

  it("still accepts that same adult for a household member who has no login", async () => {
    // The other side of the probe: the adult refused above is not refused for
    // being the wrong sort of person, so the rule has not simply been broken.
    await expect(canRespond(ADULT_DELEGATE, TARGET)).resolves.toBe(true);
  });

  it("refuses a delegate for a login-holding target even with no address on file", async () => {
    // Whether the club happens to hold an email address changes who can be
    // REACHED, never who is entitled to decide. This member can sign in and
    // answer for themselves, so nobody answers for them — and nobody is emailed
    // an invitation only they can accept.
    await expect(
      canRespond(LOGIN_TARGET_HOUSEHOLD_ADULT, LOGIN_TARGET_NO_EMAIL),
    ).resolves.toBe(false);
  });

  it("refuses the target answering for themselves", async () => {
    // Not a refusal of the ACTION — the target answering for themselves is the
    // ordinary case — but a statement that this is not DELEGATION. The state
    // machine checks `actorMemberId === targetMemberId` first and never reaches
    // here, and keeping this function about one thing is what lets #2284 replace
    // the delegation rule without touching the self-answer path.
    await expect(canRespond(TARGET)).resolves.toBe(false);
    await expect(canRespond(LOGIN_TARGET, LOGIN_TARGET)).resolves.toBe(false);
  });

  it("refuses a target with no family group, without asking who its members are", async () => {
    // A target with no group has no delegate, and the resolver stops after the
    // first query rather than issuing an `IN ()` lookup for an empty group set.
    const { db, memberFindMany } = makeDb();
    await expect(
      familyAdultDelegateResolver.canRespondForTarget({
        actorMemberId: ADULT_DELEGATE,
        targetMemberId: UNGROUPED_TARGET,
        db,
      }),
    ).resolves.toBe(false);
    expect(memberFindMany).not.toHaveBeenCalled();
  });

  it("refuses empty actor or target ids outright", async () => {
    // A caller that lost a session id must not accidentally match a row with a
    // null member id; refuse before any query runs.
    const { db, familyGroupMemberFindMany } = makeDb();
    await expect(
      familyAdultDelegateResolver.canRespondForTarget({
        actorMemberId: "",
        targetMemberId: TARGET,
        db,
      }),
    ).resolves.toBe(false);
    await expect(
      familyAdultDelegateResolver.canRespondForTarget({
        actorMemberId: ADULT_DELEGATE,
        targetMemberId: "",
        db,
      }),
    ).resolves.toBe(false);
    expect(familyGroupMemberFindMany).not.toHaveBeenCalled();
  });

  /**
   * #2282 — a young member may now be RECORDED as a parent. That must buy them
   * nothing here, and the reason it cannot is structural rather than incidental:
   * this resolver never reads the parent columns at all. The rule is family-group
   * co-membership plus active-login-ADULT, and `MINOR_SIBLING` above is already
   * refused by the age conjunct whether or not they are anyone's parent.
   *
   * So the #2282-specific assertion is the one below: the two member reads this
   * path issues select `active`, `canLogin`, `ageTier` and contact fields, and
   * NOTHING about parentage. Add `parentMemberId` / `secondaryParentId` to either
   * select and this fails — which is the first move anyone would have to make to
   * let a parent link widen delegation, and it should require a decision rather
   * than sliding in as an extra select field.
   */
  it("decides without ever reading the parent columns (#2282)", async () => {
    const { db, memberFindMany, memberFindUnique } = makeDb();

    await expect(
      familyAdultDelegateResolver.canRespondForTarget({
        actorMemberId: MINOR_SIBLING,
        targetMemberId: TARGET,
        db,
      }),
    ).resolves.toBe(false);
    await familyAdultDelegateResolver.resolveNotificationRecipients({
      targetMemberId: TARGET,
      db,
    });

    const selects = [
      ...memberFindMany.mock.calls,
      ...memberFindUnique.mock.calls,
    ].map(([args]) => (args as { select?: Record<string, unknown> }).select);
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      expect(select).toBeDefined();
      expect(select).not.toHaveProperty("parentMemberId");
      expect(select).not.toHaveProperty("secondaryParentId");
      expect(select).not.toHaveProperty("parent");
      expect(select).not.toHaveProperty("dependents");
    }
  });
});

describe("resolveNotificationRecipients — who is told, and who is deliberately not", () => {
  async function recipients(targetMemberId: string) {
    const { db } = makeDb();
    return familyAdultDelegateResolver.resolveNotificationRecipients({
      targetMemberId,
      db,
    });
  }

  it("tells a target who holds a login, and copies in NO delegate", async () => {
    // The privacy half of D-5/D-10, and the reason this is not simply "email
    // everybody who could answer": being added to somebody's booking is that
    // member's own business. Fanning the request out to their household would
    // disclose it to people who have no part in it — and a login-holding member
    // needs no help answering.
    const list = await recipients(LOGIN_TARGET);
    expect(list).toEqual([
      {
        memberId: LOGIN_TARGET,
        email: "login-target@example.com",
        firstName: "Lena",
        isTarget: true,
      },
    ]);
    expect(list.filter((recipient) => !recipient.isTarget)).toEqual([]);
    // And there genuinely IS a household adult in fg-3 to have copied in, so this
    // is a refusal to fan out rather than an empty household.
    expect(list.map((recipient) => recipient.memberId)).not.toContain(
      LOGIN_TARGET_HOUSEHOLD_ADULT,
    );
  });

  it("tells nobody about a login-holding target it has no address for", async () => {
    // The honest answer, and the one that matches who may act: nobody may answer
    // for a member who holds a login, so mailing their household an invitation
    // they are not allowed to accept would only strand the request. The notifier
    // logs "nobody to notify" for exactly this shape.
    await expect(recipients(LOGIN_TARGET_NO_EMAIL)).resolves.toEqual([]);
  });

  it("tells every accepted family adult when the target has no login", async () => {
    // The normal case, not the exception (D-9: children and household-login
    // adults are both resolvable as guests). Exactly the adults the rule accepts
    // are told: the minor, the no-login adult, the deactivated adult and the adult
    // with no email address are all absent, and the target is not in the list
    // because there is no inbox to send to.
    const list = await recipients(TARGET);
    expect(list).toEqual([
      {
        memberId: ADULT_DELEGATE,
        email: "adult@example.com",
        firstName: "Ada",
        isTarget: false,
      },
    ]);
  });

  it("refuses to invent a recipient for a target with no family group", async () => {
    // Assert the empty list AND that nothing throws. The admin surface has to be
    // able to show "nobody could be told" plainly, rather than the request looking
    // sent — and an exception here would take the whole add down with it.
    await expect(recipients(UNGROUPED_TARGET)).resolves.toEqual([]);
  });

  it("tells nobody about a deactivated target", async () => {
    // Unreachable through the add paths, because an inactive member cannot be
    // resolved as a guest at all. It is asserted because a stale PENDING row must
    // not email somebody the club has deactivated.
    await expect(recipients(INACTIVE_TARGET)).resolves.toEqual([]);
  });

  it("tells nobody about a member id that does not exist", async () => {
    await expect(recipients("m-nobody")).resolves.toEqual([]);
  });

  it("copies in no delegate from another household", async () => {
    // MUTATION PROBE 1, second half: the same over-returning link query, on the
    // notification path rather than the authorization path. Deleting the
    // shared-group conjunct here would email a stranger somebody else's consent
    // request, which is a privacy incident rather than a bug.
    const { db } = makeDb({
      extraLinks: [{ memberId: OUTSIDE_ADULT, familyGroupId: "fg-2" }],
    });
    const list = await familyAdultDelegateResolver.resolveNotificationRecipients({
      targetMemberId: TARGET,
      db,
    });
    expect(list.map((recipient) => recipient.memberId)).toEqual([ADULT_DELEGATE]);
  });

  it("uses one definition of the family for both questions", async () => {
    // "Who may act" and "who is told" are answered by the same query pair on
    // purpose: two definitions of a family boundary on an authorization path is
    // the failure mode the shared `loadFamilyAdults` helper exists to avoid. This
    // asserts the two answers agree over the whole fixture household.
    const { db } = makeDb();
    const told = await familyAdultDelegateResolver.resolveNotificationRecipients({
      targetMemberId: TARGET,
      db,
    });
    for (const candidate of [
      ADULT_DELEGATE,
      MINOR_SIBLING,
      NO_LOGIN_ADULT,
      INACTIVE_ADULT,
      OUTSIDE_ADULT,
      LONER,
    ]) {
      const mayAct = await familyAdultDelegateResolver.canRespondForTarget({
        actorMemberId: candidate,
        targetMemberId: TARGET,
        db,
      });
      const isTold = told.some((recipient) => recipient.memberId === candidate);
      expect(isTold, `${candidate}: told and may-act disagree`).toBe(mayAct);
    }
  });

  it("may accept a delegate it cannot email, and that asymmetry is deliberate", async () => {
    // The one place the two answers legitimately diverge, stated rather than left
    // as a surprise. An adult with no email address on file satisfies every
    // conjunct of the rule, so if they DO log in they may answer — but there is
    // nowhere to send them the request, so they are not on the recipient list. The
    // alternative (refusing them the action because the club never captured an
    // address) would take a real power away for a data-entry reason.
    const { db } = makeDb();
    await expect(
      familyAdultDelegateResolver.canRespondForTarget({
        actorMemberId: NO_EMAIL_ADULT,
        targetMemberId: TARGET,
        db,
      }),
    ).resolves.toBe(true);
    const told = await familyAdultDelegateResolver.resolveNotificationRecipients({
      targetMemberId: TARGET,
      db,
    });
    expect(told.map((recipient) => recipient.memberId)).not.toContain(NO_EMAIL_ADULT);
  });
});

describe("resolveDelegateAnswerRecipients — who hears that somebody answered for them", () => {
  it("tells the member it was answered for, and the household adults who were asked", async () => {
    // The member comes FIRST and is included even though they have no login to
    // have answered with: not being able to ACT is not a reason not to be TOLD.
    // The adult who clicked is left out — they know — and nobody appears twice.
    const { db } = makeDb();
    const list = await resolveDelegateAnswerRecipients({
      resolver: familyAdultDelegateResolver,
      targetMemberId: TARGET,
      actorMemberId: ADULT_DELEGATE,
      db,
    });

    expect(list.map((recipient) => recipient.memberId)).toEqual([TARGET]);
    expect(list[0]).toMatchObject({ email: "target@example.com", isTarget: true });
  });

  it("leaves the adult who answered off their own notice", async () => {
    // Asserted against a household with TWO accepted adults, so "the actor is
    // absent" cannot pass merely because the list was empty.
    const { db } = makeDb();
    const list = await resolveDelegateAnswerRecipients({
      resolver: familyAdultDelegateResolver,
      targetMemberId: TARGET,
      actorMemberId: NO_EMAIL_ADULT,
      db,
    });

    const ids = list.map((recipient) => recipient.memberId);
    expect(ids).toContain(TARGET);
    expect(ids).toContain(ADULT_DELEGATE);
    expect(ids).not.toContain(NO_EMAIL_ADULT);
  });

  it("tells nobody when the club holds no address for anyone involved", async () => {
    // A target with no group and no delegates. Reported as an empty list rather
    // than as a send to nowhere, so the caller can log it for an operator.
    const { db } = makeDb();
    await expect(
      resolveDelegateAnswerRecipients({
        resolver: familyAdultDelegateResolver,
        targetMemberId: INACTIVE_TARGET,
        actorMemberId: ADULT_DELEGATE,
        db,
      }),
    ).resolves.toEqual([]);
  });
});
