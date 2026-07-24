import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  membershipTypeFindUnique: vi.fn(),
  membershipTypeFindMany: vi.fn(),
  memberSubscriptionFindUnique: vi.fn(),
  seasonalFindMany: vi.fn(),
  lodgeAccessFindMany: vi.fn(),
  committeeAssignmentFindMany: vi.fn(),
  noticeFindMany: vi.fn(),
  noticeFindFirst: vi.fn(),
  noticeFindUnique: vi.fn(),
  noticeCount: vi.fn(),
  requiresPaid: vi.fn(),
  defaultKeyForRole: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique, findMany: mocks.memberFindMany },
    membershipType: {
      findUnique: mocks.membershipTypeFindUnique,
      findMany: mocks.membershipTypeFindMany,
    },
    memberSubscription: { findUnique: mocks.memberSubscriptionFindUnique },
    seasonalMembershipAssignment: { findMany: mocks.seasonalFindMany },
    memberLodgeAccess: { findMany: mocks.lodgeAccessFindMany },
    committeeAssignment: { findMany: mocks.committeeAssignmentFindMany },
    notice: {
      findMany: mocks.noticeFindMany,
      findFirst: mocks.noticeFindFirst,
      findUnique: mocks.noticeFindUnique,
      count: mocks.noticeCount,
    },
  },
}));

vi.mock("@/lib/membership-type-policy", () => ({
  requiresPaidSubscriptionForMemberForBooking: mocks.requiresPaid,
}));

vi.mock("@/lib/membership-types", () => ({
  defaultMembershipTypeKeyForRole: mocks.defaultKeyForRole,
}));

import {
  getMemberAudienceKeys,
  getNoticeForMember,
  getUnreadNoticeCount,
  listNoticesForMember,
  serializeNoticeForMember,
  visibleNoticeWhere,
  type MemberAudienceKeys,
} from "@/lib/notices";

const NOW = new Date("2026-07-15T00:00:00.000Z");

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    role: "USER",
    ageTier: "ADULT",
    seasonalMembershipAssignments: [] as Array<{ membershipTypeId: string }>,
    lodgeAccess: [] as Array<{ lodgeId: string }>,
    committeeAssignments: [] as Array<{ committeeRoleId: string }>,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.defaultKeyForRole.mockReturnValue("FULL");
  mocks.requiresPaid.mockResolvedValue(false);
  mocks.membershipTypeFindUnique.mockResolvedValue({ id: "type-full" });
  mocks.memberSubscriptionFindUnique.mockResolvedValue(null);
});

