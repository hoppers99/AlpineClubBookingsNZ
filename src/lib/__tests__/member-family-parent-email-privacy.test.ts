/**
 * #2424 — a member may not learn the email address of a parent they share no
 * family group with.
 *
 * A parent link carries no shared-group requirement, so `GET /api/members/family`
 * could return the address of somebody outside the viewer's family entirely; and
 * since #2282 recorded parentage at any age, the reachable set includes
 * CHILDREN. Owner decision (2026-08-01): return a parent's email only where the
 * viewer shares a family group with that parent. Name and relationship still
 * show either way.
 *
 * The guard lives in `buildMemberFacingParentLinks`, on the server; these tests
 * assert on the ROUTE's JSON, so a client that merely stops rendering the field
 * cannot satisfy them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: vi.fn() },
    familyGroupMember: { findMany: vi.fn() },
    familyGroupJoinRequest: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/member-fields-settings", () => ({
  loadMemberFieldsFlags: vi.fn(async () => ({ showOccupation: false })),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { GET as getMemberFamilyRoute } from "@/app/api/members/family/route";
import { buildParentLinks } from "@/lib/member-parent-links";

const mockPrisma = prisma as unknown as {
  member: { findUnique: ReturnType<typeof vi.fn> };
  familyGroupMember: { findMany: ReturnType<typeof vi.fn> };
  familyGroupJoinRequest: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
};
const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;

/** A parent row as `FAMILY_MEMBER_PROFILE_SELECT` returns it. */
function parentRow(params: {
  id: string;
  firstName: string;
  email: string;
  ageTier?: string;
  groupIds?: string[];
}) {
  return {
    id: params.id,
    firstName: params.firstName,
    lastName: "Parent",
    email: params.email,
    ageTier: params.ageTier ?? "ADULT",
    active: true,
    canLogin: true,
    inheritEmailFromId: null,
    familyGroupMemberships: (params.groupIds ?? []).map((familyGroupId) => ({
      familyGroupId,
    })),
  };
}

function memberRow(params: {
  id: string;
  firstName: string;
  ageTier?: string;
  groupIds?: string[];
  parent?: ReturnType<typeof parentRow> | null;
  secondaryParent?: ReturnType<typeof parentRow> | null;
}) {
  return {
    id: params.id,
    firstName: params.firstName,
    lastName: "Smith",
    ageTier: params.ageTier ?? "ADULT",
    active: true,
    canLogin: true,
    role: "MEMBER",
    accessRoles: [],
    inheritEmailFromId: null,
    inheritEmailFrom: null,
    parent: params.parent ?? null,
    secondaryParent: params.secondaryParent ?? null,
    familyGroupMemberships: (params.groupIds ?? []).map((familyGroupId) => ({
      familyGroupId,
      familyGroup: { id: familyGroupId, name: `Group ${familyGroupId}` },
    })),
  };
}

type FamilyPayload = {
  familyMembers: Array<{
    id: string;
    parentLinks: Array<{
      id: string;
      firstName: string;
      lastName: string;
      parentLinkType: string;
      email?: string;
    }>;
  }>;
};

/**
 * The EXACT key sets the JSON may carry on each branch. Pinned as sorted key
 * arrays, not as "no `email` field": a builder that stopped whitelisting still
 * passes every field-by-field assertion while shipping the parent's whole row.
 */
const IN_GROUP_LINK_KEYS = [
  "active",
  "ageTier",
  "canLogin",
  "email",
  "firstName",
  "id",
  "inheritEmailFromId",
  "lastName",
  "parentLinkType",
];
/** No address AND no status for someone outside the viewer's family. */
const OUT_OF_GROUP_LINK_KEYS = [
  "firstName",
  "id",
  "inheritEmailFromId",
  "lastName",
  "parentLinkType",
];

async function fetchFamily(): Promise<FamilyPayload> {
  const res = await getMemberFamilyRoute();
  expect(res.status).toBe(200);
  return (await res.json()) as FamilyPayload;
}

function parentLinksFor(payload: FamilyPayload, memberId: string) {
  const member = payload.familyMembers.find((entry) => entry.id === memberId);
  expect(member, `member ${memberId} missing from payload`).toBeDefined();
  return member!.parentLinks;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "viewer" } });
  mockPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([]);
  mockPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
  mockPrisma.familyGroupMember.findMany.mockResolvedValue([]);
});

