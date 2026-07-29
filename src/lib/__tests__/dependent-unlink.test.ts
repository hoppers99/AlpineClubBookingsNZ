import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { DELETE } from "@/app/api/admin/members/[id]/dependents/[dependentId]/route";

type MockMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: "INFANT" | "CHILD" | "YOUTH" | "ADULT";
  active: boolean;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  inheritParentEmail: boolean;
  inheritEmailFromId: string | null;
  canLogin: boolean;
  archivedAt: Date | null;
};

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;

function makeRequest() {
  return new NextRequest("http://localhost/api/admin/members/parent-1/dependents/child-1", {
    method: "DELETE",
  });
}

function makeParent(overrides: Partial<MockMember> = {}): MockMember {
  return {
    id: "parent-1",
    firstName: "Parent",
    lastName: "Member",
    email: "parent@example.com",
    ageTier: "ADULT",
    active: true,
    parentMemberId: null,
    secondaryParentId: null,
    inheritParentEmail: false,
    inheritEmailFromId: null,
    canLogin: true,
    archivedAt: null,
    ...overrides,
  };
}

function makeDependent(overrides: Partial<MockMember> = {}): MockMember {
  return {
    id: "child-1",
    firstName: "Child",
    lastName: "Member",
    email: "child@example.com",
    ageTier: "CHILD",
    active: true,
    parentMemberId: "parent-1",
    secondaryParentId: null,
    inheritParentEmail: true,
    inheritEmailFromId: "parent-1",
    canLogin: false,
    archivedAt: null,
    ...overrides,
  };
}

function setupTransaction(members: MockMember[]) {
  const membersById = new Map(members.map((member) => [member.id, member]));

  const tx = {
    member: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const member = membersById.get(where.id);
        if (!member) return null;
        // The route selects the parent RELATIONS, not just the columns, so the
        // stub has to project them — derived from the columns rather than
        // hand-set on each fixture, so a fixture cannot claim a parent link in
        // one place and deny it in the other. Without this the route saw
        // `secondaryParent: undefined` for a member that plainly had one and
        // silently took the "no remaining parent" branch.
        const relation = (id: string | null) =>
          id ? (membersById.get(id) ?? null) : null;
        return {
          ...member,
          parent: relation(member.parentMemberId),
          secondaryParent: relation(member.secondaryParentId),
        };
      }),
      // #2255: the transitive email resolver re-reads the remaining parent's
      // chain a level at a time. Only the "these ids" shape is issued here.
      findMany: vi.fn(async ({ where }: { where: any }) => {
        if (!where?.id?.in) {
          throw new Error(
            `unexpected member.findMany shape: ${JSON.stringify(where)}`
          );
        }
        const wanted = new Set<string>(where.id.in);
        return members.filter((member) => wanted.has(member.id));
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const member = membersById.get(where.id);
        if (!member) return null;
        return {
          ...member,
          parentMemberId: data.parent?.disconnect ? null : member.parentMemberId,
          secondaryParentId: data.secondaryParent?.disconnect ? null : member.secondaryParentId,
          inheritParentEmail: data.inheritParentEmail ?? member.inheritParentEmail,
          inheritEmailFromId: data.inheritEmailFrom?.disconnect
            ? null
            : member.inheritEmailFromId,
        };
      }),
    },
    auditLog: {
      create: vi.fn(async () => ({})),
    },
  };

  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx));

  return tx;
}

async function unlinkDependent(parentId = "parent-1", dependentId = "child-1") {
  return DELETE(makeRequest(), {
    params: Promise.resolve({ id: parentId, dependentId }),
  });
}