describe("getMemberAudienceKeys", () => {
  it("uses an explicit season assignment over the role fallback", async () => {
    mocks.memberFindUnique.mockResolvedValue(
      memberRow({
        seasonalMembershipAssignments: [{ membershipTypeId: "type-assigned" }],
        lodgeAccess: [{ lodgeId: "lodge-1" }, { lodgeId: "lodge-2" }],
        committeeAssignments: [{ committeeRoleId: "role-1" }],
      }),
    );

    const keys = await getMemberAudienceKeys("member-1", { now: NOW });

    expect(keys).toEqual({
      memberId: "member-1",
      membershipTypeIds: ["type-assigned"],
      lodgeIds: ["lodge-1", "lodge-2"],
      committeeRoleIds: ["role-1"],
      isFinancial: true,
    });
    // Role fallback lookup is not consulted when an assignment exists.
    expect(mocks.membershipTypeFindUnique).not.toHaveBeenCalled();
  });

  it("falls back to the role's built-in type when there is no assignment", async () => {
    mocks.memberFindUnique.mockResolvedValue(memberRow());
    mocks.defaultKeyForRole.mockReturnValue("FULL");
    mocks.membershipTypeFindUnique.mockResolvedValue({ id: "type-full" });

    const keys = await getMemberAudienceKeys("member-1", { now: NOW });

    expect(mocks.membershipTypeFindUnique).toHaveBeenCalledWith({
      where: { key: "FULL" },
      select: { id: true },
    });
    expect(keys?.membershipTypeIds).toEqual(["type-full"]);
  });

  it("returns null for an unknown member", async () => {
    mocks.memberFindUnique.mockResolvedValue(null);
    expect(await getMemberAudienceKeys("nope", { now: NOW })).toBeNull();
  });

  it("marks a paid current-season subscriber financial when a subscription is required", async () => {
    mocks.memberFindUnique.mockResolvedValue(memberRow());
    mocks.requiresPaid.mockResolvedValue(true);
    mocks.memberSubscriptionFindUnique.mockResolvedValue({ status: "PAID" });

    const keys = await getMemberAudienceKeys("member-1", { now: NOW });
    expect(keys?.isFinancial).toBe(true);
  });

  it("marks an unpaid required member NOT financial", async () => {
    mocks.memberFindUnique.mockResolvedValue(memberRow());
    mocks.requiresPaid.mockResolvedValue(true);
    mocks.memberSubscriptionFindUnique.mockResolvedValue({ status: "NOT_INVOICED" });

    const keys = await getMemberAudienceKeys("member-1", { now: NOW });
    expect(keys?.isFinancial).toBe(false);
  });

  it("treats an exempt member (subscription not required) as financial", async () => {
    mocks.memberFindUnique.mockResolvedValue(memberRow());
    mocks.requiresPaid.mockResolvedValue(false);

    const keys = await getMemberAudienceKeys("member-1", { now: NOW });
    expect(keys?.isFinancial).toBe(true);
    // No subscription lookup needed when the member is exempt.
    expect(mocks.memberSubscriptionFindUnique).not.toHaveBeenCalled();
  });
});

describe("visibleNoticeWhere", () => {
  const financialKeys: MemberAudienceKeys = {
    memberId: "member-1",
    membershipTypeIds: ["type-1"],
    lodgeIds: ["lodge-1"],
    committeeRoleIds: ["role-1"],
    isFinancial: true,
  };

  it("requires PUBLISHED, past publishedAt, and unexpired", () => {
    const where = visibleNoticeWhere(financialKeys, NOW);
    expect(where.status).toBe("PUBLISHED");
    expect(where.publishedAt).toEqual({ lte: NOW });
    // Expiry OR is nested under AND.
    const expiryClause = (where.AND as Array<Record<string, unknown>>)[0];
    expect(expiryClause).toEqual({
      OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
    });
  });

  it("for a financial member, group matches ignore financialMembersOnly", () => {
    const where = visibleNoticeWhere(financialKeys, NOW);
    const audienceOr = (where.AND as Array<{ OR?: unknown[] }>)[1].OR as Array<
      Record<string, unknown>
    >;
    // First branch: explicit MEMBER target.
    expect(audienceOr[0]).toEqual({
      audiences: { some: { kind: "MEMBER", memberId: "member-1" } },
    });
    // Second branch: group match with NO financialMembersOnly gate.
    expect(audienceOr[1]).not.toHaveProperty("financialMembersOnly");
  });

  it("for a non-financial member, group matches require financialMembersOnly=false", () => {
    const where = visibleNoticeWhere({ ...financialKeys, isFinancial: false }, NOW);
    const audienceOr = (where.AND as Array<{ OR?: unknown[] }>)[1].OR as Array<
      Record<string, unknown>
    >;
    // Explicit MEMBER branch still unconditional.
    expect(audienceOr[0]).toEqual({
      audiences: { some: { kind: "MEMBER", memberId: "member-1" } },
    });
    // Group branch gated to non-financial-only notices.
    expect(audienceOr[1]).toMatchObject({ financialMembersOnly: false });
  });

  it("omits group branches the member has no keys for", () => {
    const where = visibleNoticeWhere(
      {
        memberId: "member-1",
        membershipTypeIds: [],
        lodgeIds: [],
        committeeRoleIds: [],
        isFinancial: true,
      },
      NOW,
    );
    const audienceOr = (where.AND as Array<{ OR?: unknown[] }>)[1].OR as Array<{
      audiences: { some: { OR?: unknown[] } };
    }>;
    const groupOr = audienceOr[1].audiences.some.OR as Array<Record<string, unknown>>;
    // Only the ALL_MEMBERS group branch remains.
    expect(groupOr).toEqual([{ kind: "ALL_MEMBERS" }]);
  });
});

