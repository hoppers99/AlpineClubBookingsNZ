import { describe, it, expect } from "vitest";
import {
  getMemberFamilyTree,
  MAX_FAMILY_TREE_MEMBERS,
  type FamilyTreeNode,
  type MemberFamilyTree,
} from "@/lib/member-family-tree";
import { MAX_PARENT_LINK_CHAIN_LENGTH } from "@/lib/member-family-link-depth";

/**
 * #2253: the whole-connected-graph family tree derivation. Exercised directly
 * against a fake db client (same pattern as member-parent-links.test.ts).
 *
 * The fake enforces a QUERY BUDGET: the traversal's safety rests on the
 * visited set and the vertical/size caps, and a broken guard shows up first as
 * runaway querying — a budget overrun fails the test immediately instead of
 * hanging it.
 */

type Row = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  archivedAt: Date | null;
  cancelledAt: Date | null;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  inheritEmailFromId: string | null;
  billingFamilyGroupId: string | null;
  familyGroups: string[];
};

type Seed = Partial<Row> & { id: string };

type PartnerSeed = {
  a: string;
  b: string;
  status?: string;
  id?: string;
};

function db(
  members: Seed[],
  partnerLinks: PartnerSeed[] = [],
  options: { queryBudget?: number } = {},
) {
  const budget = options.queryBudget ?? 200;
  let queries = 0;
  const spend = () => {
    queries += 1;
    if (queries > budget) {
      throw new Error(
        `query budget exceeded (${budget}) — traversal is not bounded`,
      );
    }
  };

  const rows = new Map<string, Row>(
    members.map((seed) => [
      seed.id,
      {
        firstName: seed.id,
        lastName: "",
        email: `${seed.id}@example.org`,
        ageTier: "ADULT",
        active: true,
        canLogin: true,
        archivedAt: null,
        cancelledAt: null,
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        billingFamilyGroupId: null,
        familyGroups: [],
        ...seed,
      } as Row,
    ]),
  );

  const links = partnerLinks.map((link, index) => ({
    id: link.id ?? `link-${index}`,
    memberAId: link.a,
    memberBId: link.b,
    status: link.status ?? "CONFIRMED",
  }));

  function shape(row: Row) {
    const source = row.inheritEmailFromId
      ? rows.get(row.inheritEmailFromId)
      : null;
    return {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      ageTier: row.ageTier,
      active: row.active,
      canLogin: row.canLogin,
      archivedAt: row.archivedAt,
      cancelledAt: row.cancelledAt,
      parentMemberId: row.parentMemberId,
      secondaryParentId: row.secondaryParentId,
      inheritEmailFromId: row.inheritEmailFromId,
      inheritEmailFrom: source
        ? { id: source.id, firstName: source.firstName, lastName: source.lastName }
        : null,
      billingFamilyGroupId: row.billingFamilyGroupId,
      familyGroupMemberships: row.familyGroups.map((groupId) => ({
        familyGroupId: groupId,
        familyGroup: { id: groupId, name: `Group ${groupId}` },
      })),
    };
  }

  function sortRows(list: Row[]) {
    return [...list].sort(
      (a, b) =>
        a.firstName.localeCompare(b.firstName) ||
        a.lastName.localeCompare(b.lastName) ||
        a.id.localeCompare(b.id),
    );
  }

  const client = {
    member: {
      async findUnique({ where }: { where: { id: string } }) {
        spend();
        const row = rows.get(where.id);
        return row ? shape(row) : null;
      },
      async findMany({
        where,
      }: {
        where: {
          id?: { in: string[] };
          OR?: Array<{
            parentMemberId?: { in: string[] };
            secondaryParentId?: { in: string[] };
          }>;
        };
      }) {
        spend();
        if (where.id?.in) {
          return where.id.in
            .map((id) => rows.get(id))
            .filter((row): row is Row => Boolean(row))
            .map(shape);
        }
        const primaryIn = new Set(
          where.OR?.find((clause) => clause.parentMemberId)?.parentMemberId
            ?.in ?? [],
        );
        const secondaryIn = new Set(
          where.OR?.find((clause) => clause.secondaryParentId)
            ?.secondaryParentId?.in ?? [],
        );
        const matches = [...rows.values()].filter(
          (row) =>
            (row.parentMemberId && primaryIn.has(row.parentMemberId)) ||
            (row.secondaryParentId && secondaryIn.has(row.secondaryParentId)),
        );
        return sortRows(matches).map(shape);
      },
    },
    memberPartnerLink: {
      async findMany({
        where,
      }: {
        where: {
          status: string;
          OR: Array<{
            memberAId?: { in: string[] };
            memberBId?: { in: string[] };
          }>;
        };
      }) {
        spend();
        const aIn = new Set(
          where.OR.find((clause) => clause.memberAId)?.memberAId?.in ?? [],
        );
        const bIn = new Set(
          where.OR.find((clause) => clause.memberBId)?.memberBId?.in ?? [],
        );
        return links
          .filter(
            (link) =>
              link.status === where.status &&
              (aIn.has(link.memberAId) || bIn.has(link.memberBId)),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((link) => ({
            id: link.id,
            memberAId: link.memberAId,
            memberBId: link.memberBId,
          }));
      },
    },
    get queryCount() {
      return queries;
    },
  };

  return client as unknown as Parameters<typeof getMemberFamilyTree>[0] & {
    queryCount: number;
  };
}

function flatten(tree: MemberFamilyTree): FamilyTreeNode[] {
  const out: FamilyTreeNode[] = [];
  const walk = (node: FamilyTreeNode) => {
    out.push(node);
    if (node.attachedPartner) walk(node.attachedPartner);
    node.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  return out;
}

function byId(tree: MemberFamilyTree, id: string): FamilyTreeNode {
  const node = flatten(tree).find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(
      `member ${id} not in tree (${flatten(tree)
        .map((candidate) => candidate.id)
        .join(", ")})`,
    );
  }
  return node;
}

describe("getMemberFamilyTree", () => {
  it("returns null for a member that does not exist", async () => {
    expect(await getMemberFamilyTree(db([]), "ghost")).toBeNull();
  });

  it("renders a single member with no links as themselves only", async () => {
    const tree = (await getMemberFamilyTree(db([{ id: "solo" }]), "solo"))!;
    expect(tree.memberCount).toBe(1);
    expect(tree.generationSpan).toBe(1);
    expect(tree.truncated).toBe(false);
    expect(tree.hasDerivedRelationships).toBe(false);
    expect(tree.roots).toHaveLength(1);
    const self = tree.roots[0];
    expect(self.id).toBe("solo");
    expect(self.isRoot).toBe(true);
    expect(self.relationship.label).toBe("This member");
    expect(self.relationship.derived).toBe(false);
    expect(self.children).toHaveLength(0);
  });

  it("nests a three-generation chain and labels stored vs derived", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "gp" },
        { id: "p", parentMemberId: "gp" },
        { id: "me", parentMemberId: "p" },
        { id: "kid", parentMemberId: "me" },
      ]),
      "me",
    ))!;

    expect(tree.memberCount).toBe(4);
    expect(tree.generationSpan).toBe(4);
    // Forest nests along recorded primary links: gp → p → me → kid.
    expect(tree.roots.map((node) => node.id)).toEqual(["gp"]);
    expect(tree.roots[0].children.map((node) => node.id)).toEqual(["p"]);
    expect(byId(tree, "p").children.map((node) => node.id)).toEqual(["me"]);
    expect(byId(tree, "me").children.map((node) => node.id)).toEqual(["kid"]);

    // The root's own recorded links are stored; everything further is derived.
    expect(byId(tree, "p").relationship).toMatchObject({
      label: "Parent",
      derived: false,
    });
    expect(byId(tree, "kid").relationship).toMatchObject({
      label: "Dependant",
      derived: false,
    });
    expect(byId(tree, "gp").relationship).toMatchObject({
      label: "Grandparent",
      derived: true,
    });
    expect(byId(tree, "gp").generation).toBe(-2);
    expect(byId(tree, "kid").generation).toBe(1);
    expect(byId(tree, "me").linkToDisplayParent).toBe("PRIMARY");
    expect(tree.hasDerivedRelationships).toBe(true);
  });

  it("names the second parent inline on a two-parent child", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "mum" },
        { id: "dad" },
        { id: "me", parentMemberId: "mum", secondaryParentId: "dad" },
      ]),
      "me",
    ))!;

    const me = byId(tree, "me");
    // Nested under the primary parent, second parent named inline (mockup).
    expect(me.linkToDisplayParent).toBe("PRIMARY");
    expect(byId(tree, "mum").children.map((node) => node.id)).toEqual(["me"]);
    expect(me.secondParentInline).toEqual({ id: "dad", name: "dad" });
    expect(me.relationship.description).toContain("Second parent: dad.");
    expect(byId(tree, "dad").relationship).toMatchObject({
      label: "Second parent",
      derived: false,
    });
    expect(byId(tree, "dad").children).toHaveLength(0);
  });

  it("renders a CONFIRMED partner attached beside the member, and ignores PENDING", async () => {
    const confirmed = (await getMemberFamilyTree(
      db([{ id: "me" }, { id: "kate" }], [{ a: "me", b: "kate" }]),
      "me",
    ))!;
    expect(confirmed.roots.map((node) => node.id)).toEqual(["me"]);
    expect(confirmed.roots[0].attachedPartner?.id).toBe("kate");
    expect(confirmed.roots[0].partner).toEqual({
      id: "kate",
      name: "kate",
      attachedHere: true,
    });
    expect(byId(confirmed, "kate").relationship).toMatchObject({
      label: "Partner",
      derived: false,
    });

    const pending = (await getMemberFamilyTree(
      db(
        [{ id: "me" }, { id: "kate" }],
        [{ a: "me", b: "kate", status: "PENDING" }],
      ),
      "me",
    ))!;
    expect(pending.memberCount).toBe(1);
    expect(pending.roots[0].partner).toBeNull();
  });

  it("follows the whole connected graph across households (owner reach decision)", async () => {
    // me — partner kate; kate's father hemi is in ANOTHER household; hemi has
    // another child ruby (kate's sibling) with a child of her own.
    const tree = (await getMemberFamilyTree(
      db(
        [
          { id: "me" },
          { id: "kate", parentMemberId: "hemi" },
          { id: "hemi" },
          { id: "ruby", parentMemberId: "hemi" },
          { id: "cub", parentMemberId: "ruby" },
        ],
        [{ a: "me", b: "kate" }],
      ),
      "me",
    ))!;

    expect(flatten(tree).map((node) => node.id).sort()).toEqual([
      "cub",
      "hemi",
      "kate",
      "me",
      "ruby",
    ]);
    // Affinity labels resolve relative to the partner.
    expect(byId(tree, "hemi").relationship).toMatchObject({
      label: "kate's parent",
      derived: true,
    });
    expect(byId(tree, "ruby").relationship).toMatchObject({
      label: "kate's sibling",
      derived: true,
    });
    // Partner hops never change generation: hemi is one generation up.
    expect(byId(tree, "kate").generation).toBe(0);
    expect(byId(tree, "hemi").generation).toBe(-1);
    expect(byId(tree, "cub").generation).toBe(1);
  });

  it("derives sibling vs half-sibling by WHICH parents are shared", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "p" },
        { id: "k" },
        { id: "me", parentMemberId: "p", secondaryParentId: "k" },
        // Same recorded parent set — full sibling.
        { id: "sam", parentMemberId: "p", secondaryParentId: "k" },
        // Shares only k, while me also has p — half-sibling.
        { id: "ruby", parentMemberId: "k" },
      ]),
      "me",
    ))!;

    expect(byId(tree, "sam").relationship).toMatchObject({
      label: "Sibling",
      derived: true,
    });
    const ruby = byId(tree, "ruby");
    expect(ruby.relationship.label).toBe("Half-sibling");
    expect(ruby.relationship.derived).toBe(true);
    expect(ruby.relationship.description).toContain("Shares parent k.");
  });

  it("derives cousins, aunts/uncles and nieces/nephews from shared ancestors", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "gp" },
        { id: "p1", parentMemberId: "gp" },
        { id: "p2", parentMemberId: "gp" },
        { id: "me", parentMemberId: "p1" },
        { id: "sib", parentMemberId: "p1" },
        { id: "cuz", parentMemberId: "p2" },
        { id: "nib", parentMemberId: "sib" },
      ]),
      "me",
    ))!;

    expect(byId(tree, "cuz").relationship.label).toBe("Cousin");
    expect(byId(tree, "p2").relationship.label).toBe("Aunt or uncle");
    expect(byId(tree, "nib").relationship.label).toBe("Niece or nephew");
    for (const id of ["cuz", "p2", "nib", "sib", "gp"]) {
      expect(byId(tree, id).relationship.derived).toBe(true);
    }
  });

  it("labels a dependant's other parent as co-parent when no partner link exists", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "me" },
        { id: "ex" },
        { id: "kid", parentMemberId: "me", secondaryParentId: "ex" },
      ]),
      "me",
    ))!;

    expect(byId(tree, "ex").relationship).toMatchObject({
      label: "Co-parent of kid",
      derived: true,
    });
    // The child nests under the primary parent with the second parent inline.
    expect(byId(tree, "kid").secondParentInline).toEqual({
      id: "ex",
      name: "ex",
    });
  });

  it("keeps archived members in the tree, badged, with contact details suppressed", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "me", parentMemberId: "gran" },
        { id: "gran", archivedAt: new Date("2019-06-01"), cancelledAt: new Date("2019-06-01") },
      ]),
      "me",
    ))!;

    const gran = byId(tree, "gran");
    expect(gran.archived).toBe(true);
    expect(gran.cancelled).toBe(true);
    expect(gran.email).toBeNull();
    expect(gran.relationship.description).toContain(
      "Archived member — contact details hidden.",
    );
    // Non-archived members keep the email the admin member page already shows.
    expect(byId(tree, "me").email).toBe("me@example.org");
  });

  it("terminates on a parent-link cycle and renders each member exactly once", async () => {
    const client = db(
      [
        { id: "a", parentMemberId: "b" },
        { id: "b", parentMemberId: "a" },
      ],
      [],
      { queryBudget: 30 },
    );
    const tree = (await getMemberFamilyTree(client, "a"))!;

    const ids = flatten(tree).map((node) => node.id);
    expect([...ids].sort()).toEqual(["a", "b"]);
    expect(ids).toHaveLength(2); // no duplicates: the display cycle is broken
    expect(client.queryCount).toBeLessThanOrEqual(30);
  });

  it("terminates when a member is recorded as their own parent", async () => {
    const client = db([{ id: "ouro", parentMemberId: "ouro" }], [], {
      queryBudget: 20,
    });
    const tree = (await getMemberFamilyTree(client, "ouro"))!;
    expect(tree.memberCount).toBe(1);
  });

  it("caps the walk at 4 generations vertically from the viewed member", async () => {
    // Over-deep legacy chains: 5 ancestors up and 5 descendants down.
    const seeds: Seed[] = [{ id: "me", parentMemberId: "up1" }];
    for (let i = 1; i <= 5; i += 1) {
      seeds.push({ id: `up${i}`, parentMemberId: i < 5 ? `up${i + 1}` : null });
      seeds.push({
        id: `down${i}`,
        parentMemberId: i === 1 ? "me" : `down${i - 1}`,
      });
    }
    const tree = (await getMemberFamilyTree(db(seeds), "me"))!;

    const ids = flatten(tree).map((node) => node.id);
    expect(ids).toContain("up3");
    expect(ids).toContain("down3");
    expect(ids).not.toContain("up4");
    expect(ids).not.toContain("down4");
    expect(tree.truncated).toBe(true);
    for (const node of flatten(tree)) {
      expect(Math.abs(node.generation)).toBeLessThanOrEqual(
        MAX_PARENT_LINK_CHAIN_LENGTH,
      );
    }
  });

  it("terminates across long horizontal co-parent/partner chains", async () => {
    // Ten households chained sideways: each couple shares a child, and one
    // member of each couple has a partner link into the next household.
    // Partner hops do not increment generation, so only the visited set and
    // size cap bound this shape.
    const seeds: Seed[] = [{ id: "me" }];
    const partners: PartnerSeed[] = [];
    for (let i = 0; i < 10; i += 1) {
      const left = i === 0 ? "me" : `spouse${i}`;
      seeds.push({
        id: `child${i}`,
        parentMemberId: left,
        secondaryParentId: `co${i}`,
      });
      seeds.push({ id: `co${i}` });
      seeds.push({ id: `spouse${i + 1}` });
      partners.push({ a: `co${i}`, b: `spouse${i + 1}` });
    }
    const client = db(seeds, partners, { queryBudget: 150 });
    const tree = (await getMemberFamilyTree(client, "me"))!;

    // The whole chain is reachable and the walk terminated within budget.
    expect(byId(tree, "co9")).toBeDefined();
    expect(byId(tree, "spouse10")).toBeDefined();
    expect(tree.memberCount).toBe(seeds.length);
    for (const node of flatten(tree)) {
      expect([0, 1]).toContain(node.generation);
    }
  });

  it("terminates on an invalid partner-link triangle (first link wins)", async () => {
    const client = db(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { id: "link-1", a: "a", b: "b" },
        { id: "link-2", a: "b", b: "c" },
        { id: "link-3", a: "c", b: "a" },
      ],
      { queryBudget: 30 },
    );
    const tree = (await getMemberFamilyTree(client, "a"))!;
    // a–b is kept (lowest link id); the conflicting links are ignored, so c is
    // not reachable through any recorded edge.
    expect(flatten(tree).map((node) => node.id).sort()).toEqual(["a", "b"]);
    expect(byId(tree, "a").partner?.id).toBe("b");
  });

  it("stops at the member size cap and reports truncation", async () => {
    const seeds: Seed[] = [{ id: "me" }];
    for (let i = 0; i < MAX_FAMILY_TREE_MEMBERS + 50; i += 1) {
      seeds.push({ id: `kid${String(i).padStart(3, "0")}`, parentMemberId: "me" });
    }
    const tree = (await getMemberFamilyTree(db(seeds), "me"))!;
    expect(tree.memberCount).toBeLessThanOrEqual(MAX_FAMILY_TREE_MEMBERS);
    expect(tree.truncated).toBe(true);
  });

  it("reports the STORED email-inheritance answer, never a re-derivation", async () => {
    // kid's stored pointer names the grandparent even though kid's direct
    // parent has a perfectly usable address — a re-derivation would answer
    // "p". The tree must repeat the stored answer.
    const tree = (await getMemberFamilyTree(
      db([
        { id: "gp" },
        { id: "p", parentMemberId: "gp" },
        { id: "kid", parentMemberId: "p", inheritEmailFromId: "gp" },
      ]),
      "kid",
    ))!;

    const kid = byId(tree, "kid");
    expect(kid.notificationEmail).toEqual({
      sourceId: "gp",
      sourceName: "gp",
      sourceRelationship: "grandparent",
      beyondDirectParent: true,
    });
    expect(byId(tree, "gp").emailRecipientCount).toBe(1);
    expect(byId(tree, "p").notificationEmail).toBeNull();
  });

  it("marks direct-parent inheritance as not beyond the direct parent", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        { id: "p" },
        { id: "kid", parentMemberId: "p", inheritEmailFromId: "p" },
      ]),
      "kid",
    ))!;
    expect(byId(tree, "kid").notificationEmail).toMatchObject({
      sourceId: "p",
      beyondDirectParent: false,
    });
  });

  it("lists family groups per member and flags the billing family", async () => {
    const tree = (await getMemberFamilyTree(
      db([
        {
          id: "me",
          familyGroups: ["g1", "g2"],
          billingFamilyGroupId: "g2",
        },
      ]),
      "me",
    ))!;
    expect(byId(tree, "me").familyGroups).toEqual([
      { id: "g1", name: "Group g1", billing: false },
      { id: "g2", name: "Group g2", billing: true },
    ]);
  });

  it("renders a member in more than one family group once, with both chips", async () => {
    const tree = (await getMemberFamilyTree(
      db(
        [
          { id: "me", familyGroups: ["g1"] },
          { id: "kate", familyGroups: ["g2"] },
          {
            id: "kid",
            parentMemberId: "me",
            secondaryParentId: "kate",
            familyGroups: ["g1", "g2"],
          },
        ],
        [{ a: "me", b: "kate" }],
      ),
      "me",
    ))!;
    const ids = flatten(tree).map((node) => node.id);
    expect(ids.filter((id) => id === "kid")).toHaveLength(1);
    expect(byId(tree, "kid").familyGroups.map((group) => group.id)).toEqual([
      "g1",
      "g2",
    ]);
  });
});