describe("DELETE /api/admin/members/[id]/dependents/[dependentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(adminSession);
    mockRequireActiveSessionUser.mockResolvedValue(null);
  });

  it("removes the parent link and clears inherited email from that parent", async () => {
    const tx = setupTransaction([makeParent(), makeDependent()]);

    const res = await unlinkDependent();

    expect(res.status).toBe(200);
    expect(tx.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "child-1" },
        data: expect.objectContaining({
          parent: { disconnect: true },
          inheritParentEmail: false,
          inheritEmailFrom: { disconnect: true },
        }),
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "member.dependent.unlink",
          memberId: "admin-1",
          targetId: "child-1",
        }),
      })
    );
  });

  it("keeps manual email inheritance when unlinking the parent", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeDependent({
        inheritParentEmail: false,
        inheritEmailFromId: "manual-source",
      }),
    ]);

    const res = await unlinkDependent();

    expect(res.status).toBe(200);
    expect(tx.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          parent: { disconnect: true },
        },
      })
    );
  });

  /**
   * #2255. Inheritance is DERIVED from a parent link or chosen by hand, and the
   * unlink route has to tell the two apart. It used to do that by asking
   * whether the stored pointer named this parent or this parent's own source —
   * a one-hop test that made sense only while resolution was one hop.
   *
   * Once resolution walks up the family, a derived pointer routinely names an
   * ancestor two or three hops away, and the one-hop test called it "manual"
   * and left it in place: the member ended up with no parent link at all and a
   * permanent inheritance from someone they were no longer connected to, with
   * the response and audit both reporting `clearedEmailInheritance: false`.
   *
   * The flag `inheritParentEmail` is the provenance record, so that is what
   * decides. These cases pin both halves of it at depth.
   */
  describe("provenance of the stored source at depth (#2255)", () => {
    it("clears a pointer inherited from the GRANDparent, not just the parent", async () => {
      const tx = setupTransaction([
        makeParent({ email: "walk-in-1@no-email.invalid", parentMemberId: "gp-1" }),
        makeParent({ id: "gp-1", email: "gp@example.com" }),
        makeDependent({ inheritEmailFromId: "gp-1" }),
      ]);

      const res = await unlinkDependent();

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            parent: { disconnect: true },
            inheritParentEmail: false,
            inheritEmailFrom: { disconnect: true },
          }),
        })
      );
      expect((await res.json()).clearedEmailInheritance).toBe(true);
    });

    it("clears a pointer inherited from the GREAT-grandparent", async () => {
      const tx = setupTransaction([
        makeParent({ email: "walk-in-1@no-email.invalid", parentMemberId: "gp-1" }),
        makeParent({
          id: "gp-1",
          email: "walk-in-2@no-email.invalid",
          parentMemberId: "ggp-1",
        }),
        makeParent({ id: "ggp-1", email: "ggp@example.com" }),
        makeDependent({ inheritEmailFromId: "ggp-1" }),
      ]);

      const res = await unlinkDependent();

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inheritParentEmail: false,
            inheritEmailFrom: { disconnect: true },
          }),
        })
      );
    });

    it("re-resolves through the REMAINING parent's chain, not just the parent", async () => {
      // Two parents; the primary is unlinked. The secondary has no mailbox of
      // their own, so the child falls back onto the secondary's own ancestor
      // rather than losing club email entirely.
      const tx = setupTransaction([
        makeParent(),
        makeParent({
          id: "parent-2",
          email: "walk-in-2@no-email.invalid",
          parentMemberId: "gp-2",
        }),
        makeParent({ id: "gp-2", email: "gp2@example.com" }),
        makeDependent({ secondaryParentId: "parent-2" }),
      ]);

      const res = await unlinkDependent();

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            parent: { connect: { id: "parent-2" } },
            secondaryParent: { disconnect: true },
            inheritParentEmail: true,
            inheritEmailFrom: { connect: { id: "gp-2" } },
          }),
        })
      );
    });

    it("never stores a CHAINED pointer when the remaining parent's source now inherits", async () => {
      // #2255 (R2). parent-2's stored source is gp-2, but gp-2 has since been
      // linked as a dependant and inherits from ggp-2. This route has no
      // validator behind it, so an un-terminal answer from the resolver would be
      // written straight to the database and quietly break the flat-terminal
      // invariant that lets every reader resolve email in ONE hop.
      const tx = setupTransaction([
        makeParent(),
        makeParent({
          id: "parent-2",
          email: "walk-in-2@no-email.invalid",
          inheritEmailFromId: "gp-2",
          parentMemberId: "gp-2",
        }),
        makeParent({
          id: "gp-2",
          email: "gp2@example.com",
          inheritEmailFromId: "ggp-2",
          parentMemberId: "ggp-2",
        }),
        makeParent({ id: "ggp-2", email: "ggp2@example.com" }),
        makeDependent({ secondaryParentId: "parent-2" }),
      ]);

      const res = await unlinkDependent();

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inheritParentEmail: true,
            inheritEmailFrom: { connect: { id: "ggp-2" } },
          }),
        })
      );
    });

    it("still leaves a MANUAL source alone even when it names an ancestor", async () => {
      // The distinguishing case for the provenance flag: the stored id is one
      // the derived path could also have produced, but the admin chose it, so
      // unlinking a parent must not touch it.
      const tx = setupTransaction([
        makeParent({ parentMemberId: "gp-1" }),
        makeParent({ id: "gp-1", email: "gp@example.com" }),
        makeDependent({ inheritParentEmail: false, inheritEmailFromId: "gp-1" }),
      ]);

      const res = await unlinkDependent();

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { parent: { disconnect: true } },
        })
      );
      expect((await res.json()).clearedEmailInheritance).toBe(false);
    });
  });

  it("rejects removing a link from the wrong parent", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeDependent({ parentMemberId: "other-parent" }),
    ]);

    const res = await unlinkDependent();

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/not linked/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });
});