describe("serializeNoticeForMember", () => {
  const base = {
    id: "notice-1",
    title: "Hut closed",
    bodyHtml: "<p>Closed</p>",
    publishedAt: new Date("2026-07-10T00:00:00.000Z"),
    expiresAt: null,
    pinned: true,
    requiresAcknowledgement: true,
  };

  it("reports unread when there is no receipt", () => {
    const view = serializeNoticeForMember({ ...base, readReceipts: [] });
    expect(view.read).toBe(false);
    expect(view.acknowledged).toBe(false);
    expect(view.readAt).toBeNull();
  });

  it("reports read and acknowledged from the member's own receipt", () => {
    const view = serializeNoticeForMember({
      ...base,
      readReceipts: [
        {
          readAt: new Date("2026-07-11T00:00:00.000Z"),
          acknowledgedAt: new Date("2026-07-12T00:00:00.000Z"),
        },
      ],
    });
    expect(view.read).toBe(true);
    expect(view.acknowledged).toBe(true);
    expect(view.readAt).toBe("2026-07-11T00:00:00.000Z");
    expect(view.acknowledgedAt).toBe("2026-07-12T00:00:00.000Z");
  });

  it("never leaks audience or financialMembersOnly fields", () => {
    const view = serializeNoticeForMember({ ...base, readReceipts: [] });
    expect(view).not.toHaveProperty("financialMembersOnly");
    expect(view).not.toHaveProperty("audiences");
  });
});

describe("listNoticesForMember", () => {
  it("orders pinned first then newest published, and applies the limit", async () => {
    mocks.memberFindUnique.mockResolvedValue(memberRow());
    mocks.noticeFindMany.mockResolvedValue([]);

    await listNoticesForMember("member-1", { limit: 3, now: NOW });

    expect(mocks.noticeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ pinned: "desc" }, { publishedAt: "desc" }],
        take: 3,
      }),
    );
  });

  it("returns an empty list for an unknown member", async () => {
    mocks.memberFindUnique.mockResolvedValue(null);
    expect(await listNoticesForMember("nope", { now: NOW })).toEqual([]);
    expect(mocks.noticeFindMany).not.toHaveBeenCalled();
  });
});

describe("getUnreadNoticeCount", () => {
  it("counts visible notices the member has not read", async () => {
    mocks.memberFindUnique.mockResolvedValue(memberRow());
    mocks.noticeCount.mockResolvedValue(2);

    const count = await getUnreadNoticeCount("member-1", { now: NOW });

    expect(count).toBe(2);
    expect(mocks.noticeCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "PUBLISHED",
          readReceipts: { none: { memberId: "member-1" } },
        }),
      }),
    );
  });
});

describe("getNoticeForMember", () => {
  it("returns null when the notice is out of audience (findFirst miss)", async () => {
    mocks.memberFindUnique.mockResolvedValue(memberRow());
    mocks.noticeFindFirst.mockResolvedValue(null);

    expect(await getNoticeForMember("member-1", "notice-x", { now: NOW })).toBeNull();
  });

  it("scopes the detail fetch by both id and the visibility predicate", async () => {
    mocks.memberFindUnique.mockResolvedValue(memberRow());
    mocks.noticeFindFirst.mockResolvedValue({
      id: "notice-1",
      title: "Hi",
      bodyHtml: "<p>Hi</p>",
      publishedAt: NOW,
      expiresAt: null,
      pinned: false,
      requiresAcknowledgement: false,
      readReceipts: [],
    });

    await getNoticeForMember("member-1", "notice-1", { now: NOW });

    const arg = mocks.noticeFindFirst.mock.calls[0][0];
    expect(arg.where.id).toBe("notice-1");
    expect(arg.where.status).toBe("PUBLISHED");
  });
});
