import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The #2543 enforcement matrix: what each of the three club modes does to a
 * party, and what the resulting refusal carries.
 *
 * `evaluateNonMemberPricingRequirements` is the ONE thing all five booking write
 * paths call for the new behaviour, so this file is where "consistent across
 * every write path" is actually pinned down — the five routes then only have to
 * be shown to call it (see the enforcement call-site coverage at the end).
 */

const mocks = vi.hoisted(() => ({
  peekSubscriptionLockoutMode: vi.fn(),
  resolveMembershipTypePoliciesForMembers: vi.fn(),
}));

vi.mock("@/lib/member-subscription-eligibility", () => ({
  peekSubscriptionLockoutMode: mocks.peekSubscriptionLockoutMode,
}));

vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePoliciesForMembers:
    mocks.resolveMembershipTypePoliciesForMembers,
}));

// Real age-tier rule, driven by real settings rows: ADULT and YOUTH owe a
// subscription, CHILD and INFANT do not.
vi.mock("@/lib/age-tier", () => ({
  getAgeTierSettings: vi.fn(async () => [
    { tier: "INFANT", subscriptionRequiredForBooking: false },
    { tier: "CHILD", subscriptionRequiredForBooking: false },
    { tier: "YOUTH", subscriptionRequiredForBooking: true },
    { tier: "ADULT", subscriptionRequiredForBooking: true },
  ]),
}));

import { parseDateOnly } from "@/lib/date-only";
import { violationFingerprint } from "@/lib/booking-exception-requests";
import {
  isHardStopBookingFailureCode,
  isPolicyExceptionReasonCode,
} from "@/lib/booking-policy-exceptions";
import {
  PaidUpAdultMemberRequiredError,
  buildPaidUpAdultRefusalBody,
  evaluateNonMemberPricingRequirements,
  evaluateProposedPaidUpAdultPresence,
  loadUnpaidSubscriptionMemberIds,
  toSubscriptionLockoutParticipants,
  type SubscriptionLockoutDb,
} from "@/lib/subscription-lockout-enforcement";

const SEASON = 2026;
const CHECK_IN = parseDateOnly("2026-07-04");
const CHECK_OUT = parseDateOnly("2026-07-06");

type TestMember = {
  id: string;
  ageTier: "ADULT" | "YOUTH" | "CHILD" | "INFANT";
  active?: boolean;
  cancelledAt?: Date | null;
  archivedAt?: Date | null;
  /** Season subscription status; omit for "no row at all". */
  status?: "PAID" | "UNPAID" | "NOT_INVOICED" | "NOT_REQUIRED";
  /** Effective membership-type subscription behaviour. */
  behavior?: "REQUIRED" | "NOT_REQUIRED" | "BASED_ON_AGE_TIER";
};

/** A paid-up adult member: the participant the rule requires to be present. */
const PAID_ADULT: TestMember = { id: "adult-paid", ageTier: "ADULT", status: "PAID" };
/** An adult member whose season subscription is required and unpaid. */
const UNPAID_ADULT: TestMember = {
  id: "adult-unpaid",
  ageTier: "ADULT",
  status: "NOT_INVOICED",
};
/** A member the subscription rule never applies to (exempt age tier). */
const EXEMPT_CHILD: TestMember = { id: "child-exempt", ageTier: "CHILD" };

function makeDb(members: TestMember[]): SubscriptionLockoutDb {
  const rows = members.map((member) => ({
    id: member.id,
    ageTier: member.ageTier,
    active: member.active ?? true,
    cancelledAt: member.cancelledAt ?? null,
    archivedAt: member.archivedAt ?? null,
  }));
  const subs = members
    .filter((member) => member.status !== undefined)
    .map((member) => ({ memberId: member.id, status: member.status! }));

  mocks.resolveMembershipTypePoliciesForMembers.mockImplementation(
    async (_db: unknown, params: { memberIds: string[] }) =>
      new Map(
        params.memberIds.map((id) => [
          id,
          {
            subscriptionBehavior:
              members.find((member) => member.id === id)?.behavior ?? "REQUIRED",
          },
        ]),
      ),
  );

  return {
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        rows.filter((row) => args.where.id.in.includes(row.id)),
      ),
    },
    memberSubscription: {
      findMany: vi.fn(
        async (args: { where: { memberId: { in: string[] } } }) =>
          subs.filter((sub) => args.where.memberId.in.includes(sub.memberId)),
      ),
    },
  } as unknown as SubscriptionLockoutDb;
}

