import type { Prisma } from "@prisma/client";
import type { prisma } from "@/lib/prisma";
import { MAX_PARENT_LINK_CHAIN_LENGTH } from "@/lib/member-family-link-depth";

/**
 * Read-only membership family tree (#2253, owner decisions on the issue).
 *
 * Derives the WHOLE CONNECTED FAMILY GRAPH for one member — every recorded
 * parent / second-parent link and every CONFIRMED partner link, followed
 * transitively across households — and shapes it as a display forest for the
 * admin member page's Family card. Nothing here is stored: the tree is a VIEW
 * of `Member.parentMemberId` / `Member.secondaryParentId` /
 * `MemberPartnerLink` and must never become a second place to edit them.
 *
 * BOUNDS. The link graph can contain cycles (bad legacy data can make a member
 * their own ancestor; partner links plus shared children legitimately close
 * loops), so the walk is belt-and-braces bounded:
 *
 *  1. A visited set — each member is admitted once, at the generation it was
 *     first reached, so no cycle can be walked twice.
 *  2. A vertical cap of {@link MAX_PARENT_LINK_CHAIN_LENGTH} parent-links
 *     above and below the viewed member — i.e. at most
 *     `MAX_FAMILY_LINK_GENERATIONS` generations counting the root's own, in
 *     each vertical direction, applying #2255's cap to the walk itself.
 *     Partner hops never change generation, so sideways travel cannot smuggle
 *     the walk past the cap by zig-zagging up through another household.
 *  3. A total size cap of {@link MAX_FAMILY_TREE_MEMBERS} members, so a
 *     pathological graph (or a partner-hop chain across many households)
 *     terminates even though partner hops are generation-free.
 *
 * Anything cut off by bound 2 or 3 sets `truncated`, which the card states
 * rather than silently pretending the family ends there.
 *
 * PRIVACY. The tree reports names, relationship structure, badges, and — only
 * for non-archived members — the email address the admin member page already
 * shows. Archived members stay in the tree (dropping them would make a
 * grandparent look unrelated) but their contact details are suppressed
 * (decision 4). The email-inheritance line reports the STORED #2255 resolver
 * answer (`Member.inheritEmailFromId`, which the resolver keeps flat-terminal)
 * — it never re-derives its own answer, so the tree can never disagree with
 * what the club actually sends.
 */

type FamilyTreeClient = Prisma.TransactionClient | typeof prisma;

/**
 * Hard ceiling on how many members one tree may contain. Generous — a real
 * four-generation multi-household family is a few dozen people — but present
 * so the generation-free partner hops (bound 3 above) always terminate.
 */
export const MAX_FAMILY_TREE_MEMBERS = 150;

const FAMILY_TREE_MEMBER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  ageTier: true,
  active: true,
  canLogin: true,
  archivedAt: true,
  cancelledAt: true,
  parentMemberId: true,
  secondaryParentId: true,
  inheritEmailFromId: true,
  inheritEmailFrom: { select: { id: true, firstName: true, lastName: true } },
  billingFamilyGroupId: true,
  familyGroupMemberships: {
    select: {
      familyGroupId: true,
      familyGroup: { select: { id: true, name: true } },
    },
  },
} as const;

type FamilyTreeMemberRecord = {
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
  inheritEmailFrom: { id: string; firstName: string; lastName: string } | null;
  billingFamilyGroupId: string | null;
  familyGroupMemberships: Array<{
    familyGroupId: string;
    familyGroup: { id: string; name: string | null } | null;
  }>;
};

type ParentLinkKind = "PRIMARY" | "SECONDARY";

export type FamilyTreeRelationship = {
  /** Short label rendered on the node, e.g. "Parent", "Half-sibling". */
  label: string;
  /**
   * True when the relationship to the viewed member is worked out from the
   * links rather than being one of their own recorded links (their parents,
   * their dependants, their confirmed partner). Derived nodes render with the
   * dashed "derived, not stored" treatment.
   */
  derived: boolean;
  /** Full sr-only sentence for the node. */
  description: string;
};

