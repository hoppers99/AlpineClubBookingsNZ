import type { Prisma } from "@prisma/client";
import type { prisma } from "@/lib/prisma";

/**
 * Family-link DEPTH rules (#2255, owner decision D9).
 *
 * Parent/dependant links (`Member.parentMemberId` + `Member.secondaryParentId`)
 * used to be capped at TWO generations by a single guard: "a member who already
 * has dependants cannot be linked under another member". That guard was only
 * half a cap. It blocked ATTACHING an existing subtree under a new parent, but
 * it never looked at the parent's own ancestors, so a chain could still be grown
 * downwards one leaf at a time — link A→B while B is childless, then link B→C —
 * and nothing refused it. The documented "two generations" was therefore an
 * accident of the order links happened to be created in, not an invariant.
 *
 * #2255 replaces it with an explicit, order-independent cap of
 * **{@link MAX_FAMILY_LINK_GENERATIONS} generations**: great-grandparent →
 * grandparent → parent → child, i.e. at most
 * {@link MAX_PARENT_LINK_CHAIN_LENGTH} parent-links on any root-to-leaf path.
 *
 * The check is symmetric, which is what makes it order-independent. Linking
 * child C under parent P joins two chains, so the resulting longest chain is
 *
 *     ancestorGenerations(P) + 1 + descendantGenerations(C)
 *
 * and that total — not either half — is what must stay within the cap. Building
 * a chain "from the middle outwards" (B→C first, then A→B) is therefore refused
 * at exactly the same point as building it top-down.
 *
 * WHY A LIB AND NOT A COLUMN: depth is a property of the link GRAPH, not of any
 * row, and it changes whenever any link on the path changes. Materialising it
 * would need a trigger or a backfill on every link write; the graphs here are
 * tiny (≤ 2 parents per member, ≤ 4 levels), so walking them per write is both
 * cheaper and impossible to get out of step with reality.
 *
 * EXISTING DATA MAY ALREADY BREACH THE CAP, because the old half-guard allowed
 * downward growth. Every walk below is therefore written to be correct on an
 * over-deep (and even, defensively, on a cyclic) graph: they are level-bounded
 * so they terminate, and a graph that runs past the bound reports "at least
 * bound+1", which refuses the new link rather than silently accepting it.
 */

type FamilyLinkClient = Prisma.TransactionClient | typeof prisma;

/** Great-grandparent → grandparent → parent → child. */
export const MAX_FAMILY_LINK_GENERATIONS = 4;

/** Parent-links on the longest root-to-leaf path: one fewer than generations. */
export const MAX_PARENT_LINK_CHAIN_LENGTH = MAX_FAMILY_LINK_GENERATIONS - 1;

/**
 * The 422 body every writer uses when a link would breach the cap. One string,
 * shared, so the admin link route, the family-group request reviewer and the
 * application/nomination approval path cannot describe the same rule three
 * different ways. Pinned by `src/lib/__tests__/member-family-link-depth.test.ts`.
 */
export const FAMILY_LINK_GENERATION_LIMIT_ERROR = `Family links are limited to ${MAX_FAMILY_LINK_GENERATIONS} generations (great-grandparent, grandparent, parent, child). This link would make the family chain longer than that.`;

/** Short phrase for a candidate list row, matching the other reason phrases. */
export const FAMILY_LINK_GENERATION_LIMIT_EXPLANATION = `would make the family chain more than ${MAX_FAMILY_LINK_GENERATIONS} generations deep`;

/**
 * How far a link walk will travel before giving up and reporting
 * "at least this deep". One level past the cap is all any decision here needs:
 * everything beyond it is refused identically.
 */
const WALK_LEVEL_LIMIT = MAX_PARENT_LINK_CHAIN_LENGTH + 1;

export type ParentSideDepth = {
  /**
   * Every member reachable by walking UP from the parent, exclusive of the
   * parent itself. Used as the cycle guard: a candidate in this set is an
   * ancestor of the parent, so linking it as a dependant would close a loop.
   *
   * Complete unless `ancestorGenerations` hit `truncated`, and a truncated walk
   * already fails the depth cap, so no caller can act on a partial set.
   */
  ancestorIds: string[];
  /** Longest chain of parent-links above the parent; 0 when it has none. */
  ancestorGenerations: number;
  /** True when the walk stopped at the level limit rather than at the top. */
  truncated: boolean;
};

