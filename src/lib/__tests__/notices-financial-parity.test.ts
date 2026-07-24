import { describe, expect, it, vi } from "vitest";

// Parity guard for the batched financial-status resolver introduced to remove
// the per-member N+1 in resolveNoticeAudienceMembers. The batched
// resolveFinancialStatusForMembers MUST agree, member-for-member, with the
// canonical single-member isMemberFinancial on a mixed fixture.
//
// This is a REAL parity test, not mock-against-mock: the membership-type policy
// resolution (resolveMembershipTypePoliciesForMembers /
// requiresPaidSubscriptionForMemberForBooking) runs for REAL against a
// fixture-backed prisma fake, exercised through BOTH code paths. Only the two
// global config seams (subscription enforcement + the age-tier rule) are stubbed
// — and stubbed CONSISTENTLY so the singular `requiresPaidSubscriptionForBooking`
// and the batched `enforcement && requiresPaidSubscriptionForAgeTier` agree.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/age-tier", () => ({ getAgeTierSettings: async () => [] }));

const h = vi.hoisted(() => {
  const SEASON = 2026;

  // Age tiers that owe a paid subscription when enforcement is on.
  const AGE_REQUIRES = new Set(["ADULT"]);
  const ENFORCEMENT = true;

  type FakeType = {
    id: string;
    key: string;
    name: string;
    isActive: boolean;
    isBuiltIn: boolean;
    bookingBehavior: string;
    subscriptionBehavior: "REQUIRED" | "NOT_REQUIRED" | "BASED_ON_AGE_TIER";
  };
  const mkType = (
    id: string,
    key: string,
    subscriptionBehavior: FakeType["subscriptionBehavior"],
  ): FakeType => ({
    id,
    key,
    name: key,
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior,
  });
  const requiredType = mkType("t-req", "FULL", "REQUIRED");
  const notRequiredType = mkType("t-life", "LIFE", "NOT_REQUIRED");
  const ageTierType = mkType("t-age", "AGE", "BASED_ON_AGE_TIER");

  // memberId -> assigned type + age tier, plus its current-season subscription.
  const spec: Array<{
    id: string;
    ageTier: string;
    type: FakeType;
    subStatus?: string;
  }> = [
    { id: "m1", ageTier: "ADULT", type: notRequiredType }, // exempt type
    { id: "m2", ageTier: "ADULT", type: requiredType, subStatus: "PAID" },
    { id: "m3", ageTier: "ADULT", type: requiredType, subStatus: "NOT_INVOICED" },
    { id: "m4", ageTier: "ADULT", type: requiredType }, // required, no row
    { id: "m5", ageTier: "SENIOR", type: requiredType }, // age exempt
    { id: "m6", ageTier: "ADULT", type: ageTierType, subStatus: "NOT_REQUIRED" }, // dominance
    { id: "m7", ageTier: "ADULT", type: ageTierType, subStatus: "PAID" },
    { id: "m8", ageTier: "ADULT", type: ageTierType }, // age requires, unpaid
  ];

  const members = spec.map((s) => ({
    id: s.id,
    firstName: s.id,
    lastName: "Member",
    email: `${s.id}@x.test`,
    role: "MEMBER",
    ageTier: s.ageTier,
  }));
  const assignments = spec.map((s) => ({
    memberId: s.id,
    seasonYear: SEASON,
    membershipType: s.type,
  }));
  const subs = spec
    .filter((s) => s.subStatus)
    .map((s) => ({ memberId: s.id, seasonYear: SEASON, status: s.subStatus! }));

  const prismaMock = {
    member: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        members.filter((m) => where.id.in.includes(m.id)),
    },
    seasonalMembershipAssignment: {
      findMany: async ({
        where,
      }: {
        where: { memberId: { in: string[] }; seasonYear: number };
      }) =>
        assignments.filter(
          (a) =>
            where.memberId.in.includes(a.memberId) &&
            a.seasonYear === where.seasonYear,
        ),
    },
    membershipType: {
      findMany: async () => [],
    },
    memberSubscription: {
      findUnique: async ({
        where,
      }: {
        where: { memberId_seasonYear: { memberId: string; seasonYear: number } };
      }) =>
        subs.find(
          (s) =>
            s.memberId === where.memberId_seasonYear.memberId &&
            s.seasonYear === where.memberId_seasonYear.seasonYear,
        ) ?? null,
      findFirst: async ({
        where,
      }: {
        where: { memberId: string; seasonYear: number; status: string };
      }) =>
        subs.find(
          (s) =>
            s.memberId === where.memberId &&
            s.seasonYear === where.seasonYear &&
            s.status === where.status,
        ) ?? null,
      findMany: async ({
        where,
      }: {
        where: { memberId: { in: string[] }; seasonYear: number };
      }) =>
        subs.filter(
          (s) =>
            where.memberId.in.includes(s.memberId) &&
            s.seasonYear === where.seasonYear,
        ),
    },
  };

  return { SEASON, AGE_REQUIRES, ENFORCEMENT, members, prismaMock, spec };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prismaMock }));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  isSubscriptionEnforcementActive: async () => h.ENFORCEMENT,
  requiresPaidSubscriptionForAgeTier: (ageTier: string) =>
    h.AGE_REQUIRES.has(ageTier),
  // Kept consistent with the two seams above so both code paths agree.
  requiresPaidSubscriptionForBooking: async (ageTier: string) =>
    h.ENFORCEMENT && h.AGE_REQUIRES.has(ageTier),
}));

import {
  isMemberFinancial,
  resolveFinancialStatusForMembers,
} from "@/lib/notices";

describe("resolveFinancialStatusForMembers parity with isMemberFinancial", () => {
  it("agrees member-for-member on a mixed fixture", async () => {
    const candidates = h.members.map((m) => ({ id: m.id, ageTier: m.ageTier }));

    const batched = await resolveFinancialStatusForMembers(candidates, h.SEASON);

    for (const member of h.members) {
      const single = await isMemberFinancial(h.prismaMock, {
        memberId: member.id,
        seasonYear: h.SEASON,
        ageTier: member.ageTier as never,
      });
      expect(
        batched.get(member.id),
        `financial parity for ${member.id}`,
      ).toBe(single);
    }
  });

  it("computes the expected financial status per branch", async () => {
    const candidates = h.members.map((m) => ({ id: m.id, ageTier: m.ageTier }));
    const batched = await resolveFinancialStatusForMembers(candidates, h.SEASON);

    // m1 exempt type; m2 required+PAID; m5 age-exempt; m6 NOT_REQUIRED dominance;
    // m7 age-tier required + PAID -> financial.
    expect(batched.get("m1")).toBe(true);
    expect(batched.get("m2")).toBe(true);
    expect(batched.get("m5")).toBe(true);
    expect(batched.get("m6")).toBe(true);
    expect(batched.get("m7")).toBe(true);
    // m3 required+unpaid; m4 required+no row; m8 age-tier required + unpaid.
    expect(batched.get("m3")).toBe(false);
    expect(batched.get("m4")).toBe(false);
    expect(batched.get("m8")).toBe(false);
  });

  it("resolves an empty candidate set without querying", async () => {
    const findMany = vi.spyOn(h.prismaMock.memberSubscription, "findMany");
    const result = await resolveFinancialStatusForMembers([], h.SEASON);
    expect(result.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
    findMany.mockRestore();
  });
});