export type FamilyTreeNode = {
  id: string;
  name: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  archived: boolean;
  cancelled: boolean;
  isRoot: boolean;
  /** Generations from the viewed member: negative = older, positive = younger. */
  generation: number;
  relationship: FamilyTreeRelationship;
  /** How this node hangs off the node above it in the rendered list. */
  linkToDisplayParent: ParentLinkKind | null;
  /** Suppressed (null) for archived members — decision 4. */
  email: string | null;
  /** How many OTHER tree members' club email is this member's address. */
  emailRecipientCount: number;
  /**
   * The stored #2255 resolver answer for this member, reported verbatim.
   * `beyondDirectParent` mirrors the mockup rule: badge-worthy only when the
   * mailbox is NOT one of the member's own recorded parents.
   */
  notificationEmail: {
    sourceId: string;
    sourceName: string;
    /** e.g. "grandparent" when the source is in the tree; null otherwise. */
    sourceRelationship: string | null;
    beyondDirectParent: boolean;
  } | null;
  /** The recorded parent NOT used as this node's position in the list. */
  secondParentInline: { id: string; name: string } | null;
  /** Confirmed partner, when the partner is in the tree. */
  partner: { id: string; name: string; attachedHere: boolean } | null;
  /** Partner rendered beside this node (double-rule treatment). */
  attachedPartner: FamilyTreeNode | null;
  familyGroups: Array<{ id: string; name: string | null; billing: boolean }>;
  children: FamilyTreeNode[];
};

export type MemberFamilyTree = {
  root: { id: string; name: string };
  roots: FamilyTreeNode[];
  memberCount: number;
  /** Distinct generation span rendered, e.g. 4 for great-grandparent → child. */
  generationSpan: number;
  /** True when the vertical cap or the size cap cut reachable members off. */
  truncated: boolean;
  /** True when at least one rendered relationship is derived-not-stored. */
  hasDerivedRelationships: boolean;
};

type GraphNode = {
  record: FamilyTreeMemberRecord;
  generation: number;
  /** Discovery order — the deterministic tie-break everywhere below. */
  index: number;
};

type FamilyGraph = {
  rootId: string;
  nodes: Map<string, GraphNode>;
  /** memberId -> confirmed partner's memberId (both directions present). */
  partnerOf: Map<string, string>;
  truncated: boolean;
};

function displayName(member: { firstName: string; lastName: string }): string {
  return `${member.firstName} ${member.lastName}`.trim();
}

/**
 * Walk the whole connected family graph from `rootId`. Cycle-safe via the
 * visited map; vertically bounded to ±{@link MAX_PARENT_LINK_CHAIN_LENGTH}
 * generations from the root; size-bounded by {@link MAX_FAMILY_TREE_MEMBERS}.
 *
 * Each member enters the frontier exactly once, and each frontier round asks
 * three batched questions: the frontier's parents (by id), its children (by
 * parent column), and its CONFIRMED partner links. Because every member is in
 * the frontier exactly once, every member's partner links are seen exactly
 * once — so partner-hop chains terminate with the visited map alone.
 */