export type ChildSideDepth = {
  /** Every member reachable by walking DOWN, exclusive of the member itself. */
  descendantIds: string[];
  /** Longest chain of parent-links below the member; 0 when it has none. */
  descendantGenerations: number;
  truncated: boolean;
};

/**
 * Walk up from `parentId`, collecting ancestors and the longest chain length.
 *
 * Deliberately NOT a shortest-path BFS. Levels are expanded whole and deduped
 * only WITHIN a level, because a member can be reached at two different depths
 * through the primary and secondary edges (A is both B's parent and C's second
 * parent, while B is C's first parent: A→C is one hop, A→B→C is two). Global
 * dedup would record the shorter one and under-report the depth, which is the
 * direction that wrongly ACCEPTS a link. Duplicates cost nothing here — the
 * fan-out is at most 2 per member over at most {@link WALK_LEVEL_LIMIT} levels.
 */
export async function describeParentSideDepth(
  db: FamilyLinkClient,
  parentId: string,
): Promise<ParentSideDepth> {
  const ancestorIds = new Set<string>();
  let frontier = [parentId];
  let generations = 0;

  for (let level = 0; level < WALK_LEVEL_LIMIT; level += 1) {
    const rows = await db.member.findMany({
      where: { id: { in: frontier } },
      select: { parentMemberId: true, secondaryParentId: true },
    });

    const next = new Set<string>();
    for (const row of rows) {
      if (row.parentMemberId) next.add(row.parentMemberId);
      if (row.secondaryParentId) next.add(row.secondaryParentId);
    }
    // The starting member is NOT filtered out of its own ancestors. If it turns
    // up there the data already contains a loop, and dropping it would let the
    // walk finish early and report a small, comfortable depth for a graph that
    // has no depth at all. Letting it run to the level limit reports
    // `truncated`, which every caller treats as over-deep and refuses. Callers
    // are unaffected in the ordinary case: the self-link check runs before the
    // ancestor check everywhere the two could disagree.
    if (next.size === 0) {
      return {
        ancestorIds: Array.from(ancestorIds),
        ancestorGenerations: generations,
        truncated: false,
      };
    }

    for (const id of next) ancestorIds.add(id);
    generations = level + 1;
    frontier = Array.from(next);
  }

  return {
    ancestorIds: Array.from(ancestorIds),
    ancestorGenerations: generations,
    truncated: true,
  };
}

/**
 * Walk down from `memberId`. Same level-at-a-time shape as the upward walk, and
 * the same reason for it: a member reachable both as a child and as a
 * grandchild must count at its deepest.
 */
export async function describeChildSideDepth(
  db: FamilyLinkClient,
  memberId: string,
): Promise<ChildSideDepth> {
  const descendantIds = new Set<string>();
  let frontier = [memberId];
  let generations = 0;

  for (let level = 0; level < WALK_LEVEL_LIMIT; level += 1) {
    const rows = await db.member.findMany({
      where: {
        OR: [
          { parentMemberId: { in: frontier } },
          { secondaryParentId: { in: frontier } },
        ],
      },
      select: { id: true },
    });

    // Same as the upward walk: a member that reappears as its own descendant is
    // a loop, and is reported as over-deep rather than quietly skipped.
    const next = new Set<string>();
    for (const row of rows) next.add(row.id);
    if (next.size === 0) {
      return {
        descendantIds: Array.from(descendantIds),
        descendantGenerations: generations,
        truncated: false,
      };
    }

    for (const id of next) descendantIds.add(id);
    generations = level + 1;
    frontier = Array.from(next);
  }

  return {
    descendantIds: Array.from(descendantIds),
    descendantGenerations: generations,
    truncated: true,
  };
}

/**
 * The cap itself. `parentAncestorGenerations + 1 + childDescendantGenerations`
 * is the length of the chain the new link would create.
 */
export function exceedsFamilyLinkGenerationLimit(input: {
  parentAncestorGenerations: number;
  childDescendantGenerations: number;
}): boolean {
  return (
    input.parentAncestorGenerations + 1 + input.childDescendantGenerations >
    MAX_PARENT_LINK_CHAIN_LENGTH
  );
}

