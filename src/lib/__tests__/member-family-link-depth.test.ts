import { describe, it, expect } from "vitest";
import {
  allowedChildDescendantGenerations,
  allowedParentAncestorGenerations,
  checkParentLinkDepthAndCycle,
  describeChildSideDepth,
  describeParentSideDepth,
  exceedsFamilyLinkGenerationLimit,
  FAMILY_LINK_GENERATION_LIMIT_ERROR,
  MAX_FAMILY_LINK_GENERATIONS,
  MAX_PARENT_LINK_CHAIN_LENGTH,
} from "@/lib/member-family-link-depth";

/**
 * The bounded graph walks behind the four-generation cap (#2255, D9).
 *
 * These run against a tiny in-memory stand-in for `tx.member.findMany` rather
 * than a mocked Prisma, because what is being tested is the WALK — how many
 * levels it visits, in what order, and what it reports when the graph is deeper
 * or nastier than the cap allows. The two query shapes the walks issue are
 * implemented here in full, so a walk that started issuing a different shape
 * would fail rather than quietly matching nothing.
 */

type Row = {
  id: string;
  parentMemberId: string | null;
  secondaryParentId: string | null;
};

type Edge = [child: string, primaryParent: string | null, secondParent?: string];

function graph(edges: Edge[]) {
  const rows = new Map<string, Row>();
  const ensure = (id: string) => {
    if (!rows.has(id)) {
      rows.set(id, { id, parentMemberId: null, secondaryParentId: null });
    }
    return rows.get(id)!;
  };

  for (const [child, primary, secondary] of edges) {
    const row = ensure(child);
    if (primary) {
      ensure(primary);
      row.parentMemberId = primary;
    }
    if (secondary) {
      ensure(secondary);
      row.secondaryParentId = secondary;
    }
  }

  let queries = 0;
  const db = {
    member: {
      async findMany(args: {
        where: {
          id?: { in: string[] };
          OR?: Array<{
            parentMemberId?: { in: string[] };
            secondaryParentId?: { in: string[] };
          }>;
        };
      }) {
        queries += 1;
        const all = [...rows.values()];
        if (args.where.id?.in) {
          const wanted = new Set(args.where.id.in);
          return all.filter((row) => wanted.has(row.id));
        }
        const parentIds = new Set(
          (args.where.OR ?? []).flatMap((clause) => [
            ...(clause.parentMemberId?.in ?? []),
            ...(clause.secondaryParentId?.in ?? []),
          ]),
        );
        return all.filter(
          (row) =>
            (row.parentMemberId && parentIds.has(row.parentMemberId)) ||
            (row.secondaryParentId && parentIds.has(row.secondaryParentId)),
        );
      },
    },
    get queryCount() {
      return queries;
    },
  };

  // The walks only ever read `member.findMany`; the cast keeps the fake honest
  // by refusing to grow into a general Prisma double.
  return db as unknown as Parameters<typeof describeParentSideDepth>[0] & {
    queryCount: number;
  };
}

/** great-grandparent -> grandparent -> parent -> child, all primary links. */
const FOUR_GENERATIONS: Edge[] = [
  ["gp", "ggp"],
  ["p", "gp"],
  ["c", "p"],
];

describe("the cap itself", () => {
  it("is four generations, i.e. three parent links", () => {
    expect(MAX_FAMILY_LINK_GENERATIONS).toBe(4);
    expect(MAX_PARENT_LINK_CHAIN_LENGTH).toBe(3);
  });

  it("adds the two halves plus the new link", () => {
    // A grandparent (one generation above) linking a member who already has one
    // generation below: 1 + 1 + 1 = 3 links = four generations. Allowed.
    expect(
      exceedsFamilyLinkGenerationLimit({
        parentAncestorGenerations: 1,
        childDescendantGenerations: 1,
      }),
    ).toBe(false);
    // One more on either side is a fifth generation.
    expect(
      exceedsFamilyLinkGenerationLimit({
        parentAncestorGenerations: 2,
        childDescendantGenerations: 1,
      }),
    ).toBe(true);
    expect(
      exceedsFamilyLinkGenerationLimit({
        parentAncestorGenerations: 1,
        childDescendantGenerations: 2,
      }),
    ).toBe(true);
  });

  it("states the remaining room symmetrically", () => {
    expect(allowedChildDescendantGenerations(0)).toBe(2);
    expect(allowedChildDescendantGenerations(2)).toBe(0);
    expect(allowedChildDescendantGenerations(3)).toBe(-1);
    expect(allowedParentAncestorGenerations(0)).toBe(2);
    expect(allowedParentAncestorGenerations(3)).toBe(-1);
  });
});