async function collectFamilyGraph(
  db: FamilyTreeClient,
  rootId: string,
): Promise<FamilyGraph | null> {
  const rootRecord = (await db.member.findUnique({
    where: { id: rootId },
    select: FAMILY_TREE_MEMBER_SELECT,
  })) as FamilyTreeMemberRecord | null;
  if (!rootRecord) return null;

  const nodes = new Map<string, GraphNode>();
  nodes.set(rootId, { record: rootRecord, generation: 0, index: 0 });
  const partnerOf = new Map<string, string>();
  let truncated = false;
  let nextIndex = 1;

  let frontier: string[] = [rootId];

  while (frontier.length > 0 && nodes.size < MAX_FAMILY_TREE_MEMBERS) {
    // Candidate ids for this round, in a deterministic discovery order:
    // parents of each frontier member (primary before secondary), then
    // partners, then children (name-ordered by the query). First discovery
    // fixes a candidate's generation — a member reachable at two generations
    // through inconsistent data keeps the one nearest the root.
    const candidateGeneration = new Map<string, number>();
    const candidateOrder: string[] = [];
    const addCandidate = (id: string, generation: number) => {
      if (nodes.has(id) || candidateGeneration.has(id)) return;
      if (Math.abs(generation) > MAX_PARENT_LINK_CHAIN_LENGTH) {
        // Vertical cap (#2255 applied to the walk): a member more than
        // MAX_PARENT_LINK_CHAIN_LENGTH parent-links above or below the viewed
        // member is out of reach, and the card says so via `truncated`.
        truncated = true;
        return;
      }
      candidateGeneration.set(id, generation);
      candidateOrder.push(id);
    };

    for (const id of frontier) {
      const node = nodes.get(id);
      if (!node) continue;
      if (node.record.parentMemberId) {
        addCandidate(node.record.parentMemberId, node.generation - 1);
      }
      if (node.record.secondaryParentId) {
        addCandidate(node.record.secondaryParentId, node.generation - 1);
      }
    }

    const partnerLinks = (await db.memberPartnerLink.findMany({
      where: {
        status: "CONFIRMED",
        OR: [{ memberAId: { in: frontier } }, { memberBId: { in: frontier } }],
      },
      select: { id: true, memberAId: true, memberBId: true },
      orderBy: { id: "asc" },
    })) as Array<{ id: string; memberAId: string; memberBId: string }>;

    for (const link of partnerLinks) {
      // The service layer allows at most one CONFIRMED partner per member;
      // first-link-wins (by link id order) keeps this deterministic even on
      // data that breaches that invariant.
      if (partnerOf.has(link.memberAId) || partnerOf.has(link.memberBId)) {
        continue;
      }
      partnerOf.set(link.memberAId, link.memberBId);
      partnerOf.set(link.memberBId, link.memberAId);
      const anchor = nodes.get(link.memberAId) ?? nodes.get(link.memberBId);
      if (!anchor) continue;
      const otherId = nodes.has(link.memberAId) ? link.memberBId : link.memberAId;
      // Partner hop: same generation, no vertical movement.
      addCandidate(otherId, anchor.generation);
    }

    const childRows = (await db.member.findMany({
      where: {
        OR: [
          { parentMemberId: { in: frontier } },
          { secondaryParentId: { in: frontier } },
        ],
      },
      select: FAMILY_TREE_MEMBER_SELECT,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }],
    })) as FamilyTreeMemberRecord[];

    const recordById = new Map<string, FamilyTreeMemberRecord>();
    for (const child of childRows) {
      recordById.set(child.id, child);
      // A child sits one generation below whichever of its recorded parents is
      // already placed — the primary parent's placement wins when both are.
      const viaPrimary = child.parentMemberId
        ? nodes.get(child.parentMemberId)
        : undefined;
      const viaSecondary = child.secondaryParentId
        ? nodes.get(child.secondaryParentId)
        : undefined;
      const parentNode = viaPrimary ?? viaSecondary;
      if (!parentNode) continue;
      addCandidate(child.id, parentNode.generation + 1);
    }

    // Fetch the records the child query did not already return (parents and
    // partners are known only by id so far).
    const missingIds = candidateOrder.filter((id) => !recordById.has(id));
    if (missingIds.length > 0) {
      const rows = (await db.member.findMany({
        where: { id: { in: missingIds } },
        select: FAMILY_TREE_MEMBER_SELECT,
      })) as FamilyTreeMemberRecord[];
      for (const row of rows) recordById.set(row.id, row);
    }

    const added: string[] = [];
    for (const id of candidateOrder) {
      if (nodes.size >= MAX_FAMILY_TREE_MEMBERS) {
        truncated = true;
        break;
      }
      const record = recordById.get(id);
      // A dangling parent id (SetNull raced, or a fetch miss) is skipped, not
      // fatal: the tree renders what exists.
      if (!record) continue;
      nodes.set(id, {
        record,
        generation: candidateGeneration.get(id) ?? 0,
        index: nextIndex,
      });
      nextIndex += 1;
      added.push(id);
    }

    frontier = added;
  }

  return { rootId, nodes, partnerOf, truncated };
}

/**
 * Minimum parent-link distance from `startId` up to each in-graph ancestor.
 * Bounded by the chain cap and a visited set, so cyclic data terminates; the
 * MINIMUM distance is deliberate — for naming a relationship the closest
 * reading is the honest one (the depth-cap lib wants the maximum for the
 * opposite reason: refusing links).
 */