describe("GET /api/members/family — parent email visibility (#2424)", () => {
  it("omits the email of a parent the viewer shares no family group with", async () => {
    const outsider = parentRow({
      id: "outsider",
      firstName: "Outsider",
      email: "outsider@example.test",
      groupIds: ["g-other"],
    });
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: memberRow({
          id: "child",
          firstName: "Child",
          ageTier: "CHILD",
          groupIds: ["g1"],
          parent: outsider,
        }),
      },
    ]);

    const links = parentLinksFor(await fetchFamily(), "child");

    expect(links).toHaveLength(1);
    // Name and relationship still show — the address and the status fields go.
    expect(links[0]).toMatchObject({
      id: "outsider",
      firstName: "Outsider",
      lastName: "Parent",
      parentLinkType: "PRIMARY",
    });
    expect(Object.keys(links[0]).sort()).toEqual(OUT_OF_GROUP_LINK_KEYS);
    expect(links[0]).not.toHaveProperty("email");
    expect(links[0]).not.toHaveProperty("familyGroupMemberships");
    expect(JSON.stringify(links)).not.toContain("outsider@example.test");
  });

  it("returns the email of a parent the viewer shares a family group with", async () => {
    const insider = parentRow({
      id: "insider",
      firstName: "Insider",
      email: "insider@example.test",
      groupIds: ["g1"],
    });
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: memberRow({
          id: "child",
          firstName: "Child",
          ageTier: "CHILD",
          groupIds: ["g1"],
          parent: insider,
        }),
      },
    ]);

    const links = parentLinksFor(await fetchFamily(), "child");

    expect(links).toHaveLength(1);
    expect(links[0].email).toBe("insider@example.test");
    // The sharing branch is a whitelist too — it does not hand over the row.
    expect(Object.keys(links[0]).sort()).toEqual(IN_GROUP_LINK_KEYS);
    expect(links[0]).not.toHaveProperty("familyGroupMemberships");
  });

  it("drops the address of a MINOR parent outside the viewer's groups (#2282)", async () => {
    // Parentage is recorded at any age since #2282, so the addresses this
    // payload could reach stopped being other adults' and started including
    // children's.
    const minorOutsider = parentRow({
      id: "minor-outsider",
      firstName: "Teen",
      email: "teen@example.test",
      ageTier: "YOUTH",
      groupIds: ["g-other"],
    });
    const minorInsider = parentRow({
      id: "minor-insider",
      firstName: "Teenie",
      email: "teenie@example.test",
      ageTier: "YOUTH",
      groupIds: ["g1"],
    });
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: memberRow({
          id: "grandchild",
          firstName: "Grandchild",
          ageTier: "CHILD",
          groupIds: ["g1"],
          parent: minorOutsider,
          secondaryParent: minorInsider,
        }),
      },
    ]);

    const links = parentLinksFor(await fetchFamily(), "grandchild");

    expect(links.map((link) => link.id)).toEqual([
      "minor-outsider",
      "minor-insider",
    ]);
    expect(links[0]).not.toHaveProperty("email");
    // Nor does the payload say that this named stranger is a YOUTH.
    expect(links[0]).not.toHaveProperty("ageTier");
    expect(links[1].email).toBe("teenie@example.test");
    expect(JSON.stringify(links)).not.toContain("teen@example.test");
  });

  it("applies the same rule to the viewer's OWN parents", async () => {
    // The viewer is not exempt: a parent of theirs who is in none of their
    // groups is still somebody they have no family-group relationship with.
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({
        id: "viewer",
        firstName: "Viewer",
        groupIds: ["g1"],
        parent: parentRow({
          id: "my-outsider",
          firstName: "Estranged",
          email: "estranged@example.test",
          groupIds: [],
        }),
        secondaryParent: parentRow({
          id: "my-insider",
          firstName: "Together",
          email: "together@example.test",
          groupIds: ["g1"],
        }),
      }),
    );

    const links = parentLinksFor(await fetchFamily(), "viewer");

    expect(links[0]).not.toHaveProperty("email");
    expect(links[1].email).toBe("together@example.test");
  });

  it("asks the database for each parent's family groups", async () => {
    // Without this in the SELECT the guard has nothing to decide on and would
    // deny every address — a mocked client cannot notice a missing field, so
    // the query shape is pinned directly.
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1"] }),
    );

    await fetchFamily();

    const selfSelect = mockPrisma.member.findUnique.mock.calls[0][0].select;
    const groupSelect =
      mockPrisma.familyGroupMember.findMany.mock.calls[0][0].include.member
        .select;
    for (const select of [selfSelect, groupSelect]) {
      for (const parentKey of ["parent", "secondaryParent"] as const) {
        expect(select[parentKey].select.familyGroupMemberships).toEqual({
          select: { familyGroupId: true },
        });
      }
    }
  });

  it("shares a group through ANY of the viewer's groups, not just the first", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(
      memberRow({ id: "viewer", firstName: "Viewer", groupIds: ["g1", "g2"] }),
    );
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: memberRow({
          id: "child",
          firstName: "Child",
          ageTier: "CHILD",
          groupIds: ["g1"],
          parent: parentRow({
            id: "second-group-parent",
            firstName: "Second",
            email: "second@example.test",
            groupIds: ["g2"],
          }),
        }),
      },
    ]);

    const links = parentLinksFor(await fetchFamily(), "child");

    expect(links[0].email).toBe("second@example.test");
  });
});