describe("describeParentSideDepth", () => {
  it("reports no ancestors for a root member", async () => {
    const result = await describeParentSideDepth(graph(FOUR_GENERATIONS), "ggp");
    expect(result).toEqual({
      ancestorIds: [],
      ancestorGenerations: 0,
      truncated: false,
    });
  });

  it("counts every generation above, and names them all", async () => {
    const result = await describeParentSideDepth(graph(FOUR_GENERATIONS), "c");
    expect(result.ancestorGenerations).toBe(3);
    expect([...result.ancestorIds].sort()).toEqual(["ggp", "gp", "p"].sort());
    expect(result.truncated).toBe(false);
  });

  it("follows SECOND parent links as well as first", async () => {
    // Every link in this chain is a second-parent link. A walk that only read
    // `parentMemberId` would report zero ancestors and wave the link through.
    const result = await describeParentSideDepth(
      graph([
        ["b", null, "a"],
        ["c", null, "b"],
      ]),
      "c",
    );
    expect(result.ancestorGenerations).toBe(2);
    expect([...result.ancestorIds].sort()).toEqual(["a", "b"]);
  });

  it("reports the LONGEST path when a member is reachable at two depths", async () => {
    // A is both B's parent and C's second parent, while B is C's first parent.
    // A is one hop away AND two hops away; the cap cares about the longer one,
    // because that is the chain that would grow.
    const result = await describeParentSideDepth(
      graph([
        ["b", "a"],
        ["c", "b", "a"],
      ]),
      "c",
    );
    expect(result.ancestorGenerations).toBe(2);
  });

  it("terminates on a cyclic graph and reports it as over-deep", async () => {
    // Data that predates the cap could contain a loop. The walk must not hang,
    // and must not report a small depth that would let a new link through.
    const result = await describeParentSideDepth(
      graph([
        ["a", "c"],
        ["b", "a"],
        ["c", "b"],
      ]),
      "a",
    );
    expect(result.truncated).toBe(true);
    expect(result.ancestorGenerations).toBeGreaterThan(
      MAX_PARENT_LINK_CHAIN_LENGTH,
    );
  });

  it("stops after a bounded number of queries", async () => {
    const db = graph(FOUR_GENERATIONS);
    await describeParentSideDepth(db, "c");
    expect(db.queryCount).toBeLessThanOrEqual(MAX_PARENT_LINK_CHAIN_LENGTH + 1);
  });
});

describe("describeChildSideDepth", () => {
  it("reports no descendants for a leaf", async () => {
    const result = await describeChildSideDepth(graph(FOUR_GENERATIONS), "c");
    expect(result).toEqual({
      descendantIds: [],
      descendantGenerations: 0,
      truncated: false,
    });
  });

  it("counts every generation below, and names them all", async () => {
    const result = await describeChildSideDepth(graph(FOUR_GENERATIONS), "ggp");
    expect(result.descendantGenerations).toBe(3);
    expect([...result.descendantIds].sort()).toEqual(["c", "gp", "p"].sort());
  });

  it("follows SECOND parent links as well as first", async () => {
    const result = await describeChildSideDepth(
      graph([
        ["b", null, "a"],
        ["c", null, "b"],
      ]),
      "a",
    );
    expect(result.descendantGenerations).toBe(2);
  });

  it("takes the deepest branch, not the first one it finds", async () => {
    // A wide family: one child is a leaf, another heads two more generations.
    // A walk that stopped at the first childless branch would report 1.
    const result = await describeChildSideDepth(
      graph([
        ["shallow", "root"],
        ["mid", "root"],
        ["deep", "mid"],
      ]),
      "root",
    );
    expect(result.descendantGenerations).toBe(2);
  });

  it("terminates on a cyclic graph and reports it as over-deep", async () => {
    const result = await describeChildSideDepth(
      graph([
        ["a", "c"],
        ["b", "a"],
        ["c", "b"],
      ]),
      "a",
    );
    expect(result.truncated).toBe(true);
    expect(result.descendantGenerations).toBeGreaterThan(
      MAX_PARENT_LINK_CHAIN_LENGTH,
    );
  });
});