function ancestorDepths(
  graph: FamilyGraph,
  startId: string,
): Map<string, number> {
  const depths = new Map<string, number>();
  const visited = new Set<string>([startId]);
  let frontier = [startId];
  for (
    let depth = 1;
    depth <= MAX_PARENT_LINK_CHAIN_LENGTH && frontier.length > 0;
    depth += 1
  ) {
    const next: string[] = [];
    for (const id of frontier) {
      const node = graph.nodes.get(id);
      if (!node) continue;
      for (const parentId of [
        node.record.parentMemberId,
        node.record.secondaryParentId,
      ]) {
        if (!parentId || visited.has(parentId)) continue;
        visited.add(parentId);
        if (graph.nodes.has(parentId)) {
          depths.set(parentId, depth);
          next.push(parentId);
        }
      }
    }
    frontier = next;
  }
  return depths;
}

const ANCESTOR_LABELS = ["", "Parent", "Grandparent", "Great-grandparent"];
const DESCENDANT_LABELS = ["", "Child", "Grandchild", "Great-grandchild"];

const COLLATERAL_LABELS: Record<string, string> = {
  "2,1": "Aunt or uncle",
  "3,1": "Great-aunt or great-uncle",
  "1,2": "Niece or nephew",
  "1,3": "Great-niece or great-nephew",
  "2,2": "Cousin",
  "3,2": "Parent's cousin",
  "2,3": "Cousin's child",
  "3,3": "Second cousin",
};

