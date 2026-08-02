import { describe, expect, it } from "vitest";

import type { HostingMemberFacts } from "@/lib/policies/adult-member-hosting";
import {
  evaluatePaidUpAdultPresence,
  formatMissingPaidUpAdultRefusal,
  formatUnpaidSubscriptionRateReason,
  memberUnpaidSubscriptionForcesNonMemberRate,
  participantIsPaidUpAdultMember,
  type PaidUpAdultParticipant,
} from "@/lib/policies/subscription-lockout-pricing";

const goodStandingAdult: HostingMemberFacts = {
  id: "m-adult",
  ageTier: "ADULT",
  active: true,
  cancelledAt: null,
  archivedAt: null,
};

const goodStandingChild: HostingMemberFacts = {
  ...goodStandingAdult,
  id: "m-child",
  ageTier: "CHILD",
};

const lapsedAdult: HostingMemberFacts = {
  ...goodStandingAdult,
  id: "m-lapsed",
  active: false,
};

function paidUpAdult(
  overrides: Partial<PaidUpAdultParticipant> = {},
): PaidUpAdultParticipant {
  return {
    member: goodStandingAdult,
    subscriptionSettled: true,
    ...overrides,
  };
}

describe("memberUnpaidSubscriptionForcesNonMemberRate (#2533 requirement 1)", () => {
  it("forces non-member rate for a member who owes an unpaid subscription", () => {
    expect(
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: true,
        subscriptionRequired: true,
        subscriptionPaid: false,
      }),
    ).toBe(true);
  });

  // Mutation guard: dropping the `subscriptionPaid === false` clause would force
  // non-member rates on a paid-up member — the club billing a paid member at the
  // wrong rate.
  it("does NOT force non-member rate once the subscription is paid", () => {
    expect(
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: true,
        subscriptionRequired: true,
        subscriptionPaid: true,
      }),
    ).toBe(false);
  });

  // Mutation guard: dropping the `subscriptionRequired === true` clause would
  // force non-member rates on a member the lockout never applied to (Xero off,
  // an opted-out membership type, or an exempt age tier).
  it("does NOT force non-member rate when a subscription is not required", () => {
    expect(
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: true,
        subscriptionRequired: false,
        subscriptionPaid: false,
      }),
    ).toBe(false);
  });

  // Mutation guard: dropping the `isMember === true` clause would have the rule
  // claim to "force" a non-member — who is already non-member-priced — muddying
  // the reason surfaced to them.
  it("does NOT apply to a true non-member", () => {
    expect(
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: false,
        subscriptionRequired: true,
        subscriptionPaid: false,
      }),
    ).toBe(false);
  });
});

describe("participantIsPaidUpAdultMember (#2533 requirement 3)", () => {
  it("counts an active, present, paid-up ADULT member", () => {
    expect(participantIsPaidUpAdultMember(paidUpAdult())).toBe(true);
  });

  // Mutation guard: dropping the `subscriptionSettled === true` clause would let
  // an unpaid adult satisfy the "paid-up adult present" requirement — exactly the
  // hole the owner's rule closes.
  it("does NOT count an adult member whose subscription is unpaid", () => {
    expect(
      participantIsPaidUpAdultMember(paidUpAdult({ subscriptionSettled: false })),
    ).toBe(false);
  });

  // Mutation guard: the #2364 standing half must still bind. A lapsed adult with
  // a paid subscription is not a member in good standing and cannot count.
  it("does NOT count a lapsed adult even with a settled subscription", () => {
    expect(
      participantIsPaidUpAdultMember(
        paidUpAdult({ member: lapsedAdult, subscriptionSettled: true }),
      ),
    ).toBe(false);
  });

  it("does NOT count a paid-up CHILD member (not an adult)", () => {
    expect(
      participantIsPaidUpAdultMember(paidUpAdult({ member: goodStandingChild })),
    ).toBe(false);
  });

  it("does NOT count an adult who is not operationally present (D-12)", () => {
    expect(
      participantIsPaidUpAdultMember(
        paidUpAdult({ operationallyPresent: false }),
      ),
    ).toBe(false);
  });

  it("does NOT count a non-member participant", () => {
    expect(
      participantIsPaidUpAdultMember(paidUpAdult({ member: null })),
    ).toBe(false);
  });
});

describe("evaluatePaidUpAdultPresence (#2533 requirement 3)", () => {
  it("passes when at least one paid-up adult is present alongside others", () => {
    const result = evaluatePaidUpAdultPresence([
      { member: null, subscriptionSettled: false },
      paidUpAdult({ member: goodStandingChild }),
      paidUpAdult(),
    ]);
    expect(result.hasPaidUpAdult).toBe(true);
    expect(result.refusalReason).toBeNull();
  });

  it("refuses a booking with no paid-up adult member and gives the reason", () => {
    const result = evaluatePaidUpAdultPresence([
      paidUpAdult({ subscriptionSettled: false }),
      paidUpAdult({ member: goodStandingChild }),
      { member: null, subscriptionSettled: true },
    ]);
    expect(result.hasPaidUpAdult).toBe(false);
    expect(result.refusalReason).toBe(formatMissingPaidUpAdultRefusal());
  });

  // Mutation guard: an empty party has no paid-up adult, so it must refuse rather
  // than vacuously pass.
  it("refuses an empty party", () => {
    const result = evaluatePaidUpAdultPresence([]);
    expect(result.hasPaidUpAdult).toBe(false);
    expect(result.refusalReason).not.toBeNull();
  });
});

describe("member-facing reasons (#2533 requirement 2)", () => {
  it("names the season and never promises a booking in the rate reason", () => {
    const reason = formatUnpaidSubscriptionRateReason("2026/2027");
    expect(reason).toContain("2026/2027");
    expect(reason).toMatch(/member rates aren't available/i);
    expect(reason).toMatch(/renew/i);
  });

  it("names neither a person nor an amount in the paid-up-adult refusal", () => {
    const reason = formatMissingPaidUpAdultRefusal();
    expect(reason).toMatch(/at least one paid-up adult member/i);
    expect(reason).not.toMatch(/\$/);
  });
});
