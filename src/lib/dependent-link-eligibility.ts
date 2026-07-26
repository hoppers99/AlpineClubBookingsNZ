import type { Prisma } from "@prisma/client";

/**
 * Shared eligibility contract for "Add Dependant -> Link Existing" (#2254).
 *
 * Two surfaces decide who may be linked as a dependant under a parent member:
 *
 * 1. the candidate SEARCH — `dependentLinkEligibleFor` in
 *    `src/lib/admin-members-service.ts`, a Prisma `where`;
 * 2. the WRITE route — `POST /api/admin/members/[id]/dependents/link`, a set of
 *    row-level 422 guards.
 *
 * They had drifted apart in BOTH directions. The search dropped every member
 * whose parent columns were NULL (see `dependentLinkCandidateWhere` below), and
 * it offered archived members that the write route then rejected with a 422.
 * Both surfaces now derive from this module, so a candidate the search offers is
 * a candidate the write route accepts.
 *
 * NOT expressed here: the recursive "is the target an ancestor of the parent?"
 * walk, which needs a query per generation and stays in the write route. It is
 * unreachable from the search anyway — every ancestor of the parent necessarily
 * has at least one dependant (the child on the path down to the parent), so the
 * `HAS_DEPENDANTS` clause already excludes the whole ancestor set.
 */

/**
 * Ordered from most to least specific. `dependentLinkBlockers` returns reasons
 * in this order, so `blockers[0]` is the one to show.
 */
export const DEPENDENT_LINK_INELIGIBILITY_REASONS = [
  "ARCHIVED",
  "SELF",
  "ALREADY_LINKED_TO_PARENT",
  "TWO_PARENTS",
  "HAS_DEPENDANTS",
] as const;

export type DependentLinkIneligibilityReason =
  (typeof DEPENDENT_LINK_INELIGIBILITY_REASONS)[number];

/**
 * The write route's 422 bodies. These strings are the public API contract of
 * `POST /api/admin/members/[id]/dependents/link` and are pinned by
 * `src/lib/__tests__/dependent-link-existing.test.ts`; do not reword them
 * without updating that suite.
 */
export const DEPENDENT_LINK_INELIGIBILITY_ERRORS: Record<
  DependentLinkIneligibilityReason,
  string
> = {
  ARCHIVED: "Archived members cannot be linked into family groups",
  SELF: "A member cannot be their own dependant",
  ALREADY_LINKED_TO_PARENT: "This member is already linked to that parent",
  TWO_PARENTS: "This member already has two parents linked",
  HAS_DEPENDANTS:
    "This member already has dependants and cannot be linked under another member",
};

/**
 * Short per-candidate phrases for the search dialog, which lists them after a
 * member's name ("Jane Smith - already has two parents recorded"). Deliberately
 * separate from the 422 sentences above: one is an API error about an attempted
 * write, the other is a label on a row the admin can see but not pick.
 */
export const DEPENDENT_LINK_INELIGIBILITY_EXPLANATIONS: Record<
  DependentLinkIneligibilityReason,
  string
> = {
  ARCHIVED: "is archived",
  SELF: "is the member you are editing",
  ALREADY_LINKED_TO_PARENT: "is already linked to this member",
  TWO_PARENTS: "already has two parents recorded",
  HAS_DEPENDANTS: "has dependants of their own",
};

/**
 * One member the candidate search matched on name/email but had to exclude,
 * carried in the members-list response so the dialog can explain an otherwise
 * inscrutable empty result.
 */
export type DependentLinkIneligibleMatch = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  reason: DependentLinkIneligibilityReason;
  explanation: string;
};

/**
 * The columns and relation probes `dependentLinkBlockers` reads. Both the write
 * route and the search's diagnostic query select at least these.
 */
export const DEPENDENT_LINK_CANDIDATE_SELECT = {
  id: true,
  archivedAt: true,
  parentMemberId: true,
  secondaryParentId: true,
  dependents: { select: { id: true }, take: 1 },
  secondaryDependents: { select: { id: true }, take: 1 },
} satisfies Prisma.MemberSelect;