function recordedParentIds(record: FamilyTreeMemberRecord): Set<string> {
  const ids = new Set<string>();
  if (record.parentMemberId) ids.add(record.parentMemberId);
  if (record.secondaryParentId) ids.add(record.secondaryParentId);
  return ids;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

type BloodRelation = {
  label: string;
  /** Shared parents, for the sibling / half-sibling sr-only derivation. */
  sharedParentIds: string[];
};

/**
 * Blood relationship of `b` relative to `a` ("b is a's <label>"), or null when
 * no parent-link path connects them within the graph. Sibling vs half-sibling
 * follows the mockup rule: it compares WHICH parents are shared, not how many
 * — identical recorded parent sets are siblings, an overlapping-but-different
 * set is a half-sibling.
 */
function bloodRelation(
  graph: FamilyGraph,
  depthsById: Map<string, Map<string, number>>,
  aId: string,
  bId: string,
): BloodRelation | null {
  if (aId === bId) return { label: "Self", sharedParentIds: [] };
  const aDepths = depthsById.get(aId);
  const bDepths = depthsById.get(bId);
  if (!aDepths || !bDepths) return null;

  const upToB = aDepths.get(bId);
  if (upToB !== undefined && upToB < ANCESTOR_LABELS.length) {
    return { label: ANCESTOR_LABELS[upToB], sharedParentIds: [] };
  }
  const downToB = bDepths.get(aId);
  if (downToB !== undefined && downToB < DESCENDANT_LABELS.length) {
    return { label: DESCENDANT_LABELS[downToB], sharedParentIds: [] };
  }

  // Closest common ancestor: minimise total distance, then the distance on the
  // viewed member's side, then ancestor id — all deterministic.
  let best: { u: number; d: number; ancestorId: string } | null = null;
  for (const [ancestorId, u] of aDepths) {
    const d = bDepths.get(ancestorId);
    if (d === undefined) continue;
    if (
      !best ||
      u + d < best.u + best.d ||
      (u + d === best.u + best.d &&
        (u < best.u || (u === best.u && ancestorId < best.ancestorId)))
    ) {
      best = { u, d, ancestorId };
    }
  }
  if (!best) return null;

  if (best.u === 1 && best.d === 1) {
    const aParents = recordedParentIds(graph.nodes.get(aId)!.record);
    const bParents = recordedParentIds(graph.nodes.get(bId)!.record);
    const shared = [...aParents].filter((id) => bParents.has(id));
    const label = setsEqual(aParents, bParents) ? "Sibling" : "Half-sibling";
    return { label, sharedParentIds: shared };
  }

  const label = COLLATERAL_LABELS[`${best.u},${best.d}`];
  return label ? { label, sharedParentIds: [] } : null;
}

type RelationshipKind =
  | "self"
  | "stored-parent"
  | "stored-child"
  | "stored-partner"
  | "blood"
  | "affinity"
  | "unknown";

type ResolvedRelationship = {
  kind: RelationshipKind;
  label: string;
  sharedParentIds: string[];
};

/**
 * Label every graph member relative to the root. Stored relationships (the
 * root's own recorded parents, dependants, and confirmed partner) win first;
 * then blood relationships via parent-link paths; then affinity rules applied
 * to a fixpoint (co-parents, partners of labelled members, relatives of the
 * root's partner, parents/children of labelled members); anything still
 * unlabelled — reachable only through chains of marriages the rules do not
 * name — is "Extended family".
 */
function resolveRelationships(
  graph: FamilyGraph,
): Map<string, ResolvedRelationship> {
  const root = graph.nodes.get(graph.rootId)!;
  const depthsById = new Map<string, Map<string, number>>();
  for (const id of graph.nodes.keys()) {
    depthsById.set(id, ancestorDepths(graph, id));
  }

  const resolved = new Map<string, ResolvedRelationship>();
  resolved.set(graph.rootId, {
    kind: "self",
    label: "This member",
    sharedParentIds: [],
  });

  const rootParents = recordedParentIds(root.record);
  const ordered = [...graph.nodes.values()].sort((a, b) => a.index - b.index);

  for (const node of ordered) {
    if (resolved.has(node.record.id)) continue;
    const id = node.record.id;

    if (rootParents.has(id)) {
      resolved.set(id, {
        kind: "stored-parent",
        label: root.record.parentMemberId === id ? "Parent" : "Second parent",
        sharedParentIds: [],
      });
      continue;
    }
    if (recordedParentIds(node.record).has(graph.rootId)) {
      resolved.set(id, {
        kind: "stored-child",
        label: "Dependant",
        sharedParentIds: [],
      });
      continue;
    }
    if (graph.partnerOf.get(graph.rootId) === id) {
      resolved.set(id, {
        kind: "stored-partner",
        label: "Partner",
        sharedParentIds: [],
      });
      continue;
    }

    const blood = bloodRelation(graph, depthsById, graph.rootId, id);
    if (blood) {
      resolved.set(id, {
        kind: "blood",
        label: blood.label,
        sharedParentIds: blood.sharedParentIds,
      });
    }
  }

  // Affinity passes, repeated until no node gains a label. Each rule may
  // reference labels resolved by earlier passes, which is what lets a chain
  // like "sibling's partner's parent" resolve step by step.
  const affinity = (id: string): ResolvedRelationship | null => {
    const node = graph.nodes.get(id)!;

    // Co-parent: shares a recorded child with the viewed member.
    for (const other of ordered) {
      const parents = recordedParentIds(other.record);
      if (parents.has(id) && parents.has(graph.rootId)) {
        return {
          kind: "affinity",
          label: `Co-parent of ${other.record.firstName}`,
          sharedParentIds: [],
        };
      }
    }

    // Partner of an already-labelled member.
    const partnerId = graph.partnerOf.get(id);
    if (partnerId && resolved.has(partnerId) && graph.nodes.has(partnerId)) {
      const partner = graph.nodes.get(partnerId)!;
      return {
        kind: "affinity",
        label: `${displayName(partner.record)}'s partner`,
        sharedParentIds: [],
      };
    }

    // Blood relative of the root's confirmed partner.
    const rootPartnerId = graph.partnerOf.get(graph.rootId);
    if (rootPartnerId && graph.nodes.has(rootPartnerId)) {
      const viaPartner = bloodRelation(
        graph,
        depthsById,
        rootPartnerId,
        id,
      );
      if (viaPartner && viaPartner.label !== "Self") {
        const partner = graph.nodes.get(rootPartnerId)!;
        return {
          kind: "affinity",
          label: `${displayName(partner.record)}'s ${viaPartner.label.toLowerCase()}`,
          sharedParentIds: [],
        };
      }
    }

    // Recorded parent or child of an already-labelled member.
    for (const other of ordered) {
      if (!resolved.has(other.record.id)) continue;
      if (recordedParentIds(other.record).has(id)) {
        return {
          kind: "affinity",
          label: `${displayName(other.record)}'s parent`,
          sharedParentIds: [],
        };
      }
      if (recordedParentIds(node.record).has(other.record.id)) {
        return {
          kind: "affinity",
          label: `${displayName(other.record)}'s child`,
          sharedParentIds: [],
        };
      }
    }

    return null;
  };

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of ordered) {
      if (resolved.has(node.record.id)) continue;
      const result = affinity(node.record.id);
      if (result) {
        resolved.set(node.record.id, result);
        progressed = true;
      }
    }
  }

  for (const node of ordered) {
    if (!resolved.has(node.record.id)) {
      resolved.set(node.record.id, {
        kind: "unknown",
        label: "Extended family",
        sharedParentIds: [],
      });
    }
  }

  return resolved;
}