/**
 * How many generations of dependants a candidate may still carry under this
 * parent. Negative means the parent's own chain already fills the cap, so no
 * candidate at all is linkable under them.
 */
export function allowedChildDescendantGenerations(
  parentAncestorGenerations: number,
): number {
  return MAX_PARENT_LINK_CHAIN_LENGTH - 1 - parentAncestorGenerations;
}

/**
 * The mirror image, for the "Add Parent" search: how many generations of
 * ancestors a candidate PARENT may still carry above a member who already has
 * `childDescendantGenerations` of dependants below them.
 */
export function allowedParentAncestorGenerations(
  childDescendantGenerations: number,
): number {
  return MAX_PARENT_LINK_CHAIN_LENGTH - 1 - childDescendantGenerations;
}

/**
 * One depth+cycle verdict for a proposed link, for the writers that do not go
 * through the shared dependant-link predicate (the family-group request
 * reviewer and the application/nomination approval path). Returns `null` when
 * the link is allowed.
 *
 * Callers MUST pass the same `db` they will write with, so the walk reads the
 * transaction's own view — a link created earlier in the same transaction is
 * invisible to a walk issued on the base client.
 */
export async function checkParentLinkDepthAndCycle(
  db: FamilyLinkClient,
  input: { parentId: string; childId: string },
): Promise<{ error: string } | null> {
  if (input.parentId === input.childId) {
    return { error: "A member cannot be their own parent" };
  }

  const [parentSide, childSide] = await Promise.all([
    describeParentSideDepth(db, input.parentId),
    describeChildSideDepth(db, input.childId),
  ]);

  if (parentSide.ancestorIds.includes(input.childId)) {
    return { error: "Cannot link a parent or ancestor as a dependant" };
  }

  if (
    exceedsFamilyLinkGenerationLimit({
      parentAncestorGenerations: parentSide.ancestorGenerations,
      childDescendantGenerations: childSide.descendantGenerations,
    })
  ) {
    return { error: FAMILY_LINK_GENERATION_LIMIT_ERROR };
  }

  return null;
}

/**
 * SQL half of the depth cap: "this member has SOME chain of `length` parent
 * links beneath them". Built recursively because each level may descend through
 * either the primary or the secondary parent column.
 */
function hasDescendantChainOfLength(length: number): Prisma.MemberWhereInput {
  const deeper =
    length <= 1 ? {} : hasDescendantChainOfLength(length - 1);
  return {
    OR: [
      { dependents: { some: deeper } },
      { secondaryDependents: { some: deeper } },
    ],
  };
}

/** Mirror of the above, walking upwards through the two parent columns. */
function hasAncestorChainOfLength(length: number): Prisma.MemberWhereInput {
  if (length <= 1) {
    return {
      OR: [
        { parentMemberId: { not: null } },
        { secondaryParentId: { not: null } },
      ],
    };
  }
  const deeper = hasAncestorChainOfLength(length - 1);
  return {
    OR: [{ parent: { is: deeper } }, { secondaryParent: { is: deeper } }],
  };
}

/**
 * A clause no row can satisfy. `{ NOT: {} }` would NOT do: Prisma treats an
 * empty filter object as "no condition", so its negation is also no condition
 * and the guard would fail OPEN. An empty `in` list compiles to a false
 * predicate.
 */
const MATCHES_NOTHING: Prisma.MemberWhereInput = { id: { in: [] } };

/**
 * "No dependant chain deeper than `generations`". `generations < 0` is
 * unsatisfiable — the parent already fills the cap — and is expressed as a
 * clause no row can match rather than by omitting the filter, so a caller that
 * forgets to special-case it fails closed.
 */
export function descendantDepthWithinWhere(
  generations: number,
): Prisma.MemberWhereInput {
  if (generations < 0) {
    return MATCHES_NOTHING;
  }
  return { NOT: hasDescendantChainOfLength(generations + 1) };
}

/** "No ancestor chain deeper than `generations`". Fails closed the same way. */
export function ancestorDepthWithinWhere(
  generations: number,
): Prisma.MemberWhereInput {
  if (generations < 0) {
    return MATCHES_NOTHING;
  }
  return { NOT: hasAncestorChainOfLength(generations + 1) };
}