describe("GET /api/member/onboarding — parent email visibility (#2424)", () => {
  // The onboarding payload lists the same family members through the same
  // builder, so it carried the same exposure and takes the same rule.

  /**
   * A group-member row exactly as `MEMBER_ONBOARDING_FAMILY_SELECT` returns
   * it — no `familyGroupMemberships` and no `inheritEmailFrom` at this level,
   * because the onboarding select asks for neither. The viewer's own row adds
   * `familyGroupMemberships` below, which its own select does read.
   */
  function onboardingMember(params: {
    id: string;
    parent?: ReturnType<typeof parentRow> | null;
  }) {
    return {
      id: params.id,
      email: `${params.id}@example.test`,
      firstName: "Fam",
      lastName: "Smith",
      role: "MEMBER",
      accessRoles: [],
      ageTier: "ADULT",
      active: true,
      canLogin: true,
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      profileCompletedAt: null,
      detailsConfirmedAt: null,
      detailsConfirmedByMemberId: null,
      onboardingConfirmedAt: null,
      inheritEmailFromId: null,
      parent: params.parent ?? null,
      secondaryParent: null,
    };
  }

  it("omits the email of a parent outside the viewer's family groups", async () => {
    mockPrisma.familyGroupJoinRequest.findMany.mockResolvedValue([]);
    mockPrisma.member.findUnique.mockResolvedValue({
      ...onboardingMember({ id: "viewer" }),
      familyGroupMemberships: [
        {
          familyGroupId: "g1",
          familyGroup: {
            id: "g1",
            name: "Smith Family",
            memberships: [
              {
                role: "MEMBER",
                member: onboardingMember({
                  id: "child",
                  parent: parentRow({
                    id: "outsider",
                    firstName: "Outsider",
                    email: "outsider@example.test",
                    groupIds: ["g-other"],
                  }),
                }),
              },
              {
                role: "MEMBER",
                member: onboardingMember({
                  id: "sibling",
                  parent: parentRow({
                    id: "insider",
                    firstName: "Insider",
                    email: "insider@example.test",
                    groupIds: ["g1"],
                  }),
                }),
              },
            ],
          },
        },
      ],
    });

    const { GET } = await import("@/app/api/member/onboarding/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      familyGroups: Array<{
        members: Array<{ id: string; parentLinks: Array<{ email?: string }> }>;
      }>;
    };

    const members = body.familyGroups[0].members;
    const child = members.find((entry) => entry.id === "child")!;
    const sibling = members.find((entry) => entry.id === "sibling")!;

    expect(child.parentLinks[0]).not.toHaveProperty("email");
    expect(sibling.parentLinks[0].email).toBe("insider@example.test");
    expect(JSON.stringify(body)).not.toContain("outsider@example.test");

    // Both branches are whitelists here too, pinned as exact key sets.
    expect(Object.keys(child.parentLinks[0]).sort()).toEqual(
      OUT_OF_GROUP_LINK_KEYS,
    );
    expect(Object.keys(sibling.parentLinks[0]).sort()).toEqual(
      IN_GROUP_LINK_KEYS,
    );

    // The family-scoped select is what feeds the guard; a mocked client cannot
    // notice it missing, so the query shape is pinned directly.
    const nestedSelect =
      mockPrisma.member.findUnique.mock.calls[0][0].select
        .familyGroupMemberships.select.familyGroup.select.memberships.select
        .member.select;
    for (const parentKey of ["parent", "secondaryParent"] as const) {
      expect(nestedSelect[parentKey].select.familyGroupMemberships).toEqual({
        select: { familyGroupId: true },
      });
    }
  });
});

describe("admin parent links are unchanged (#2424)", () => {
  it("buildParentLinks still carries the email for admin surfaces", () => {
    // The admin member detail payload builds its parent links from
    // `buildParentLinks`, which is deliberately untouched: this change narrows
    // the MEMBER-facing payload only.
    const links = buildParentLinks({
      parent: {
        id: "p1",
        firstName: "Pat",
        lastName: "Parent",
        email: "pat@example.test",
      },
      secondaryParent: {
        id: "p2",
        firstName: "Sam",
        lastName: "Parent",
        email: "sam@example.test",
      },
    });

    expect(links.map((link) => link.email)).toEqual([
      "pat@example.test",
      "sam@example.test",
    ]);
  });
});