function describeRelationship(
  graph: FamilyGraph,
  relationship: ResolvedRelationship,
  node: GraphNode,
  extras: string[],
): string {
  const root = graph.nodes.get(graph.rootId)!;
  const rootName = displayName(root.record);
  const name = displayName(node.record);

  let base: string;
  switch (relationship.kind) {
    case "self":
      base = `${name} — the member you are viewing.`;
      break;
    case "stored-parent":
      base = `${name} is ${rootName}'s recorded ${relationship.label.toLowerCase()}.`;
      break;
    case "stored-child":
      base = `${name} is a recorded dependant of ${rootName}.`;
      break;
    case "stored-partner":
      base = `${name} is ${rootName}'s confirmed partner.`;
      break;
    case "blood": {
      base = `${name} is ${rootName}'s ${relationship.label.toLowerCase()} — worked out from the recorded parent links, not stored.`;
      break;
    }
    default:
      base = `${name} is connected to ${rootName}'s family as ${relationship.label.toLowerCase()} — worked out from the recorded links, not stored.`;
      break;
  }

  const sharedNames = relationship.sharedParentIds
    .map((id) => graph.nodes.get(id))
    .filter((shared): shared is GraphNode => Boolean(shared))
    .map((shared) => displayName(shared.record));
  if (sharedNames.length > 0) {
    base += ` Shares ${sharedNames.length === 1 ? "parent" : "parents"} ${sharedNames.join(" and ")}.`;
  }

  return [base, ...extras].join(" ");
}

/**
 * Position every member in a render forest. Each member appears exactly once:
 * nested under its primary parent when that parent is in the tree (second
 * parent named inline, per the mockup), else under its secondary parent, else
 * attached beside its confirmed partner (the married-in case), else as a
 * forest root. Display cycles from corrupt parent data are broken by
 * promoting the first unreachable member (discovery order) to a root and
 * detaching it from its parent, repeated until everyone is reachable — so a
 * parent loop renders both members once instead of recursing or vanishing.
 */
function buildForest(graph: FamilyGraph): {
  rootIds: string[];
  displayParentOf: Map<string, { parentId: string; link: ParentLinkKind }>;
  attachedTo: Map<string, string>;
} {
  const displayParentOf = new Map<
    string,
    { parentId: string; link: ParentLinkKind }
  >();
  const attachedTo = new Map<string, string>();
  const ordered = [...graph.nodes.values()].sort((a, b) => a.index - b.index);

  for (const node of ordered) {
    const { record } = node;
    if (record.parentMemberId && graph.nodes.has(record.parentMemberId)) {
      displayParentOf.set(record.id, {
        parentId: record.parentMemberId,
        link: "PRIMARY",
      });
    } else if (
      record.secondaryParentId &&
      graph.nodes.has(record.secondaryParentId)
    ) {
      displayParentOf.set(record.id, {
        parentId: record.secondaryParentId,
        link: "SECONDARY",
      });
    }
  }

  for (const node of ordered) {
    const id = node.record.id;
    if (displayParentOf.has(id)) continue;
    const partnerId = graph.partnerOf.get(id);
    if (!partnerId || !graph.nodes.has(partnerId)) continue;
    if (id === graph.rootId) continue; // the viewed member anchors, never attaches
    const partner = graph.nodes.get(partnerId)!;
    const partnerAnchors =
      displayParentOf.has(partnerId) ||
      partnerId === graph.rootId ||
      (!displayParentOf.has(partnerId) && partner.index < node.index);
    if (partnerAnchors && !attachedTo.has(partnerId)) {
      attachedTo.set(id, partnerId);
    }
  }

  const computeRoots = () =>
    ordered
      .map((node) => node.record.id)
      .filter((id) => !displayParentOf.has(id) && !attachedTo.has(id));

  const childrenOf = new Map<string, string[]>();
  const rebuildChildren = () => {
    childrenOf.clear();
    for (const node of ordered) {
      const parent = displayParentOf.get(node.record.id);
      if (!parent) continue;
      const list = childrenOf.get(parent.parentId) ?? [];
      list.push(node.record.id);
      childrenOf.set(parent.parentId, list);
    }
  };

  // Cycle-break loop: bounded by the member count because every pass either
  // reaches everyone or permanently promotes one member to a root.
  for (let pass = 0; pass < graph.nodes.size; pass += 1) {
    rebuildChildren();
    const reachable = new Set<string>();
    const stack = computeRoots();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const childId of childrenOf.get(id) ?? []) stack.push(childId);
      for (const [attachedId, anchorId] of attachedTo) {
        if (anchorId === id) stack.push(attachedId);
      }
    }
    const unreached = ordered.find((node) => !reachable.has(node.record.id));
    if (!unreached) break;
    displayParentOf.delete(unreached.record.id);
    attachedTo.delete(unreached.record.id);
  }

  const roots = computeRoots().sort((a, b) => {
    const nodeA = graph.nodes.get(a)!;
    const nodeB = graph.nodes.get(b)!;
    if (nodeA.generation !== nodeB.generation) {
      return nodeA.generation - nodeB.generation;
    }
    return nodeA.index - nodeB.index;
  });

  return { rootIds: roots, displayParentOf, attachedTo };
}