function participantsFor(members: TestMember[]) {
  return members.map((member) => ({
    isMember: true as const,
    memberId: member.id,
  }));
}

function evaluate(
  members: TestMember[],
  participants: Array<{
    isMember: boolean;
    memberId?: string | null;
    operationallyPresent?: boolean;
  }> = participantsFor(members),
) {
  return evaluateNonMemberPricingRequirements(makeDb(members), {
    lodgeId: "lodge-1",
    seasonYear: SEASON,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    participants,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
});

// ---------------------------------------------------------------------------
// The mode axis: two of the three modes must be a total no-op.
// ---------------------------------------------------------------------------

describe("the mode gate (#2543)", () => {
  it.each(["NO_BLOCK", "HARD_BLOCK"] as const)(
    "%s adds nothing at all, before touching the database",
    async (mode) => {
      mocks.peekSubscriptionLockoutMode.mockResolvedValue(mode);
      const db = makeDb([UNPAID_ADULT]);

      await expect(
        evaluateNonMemberPricingRequirements(db, {
          mode,
          lodgeId: "lodge-1",
          seasonYear: SEASON,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          participants: participantsFor([UNPAID_ADULT]),
        }),
      ).resolves.toBeNull();

      // Not merely "no violation" — no query, no notice, no work. This is what
      // keeps the default (HARD_BLOCK) byte-identical to pre-#2543 and is the
      // property the whole opt-in design rests on.
      expect(db.member.findMany).not.toHaveBeenCalled();
      expect(db.memberSubscription.findMany).not.toHaveBeenCalled();
      expect(mocks.resolveMembershipTypePoliciesForMembers).not.toHaveBeenCalled();
    },
  );

  it("resolves the mode itself when the caller did not pass one", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("HARD_BLOCK");
    await expect(evaluate([UNPAID_ADULT])).resolves.toBeNull();
    expect(mocks.peekSubscriptionLockoutMode).toHaveBeenCalledTimes(1);
  });

  it("honours a caller-supplied mode over its own read", async () => {
    // The five write paths resolve the mode once and pass it down, so the party is
    // judged against exactly the mode the HARD_BLOCK gate branched on. An admin
    // saving the setting mid-request must not make one request refuse under one
    // regime and price under the other.
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NO_BLOCK");
    const result = await evaluateNonMemberPricingRequirements(
      makeDb([UNPAID_ADULT, PAID_ADULT]),
      {
        mode: "NON_MEMBER_PRICING",
        lodgeId: "lodge-1",
        seasonYear: SEASON,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        participants: participantsFor([UNPAID_ADULT, PAID_ADULT]),
      },
    );
    expect(result).not.toBeNull();
    expect(mocks.peekSubscriptionLockoutMode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NON_MEMBER_PRICING: who is repriced.
// ---------------------------------------------------------------------------

describe("NON_MEMBER_PRICING — who is repriced (#2543)", () => {
  it("reprices an adult member whose required subscription is unpaid", async () => {
    const result = await evaluate([UNPAID_ADULT, PAID_ADULT]);
    expect(result?.repricedMemberIds).toEqual(["adult-unpaid"]);
  });

  it("does not reprice a paid-up member", async () => {
    const result = await evaluate([PAID_ADULT]);
    expect(result?.repricedMemberIds).toEqual([]);
  });

  it("does not reprice a member whose type says NOT_REQUIRED", async () => {
    const result = await evaluate([
      { ...UNPAID_ADULT, behavior: "NOT_REQUIRED" },
      PAID_ADULT,
    ]);
    expect(result?.repricedMemberIds).toEqual([]);
  });

  it("does not reprice an exempt age tier even with no subscription row", async () => {
    const result = await evaluate([EXEMPT_CHILD, PAID_ADULT]);
    expect(result?.repricedMemberIds).toEqual([]);
  });

  it("honours the #2041 BASED_ON_AGE_TIER dominance of a NOT_REQUIRED row", async () => {
    const result = await evaluate([
      {
        id: "youth-exempted",
        ageTier: "YOUTH",
        behavior: "BASED_ON_AGE_TIER",
        status: "NOT_REQUIRED",
      },
      PAID_ADULT,
    ]);
    expect(result?.repricedMemberIds).toEqual([]);
  });

  it("never reprices a row whose isMember snapshot is false", async () => {
    // A non-member already prices at the non-member rate, so asking about their
    // subscription would be a pointless query and a pointless disclosure.
    const result = await evaluate([PAID_ADULT], [
      { isMember: true, memberId: "adult-paid" },
      { isMember: false, memberId: null },
    ]);
    expect(result?.repricedMemberIds).toEqual([]);
  });

  it("reprices an unresolvable member id — the safe direction on money", async () => {
    // A member id with no Member row must never silently price at member rates.
    const result = await evaluate([PAID_ADULT], [
      { isMember: true, memberId: "adult-paid" },
      { isMember: true, memberId: "ghost-member" },
    ]);
    expect(result?.repricedMemberIds).toEqual(["ghost-member"]);
  });

  it("returns a sorted, de-duplicated reprice list", async () => {
    const second: TestMember = {
      id: "adult-unpaid-2",
      ageTier: "ADULT",
      status: "UNPAID",
    };
    const result = await evaluate([second, UNPAID_ADULT, PAID_ADULT], [
      { isMember: true, memberId: "adult-unpaid-2" },
      { isMember: true, memberId: "adult-unpaid" },
      // Same member twice (two guest rows, e.g. a split stay).
      { isMember: true, memberId: "adult-unpaid" },
      { isMember: true, memberId: "adult-paid" },
    ]);
    expect(result?.repricedMemberIds).toEqual([
      "adult-unpaid",
      "adult-unpaid-2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// NON_MEMBER_PRICING: the paid-up-adult requirement.
// ---------------------------------------------------------------------------

describe("NON_MEMBER_PRICING — the paid-up-adult requirement (#2543)", () => {
  it("passes a repriced party that has a paid-up adult member on it", async () => {
    const result = await evaluate([UNPAID_ADULT, PAID_ADULT]);
    expect(result?.paidUpAdultMemberRequired).toBe(true);
    expect(result?.hasPaidUpAdultMember).toBe(true);
    expect(result?.violation).toBeNull();
  });

  it("refuses a repriced party with no paid-up adult member", async () => {
    const result = await evaluate([UNPAID_ADULT, EXEMPT_CHILD]);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
    expect(result?.violation?.reasonCode).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
  });

  it("the unpaid member does not satisfy the requirement themselves", async () => {
    // The whole point of the rule: otherwise it would be vacuous.
    const result = await evaluate([UNPAID_ADULT]);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
  });

  it("a paid-up but NOT operationally present adult does not satisfy it (D-12)", async () => {
    // An unaccepted member-guest invite is not a responsible adult at the lodge,
    // and the arrival roster, kiosk and bed allocation all already agree.
    const result = await evaluate([UNPAID_ADULT, PAID_ADULT], [
      { isMember: true, memberId: "adult-unpaid" },
      { isMember: true, memberId: "adult-paid", operationallyPresent: false },
    ]);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
  });

  it("a lapsed adult with a paid subscription does not satisfy it", async () => {
    const result = await evaluate([
      UNPAID_ADULT,
      { id: "adult-lapsed", ageTier: "ADULT", status: "PAID", active: false },
    ]);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
  });

  it("a paid-up YOUTH member does not satisfy it — the rule asks for an adult", async () => {
    const result = await evaluate([
      UNPAID_ADULT,
      { id: "youth-paid", ageTier: "YOUTH", status: "PAID" },
    ]);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).not.toBeNull();
  });

  // The scoping decision, and the regression this guards is a real one: an
  // unconditional requirement would make switching to NON_MEMBER_PRICING — a
  // RELAXATION of the hard block — newly refuse whole classes of booking that are
  // legal today and have nothing to do with subscriptions.
  it("does NOT apply to a party nobody is being repriced on", async () => {
    const result = await evaluate([EXEMPT_CHILD]);
    expect(result?.repricedMemberIds).toEqual([]);
    expect(result?.paidUpAdultMemberRequired).toBe(false);
    expect(result?.hasPaidUpAdultMember).toBe(false);
    expect(result?.violation).toBeNull();
  });

  it("does NOT apply to an all-non-member party", async () => {
    const result = await evaluate([], [
      { isMember: false, memberId: null },
      { isMember: false, memberId: null },
    ]);
    expect(result?.paidUpAdultMemberRequired).toBe(false);
    expect(result?.violation).toBeNull();
  });

  it("does NOT apply to an empty party", async () => {
    const result = await evaluate([], []);
    expect(result?.paidUpAdultMemberRequired).toBe(false);
    expect(result?.violation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tell them why.
// ---------------------------------------------------------------------------

describe("the member-facing notice (#2543 / #2533 requirement 2)", () => {
  it("names the season and appears exactly when somebody is repriced", async () => {
    const repriced = await evaluate([UNPAID_ADULT, PAID_ADULT]);
    expect(repriced?.memberRateNotice).toContain("2026/2027");
    expect(repriced?.memberRateNotice).toMatch(/renew/i);

    const clean = await evaluate([PAID_ADULT]);
    expect(clean?.memberRateNotice).toBeNull();
  });

  it("names nobody and no amount — a family member may be reading it", async () => {
    const result = await evaluate([UNPAID_ADULT, PAID_ADULT]);
    expect(result?.memberRateNotice).not.toMatch(/adult-unpaid|\$/);
  });
});

// ---------------------------------------------------------------------------
// The refusal: 409, exception-eligible, HOLD, and a door the member can enter.
// ---------------------------------------------------------------------------

describe("the refusal payload (#2543)", () => {
  it("freezes the party's nights, sorted and de-duplicated", async () => {
    const result = await evaluate([UNPAID_ADULT, EXEMPT_CHILD]);
    expect(result?.violation?.affectedNights).toEqual([
      "2026-07-04",
      "2026-07-05",
    ]);
  });

  it("uses a guest's own stay window when they carry one", async () => {
    const db = makeDb([UNPAID_ADULT]);
    const result = await evaluateNonMemberPricingRequirements(db, {
      mode: "NON_MEMBER_PRICING",
      lodgeId: "lodge-1",
      seasonYear: SEASON,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      participants: [
        {
          isMember: true,
          memberId: "adult-unpaid",
          // A string is accepted: the create and group-join paths carry the
          // member's raw request values this far.
          stayStart: "2026-07-05",
          stayEnd: "2026-07-06",
        },
      ],
    });
    expect(result?.violation?.affectedNights).toEqual(["2026-07-05"]);
  });

  it("is a 409 that carries the exception door and the HOLD promise", async () => {
    const result = await evaluate([UNPAID_ADULT]);
    const error = new PaidUpAdultMemberRequiredError(result!.violation!);

    // 409, not 403: this booking IS permitted, by a Booking Officer, through the
    // exception-request workflow — the state of the party is what conflicts.
    expect(error.status).toBe(409);
    expect(error.code).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");

    const body = buildPaidUpAdultRefusalBody(result!.violation!);
    expect(body).toMatchObject({
      code: "PAID_UP_ADULT_MEMBER_REQUIRED",
      exceptionRequestPath: "/api/bookings/exception-requests",
    });
    expect(body.error).toBe(result!.violation!.message);
    expect(body.violations).toHaveLength(1);
    // The client relies on this to promise that requesting an override keeps the
    // beds (owner decision 4).
    expect(body.exceptionReview.capacityMode).toBe("HOLD");
  });

  it("is exception-eligible and NOT a hard stop", async () => {
    // The two subscription hard stops (SUBSCRIPTION_REQUIRED /
    // GUEST_SUBSCRIPTION_REQUIRED) may never enter review; this refusal must.
    expect(isPolicyExceptionReasonCode("PAID_UP_ADULT_MEMBER_REQUIRED")).toBe(
      true,
    );
    expect(isHardStopBookingFailureCode("PAID_UP_ADULT_MEMBER_REQUIRED")).toBe(
      false,
    );
  });

  it("fingerprints the HAZARD, not who is unpaid", async () => {
    // The hazard an admin reviewed is "this party has nobody paid-up on it", and
    // it is the same hazard whether the unpaid member is Alice or Bob.
    // Fingerprinting identities would reopen a decided review every time the party
    // was re-saved with the same shape.
    const alice = await evaluate([{ ...UNPAID_ADULT, id: "alice" }]);
    const bob = await evaluate([{ ...UNPAID_ADULT, id: "bob" }]);

    expect(violationFingerprint(alice!.violation!)).toBe(
      violationFingerprint(bob!.violation!),
    );
    expect(violationFingerprint(alice!.violation!)).toContain("repriced=1");
    expect(violationFingerprint(alice!.violation!)).not.toMatch(/alice|bob/);
  });

  it("fingerprints a differently-shaped party differently", async () => {
    const one = await evaluate([UNPAID_ADULT]);
    const two = await evaluate([
      UNPAID_ADULT,
      { id: "adult-unpaid-2", ageTier: "ADULT", status: "UNPAID" },
    ]);
    expect(violationFingerprint(one!.violation!)).not.toBe(
      violationFingerprint(two!.violation!),
    );
  });
});

// ---------------------------------------------------------------------------
// The proposed-party form, and the hosting bridge.
// ---------------------------------------------------------------------------

describe("evaluateProposedPaidUpAdultPresence (#2543 <-> #2365)", () => {
  it("reproduces the same refusal a booking path raised", async () => {
    // A member refused by a booking path re-submits the same party as an override
    // request; the request machinery re-evaluates server-side and must get the
    // SAME answer from the SAME rule, or the refusal names a door that is shut.
    const violation = await evaluateProposedPaidUpAdultPresence(
      makeDb([UNPAID_ADULT]),
      {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [{ isMember: true, memberId: "adult-unpaid", nights: ["2026-07-04"] }],
      },
    );
    expect(violation?.reasonCode).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
    expect(violation?.affectedNights).toEqual(["2026-07-04"]);
  });

  it("returns null when the party is compliant — nothing to review", async () => {
    await expect(
      evaluateProposedPaidUpAdultPresence(makeDb([UNPAID_ADULT, PAID_ADULT]), {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [
          { isMember: true, memberId: "adult-unpaid" },
          { isMember: true, memberId: "adult-paid" },
        ],
      }),
    ).resolves.toBeNull();
  });

  it("returns null outside NON_MEMBER_PRICING", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("HARD_BLOCK");
    await expect(
      evaluateProposedPaidUpAdultPresence(makeDb([UNPAID_ADULT]), {
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [{ isMember: true, memberId: "adult-unpaid" }],
      }),
    ).resolves.toBeNull();
  });
});

describe("loadUnpaidSubscriptionMemberIds — the hosting bridge (#2543 <-> #2364)", () => {
  it("names the unpaid members under NON_MEMBER_PRICING", async () => {
    const unpaid = await loadUnpaidSubscriptionMemberIds(
      makeDb([UNPAID_ADULT, PAID_ADULT, EXEMPT_CHILD]),
      {
        memberIds: ["adult-unpaid", "adult-paid", "child-exempt"],
        seasonYear: SEASON,
      },
    );
    expect([...unpaid]).toEqual(["adult-unpaid"]);
  });

  it.each(["NO_BLOCK", "HARD_BLOCK"] as const)(
    "is empty under %s, so hosting stays byte-identical for a club that has not opted in",
    async (mode) => {
      mocks.peekSubscriptionLockoutMode.mockResolvedValue(mode);
      const unpaid = await loadUnpaidSubscriptionMemberIds(
        makeDb([UNPAID_ADULT]),
        { memberIds: ["adult-unpaid"], seasonYear: SEASON },
      );
      expect(unpaid.size).toBe(0);
    },
  );

  it("is empty for an empty request, without reading the mode", async () => {
    const unpaid = await loadUnpaidSubscriptionMemberIds(makeDb([]), {
      memberIds: [null, undefined, "  "],
      seasonYear: SEASON,
    });
    expect(unpaid.size).toBe(0);
    expect(mocks.peekSubscriptionLockoutMode).not.toHaveBeenCalled();
  });
});

describe("toSubscriptionLockoutParticipants", () => {
  it("treats a PENDING member-guest invite as not operationally present", async () => {
    const participants = toSubscriptionLockoutParticipants([
      { isMember: true, memberId: "adult-paid", memberGuestConsentStatus: "PENDING" },
      { isMember: true, memberId: "adult-paid-2", memberGuestConsentStatus: "CONFIRMED" },
      // A pre-persist party has no consent facts yet; absent means present.
      { isMember: true, memberId: "adult-paid-3" },
    ]);
    expect(participants.map((p) => p.operationallyPresent)).toEqual([
      false,
      true,
      true,
    ]);
  });
});