describe("checkParentLinkDepthAndCycle", () => {
  it("allows a fourth generation", async () => {
    const db = graph([
      ["gp", "ggp"],
      ["p", "gp"],
    ]);
    expect(
      await checkParentLinkDepthAndCycle(db, { parentId: "p", childId: "new" }),
    ).toBeNull();
  });

  it("refuses a fifth generation, naming the cap", async () => {
    const db = graph(FOUR_GENERATIONS);
    expect(
      await checkParentLinkDepthAndCycle(db, { parentId: "c", childId: "new" }),
    ).toEqual({ error: FAMILY_LINK_GENERATION_LIMIT_ERROR });
  });

  it("refuses a link that joins two chains into a fifth generation", async () => {
    // Neither side is over the cap on its own — the parent has two generations
    // above and the child two below — but joining them makes five. This is the
    // case the old "target has dependants" guard could not see, and the reason
    // building a family from the middle outwards used to slip through.
    const db = graph([
      ["gp", "ggp"],
      ["p", "gp"],
      ["x", "y"],
      ["z", "x"],
    ]);
    expect(
      await checkParentLinkDepthAndCycle(db, { parentId: "p", childId: "y" }),
    ).toEqual({ error: FAMILY_LINK_GENERATION_LIMIT_ERROR });
  });

  it("refuses linking a member as their own parent", async () => {
    const db = graph(FOUR_GENERATIONS);
    const verdict = await checkParentLinkDepthAndCycle(db, {
      parentId: "p",
      childId: "p",
    });
    expect(verdict?.error).toMatch(/their own parent/i);
  });

  it("refuses a link that would close a loop, at every depth and on both edges", async () => {
    const db = graph(FOUR_GENERATIONS);
    // ggp -> gp -> p -> c already exists. Linking any ancestor under any of its
    // own descendants closes the loop, whichever pair you choose.
    for (const [parentId, childId] of [
      ["gp", "ggp"],
      ["p", "ggp"],
      ["p", "gp"],
      ["c", "ggp"],
      ["c", "gp"],
      ["c", "p"],
    ]) {
      const verdict = await checkParentLinkDepthAndCycle(db, {
        parentId,
        childId,
      });
      expect({ parentId, childId, error: verdict?.error }).toEqual({
        parentId,
        childId,
        error: "Cannot link a parent or ancestor as a dependant",
      });
    }
  });

  it("refuses a loop through SECOND parent links", async () => {
    // a -> b -> c built entirely from second-parent edges; closing c -> a is
    // invisible to any walk that only reads `parentMemberId`.
    const db = graph([
      ["b", null, "a"],
      ["c", null, "b"],
    ]);
    expect(
      await checkParentLinkDepthAndCycle(db, { parentId: "c", childId: "a" }),
    ).toEqual({ error: "Cannot link a parent or ancestor as a dependant" });
  });

  it("refuses a loop whichever end of the chain was created first", async () => {
    // Same three members, same intended loop, but the chain was assembled from
    // the middle outwards: b -> c first, then a -> b. Order of creation must not
    // change the verdict.
    const middleOutwards = graph([
      ["c", "b"],
      ["b", "a"],
    ]);
    expect(
      await checkParentLinkDepthAndCycle(middleOutwards, {
        parentId: "c",
        childId: "a",
      }),
    ).toEqual({ error: "Cannot link a parent or ancestor as a dependant" });
  });

  it("allows an unrelated member at the same depth", async () => {
    // The guard must refuse ANCESTORS, not everyone who happens to be senior.
    const db = graph([
      ["gp", "ggp"],
      ["p", "gp"],
      ["stranger", null],
    ]);
    expect(
      await checkParentLinkDepthAndCycle(db, {
        parentId: "p",
        childId: "stranger",
      }),
    ).toBeNull();
  });
});