/**
 * The read-only family tree for one member, or null when the member does not
 * exist. Admin-only (decision 1): the caller gates on membership:view, the
 * same permission that already exposes every member's detail page — the tree
 * shows nothing an admin could not reach by clicking through those pages, and
 * suppresses archived members' contact details (decision 4).
 */
export async function getMemberFamilyTree(
  db: FamilyTreeClient,
  memberId: string,
): Promise<MemberFamilyTree | null> {
  const collected = await collectFamilyGraph(db, memberId);
  if (!collected) return null;
  // Alias after the null-guard: `serialize` below is a hoisted declaration, so
  // TypeScript will not carry the narrowing into it.
  const graph: FamilyGraph = collected;

  const relationships = resolveRelationships(graph);
  const { rootIds, displayParentOf, attachedTo } = buildForest(graph);
  const depthsById = new Map<string, Map<string, number>>();
  for (const id of graph.nodes.keys()) {
    depthsById.set(id, ancestorDepths(graph, id));
  }

  const recipientCounts = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    const sourceId = node.record.inheritEmailFromId;
    if (!sourceId || sourceId === node.record.id) continue;
    recipientCounts.set(sourceId, (recipientCounts.get(sourceId) ?? 0) + 1);
  }

  const attachedByAnchor = new Map<string, string>();
  for (const [attachedId, anchorId] of attachedTo) {
    attachedByAnchor.set(anchorId, attachedId);
  }

  const childrenOf = new Map<string, Array<{ id: string; link: ParentLinkKind }>>();
  const orderedNodes = [...graph.nodes.values()].sort((a, b) => a.index - b.index);
  for (const node of orderedNodes) {
    const parent = displayParentOf.get(node.record.id);
    if (!parent) continue;
    const list = childrenOf.get(parent.parentId) ?? [];
    list.push({ id: node.record.id, link: parent.link });
    childrenOf.set(parent.parentId, list);
  }

  const serialized = new Set<string>();

  function serialize(id: string, linkToDisplayParent: ParentLinkKind | null): FamilyTreeNode | null {
    if (serialized.has(id)) return null; // defensive: forest building precludes this
    serialized.add(id);
    const node = graph.nodes.get(id)!;
    const { record } = node;
    const relationship = relationships.get(id)!;
    const archived = Boolean(record.archivedAt);
    const name = displayName(record);

    // The STORED resolver answer (#2255), reported verbatim — never re-derived.
    const source = record.inheritEmailFrom;
    let notificationEmail: FamilyTreeNode["notificationEmail"] = null;
    if (source && record.inheritEmailFromId) {
      const beyondDirectParent = !recordedParentIds(record).has(source.id);
      let sourceRelationship: string | null = null;
      if (graph.nodes.has(source.id)) {
        const relation = bloodRelation(graph, depthsById, id, source.id);
        if (relation && relation.label !== "Self") {
          sourceRelationship = relation.label.toLowerCase();
        }
      }
      notificationEmail = {
        sourceId: source.id,
        sourceName: displayName(source),
        sourceRelationship,
        beyondDirectParent,
      };
    }

    // Second parent named inline (mockup): the recorded parent that is NOT the
    // node's position in the list, when that parent is in the tree.
    const displayParent = displayParentOf.get(id);
    let secondParentInline: FamilyTreeNode["secondParentInline"] = null;
    const inlineParentId = [record.parentMemberId, record.secondaryParentId].find(
      (candidate) =>
        candidate &&
        candidate !== displayParent?.parentId &&
        graph.nodes.has(candidate),
    );
    if (inlineParentId) {
      secondParentInline = {
        id: inlineParentId,
        name: displayName(graph.nodes.get(inlineParentId)!.record),
      };
    }

    const partnerId = graph.partnerOf.get(id);
    const partnerNode =
      partnerId && graph.nodes.has(partnerId)
        ? graph.nodes.get(partnerId)!
        : null;
    const attachedPartnerId = attachedByAnchor.get(id) ?? null;

    const extras: string[] = [];
    if (archived) extras.push("Archived member — contact details hidden.");
    if (secondParentInline) {
      extras.push(`Second parent: ${secondParentInline.name}.`);
    }
    if (partnerNode) {
      extras.push(`Confirmed partner of ${displayName(partnerNode.record)}.`);
    }
    if (notificationEmail) {
      extras.push(
        `Club email goes to ${notificationEmail.sourceName}${
          notificationEmail.sourceRelationship
            ? ` (${notificationEmail.sourceRelationship})`
            : ""
        }.`,
      );
    }

    const children = (childrenOf.get(id) ?? [])
      .map((child) => serialize(child.id, child.link))
      .filter((child): child is FamilyTreeNode => Boolean(child));

    const attachedPartner = attachedPartnerId
      ? serialize(attachedPartnerId, null)
      : null;

    return {
      id,
      name,
      ageTier: record.ageTier,
      active: record.active,
      canLogin: record.canLogin,
      archived,
      cancelled: Boolean(record.cancelledAt),
      isRoot: id === graph.rootId,
      generation: node.generation,
      relationship: {
        label: relationship.label,
        derived:
          relationship.kind === "blood" ||
          relationship.kind === "affinity" ||
          relationship.kind === "unknown",
        description: describeRelationship(graph, relationship, node, extras),
      },
      linkToDisplayParent,
      email: archived ? null : record.email || null,
      emailRecipientCount: recipientCounts.get(id) ?? 0,
      notificationEmail,
      secondParentInline,
      partner: partnerNode
        ? {
            id: partnerNode.record.id,
            name: displayName(partnerNode.record),
            attachedHere: attachedPartnerId === partnerNode.record.id,
          }
        : null,
      attachedPartner,
      familyGroups: (record.familyGroupMemberships ?? []).map((membership) => ({
        id: membership.familyGroupId,
        name: membership.familyGroup?.name ?? null,
        billing: membership.familyGroupId === record.billingFamilyGroupId,
      })),
      children,
    };
  }

  const roots = rootIds
    .map((id) => serialize(id, null))
    .filter((node): node is FamilyTreeNode => Boolean(node));

  let minGeneration = 0;
  let maxGeneration = 0;
  for (const node of graph.nodes.values()) {
    if (node.generation < minGeneration) minGeneration = node.generation;
    if (node.generation > maxGeneration) maxGeneration = node.generation;
  }

  const rootRecord = graph.nodes.get(graph.rootId)!.record;
  let hasDerived = false;
  for (const relationship of relationships.values()) {
    if (
      relationship.kind === "blood" ||
      relationship.kind === "affinity" ||
      relationship.kind === "unknown"
    ) {
      hasDerived = true;
      break;
    }
  }

  return {
    root: { id: graph.rootId, name: displayName(rootRecord) },
    roots,
    memberCount: graph.nodes.size,
    generationSpan: maxGeneration - minGeneration + 1,
    truncated: graph.truncated,
    hasDerivedRelationships: hasDerived,
  };
}