export type DependentLinkCandidate = {
  id: string;
  archivedAt: Date | null;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  /** Selected with `take: 1` — only emptiness is read. */
  dependents?: ReadonlyArray<unknown> | null;
  secondaryDependents?: ReadonlyArray<unknown> | null;
};

/**
 * Every reason this candidate cannot be linked under `parentMemberId`, in
 * `DEPENDENT_LINK_INELIGIBILITY_REASONS` order. Empty means eligible (subject to
 * the write route's ancestry walk).
 */
export function dependentLinkBlockers(
  parentMemberId: string,
  candidate: DependentLinkCandidate,
): DependentLinkIneligibilityReason[] {
  const blockers: DependentLinkIneligibilityReason[] = [];

  if (candidate.archivedAt) {
    blockers.push("ARCHIVED");
  }
  if (candidate.id === parentMemberId) {
    blockers.push("SELF");
  }
  if (
    candidate.parentMemberId === parentMemberId ||
    candidate.secondaryParentId === parentMemberId
  ) {
    blockers.push("ALREADY_LINKED_TO_PARENT");
  }
  if (candidate.parentMemberId && candidate.secondaryParentId) {
    blockers.push("TWO_PARENTS");
  }
  if (
    (candidate.dependents?.length ?? 0) > 0 ||
    (candidate.secondaryDependents?.length ?? 0) > 0
  ) {
    blockers.push("HAS_DEPENDANTS");
  }

  return blockers;
}

/**
 * The SQL half of the same predicate: the `AND` conditions that select exactly
 * the members `dependentLinkBlockers` would clear.
 *
 * NULL SEMANTICS (#2254 — the bug this file exists for). `parentMemberId` and
 * `secondaryParentId` are nullable. Prisma compiles `{ not: x }` on a nullable
 * column to a bare `"col" <> $1`, and in SQL `NULL <> 'x'` is UNKNOWN, not TRUE
 * — so the row is dropped. The two "not already linked to this parent" clauses
 * were written that way, which silently hid EVERY member with no parent
 * recorded: the overwhelming majority of valid candidates, and the reason the
 * dialog reported "No eligible members found" for perfectly linkable members.
 * The `OR ... IS NULL` form below is the repo's null-safe idiom (compare
 * `src/lib/booking-policies.ts`, `src/lib/cancellation.ts`,
 * `src/lib/authoritative-fees.ts`) and compiles to
 * `("col" IS NULL OR "col" <> $1)`.
 *
 * ACTIVE / ARCHIVED (#2254). `archivedAt: null` is filtered because the write
 * route rejects an archived target outright. `active` is deliberately NOT
 * filtered: the write route requires the PARENT to be active but accepts an
 * inactive target, and the dialog renders an "Inactive" badge on the chosen
 * candidate — filtering here would hide members the route is happy to link.
 * (The parent-side search, `parentLinkEligibleFor`, does filter `active: true`,
 * because there the searched-for member becomes the parent.)
 */
export function dependentLinkCandidateWhere(
  parentMemberId: string,
): Prisma.MemberWhereInput[] {
  return [
    { id: { not: parentMemberId } },
    {
      OR: [
        { parentMemberId: null },
        { parentMemberId: { not: parentMemberId } },
      ],
    },
    {
      OR: [
        { secondaryParentId: null },
        { secondaryParentId: { not: parentMemberId } },
      ],
    },
    // At most two parents: at least one of the two columns must still be free.
    { OR: [{ parentMemberId: null }, { secondaryParentId: null }] },
    // Two-generation invariant: a member who is already someone's parent cannot
    // be linked under another member. Mirrors the write route's 422 and the
    // family-group request reviewer; relaxing it is owner-gated (#2255).
    { dependents: { none: {} } },
    { secondaryDependents: { none: {} } },
    { archivedAt: null },
  ];
}
