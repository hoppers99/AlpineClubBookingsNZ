import type { Prisma } from "@prisma/client";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";
import { MAX_PARENT_LINK_CHAIN_LENGTH } from "@/lib/member-family-link-depth";
import type { prisma } from "@/lib/prisma";

type ParentLinkKind = "PRIMARY" | "SECONDARY";

type ParentLinkClient = Prisma.TransactionClient | typeof prisma;

export type ParentLinkSummary = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier?: string;
  active?: boolean;
  canLogin?: boolean;
  inheritEmailFromId?: string | null;
  parentLinkType: ParentLinkKind;
};

/**
 * The FLAT, one-hop reading of "whose email does a dependant of this parent
 * inherit?": the parent's own source if the parent inherits, else the parent.
 *
 * Kept because stored inheritance is always flat (see
 * {@link resolveInheritedEmailSourceId}), so this is the right answer whenever
 * the parent is itself a usable source — which the admin link route guarantees
 * for the common case by requiring the parent be an active, non-archived adult.
 * It is NOT sufficient when the parent has no usable address of their own; use
 * the async resolver for that.
 */
export function getParentEmailSourceId(
  parent: { id: string; inheritEmailFromId?: string | null } | null | undefined
) {
  if (!parent) return null;
  return parent.inheritEmailFromId || parent.id;
}

/**
 * A member who can actually receive a dependant's notifications: an adult, not
 * archived, with a real address rather than a walk-in placeholder
 * (`@no-email.invalid`, #1935 — `sendEmail` silently drops those).
 *
 * The adult gate is deliberate and survives #2282 ("parentage may be recorded
 * at any age"): recording that a 16-year-old is a parent is a fact about the
 * family, whereas being the club's contact of record for someone else's
 * notifications is a responsibility function, and those stay adult-gated.
 */
function isUsableEmailSource(member: {
  ageTier: string;
  email: string;
  archivedAt: Date | null;
}): boolean {
  return (
    member.ageTier === "ADULT" &&
    !member.archivedAt &&
    !isPlaceholderContactEmail(member.email)
  );
}

export type InheritedEmailSourceResolution = {
  /** The member whose address the dependant should inherit; null if none. */
  sourceId: string | null;
  /**
   * How far above the direct parent the source sits. 0 = the parent themselves
   * (or the parent's own already-flattened source); ≥ 1 means the notification
   * address comes from further up the family chain, which the admin member
   * detail page states explicitly rather than leaving to be inferred.
   */
  generationsAboveParent: number;
};

/**
 * TRANSITIVE email inheritance (#2255, owner decision D9).
 *
 * With links capped at four generations rather than two, a dependant's direct
 * parent can be a middle generation with no address of their own — a non-login
 * child who grew up and had children, say. Resolving strictly one hop would
 * leave that middle generation's own children with no reachable contact at all,
 * so resolution now walks UP to the nearest ancestor who can actually receive
 * mail, bounded by the same depth cap as the links themselves.
 *
 * DETERMINISM / TIE-BREAK. The walk is nearest-first (level order), so a closer
 * ancestor always beats a further one. Within one level, ancestors are visited
 * in the order their descendants were dequeued, and each member contributes its
 * PRIMARY parent before its SECONDARY parent — so where two ancestors are
 * equally near, the one reached through primary-parent edges wins. Every node is
 * visited at most once, which makes the walk cycle-safe even on data that
 * predates the cap.
 *
 * WHAT IT RETURNS is a TERMINAL source — a member who does not themselves
 * inherit. Stored inheritance therefore stays FLAT: `Member.inheritEmailFromId`
 * always points straight at the mailbox. That is what lets every reader
 * (`getMemberEmail`, `member-email.ts`, the roster, the age-up cron, Xero
 * contact sync) keep its single `inheritEmailFrom` join and stay correct at any
 * depth. Do not "simplify" this by storing a pointer at the direct parent.
 */
export async function resolveInheritedEmailSourceId(
  db: ParentLinkClient,
  parentId: string,
): Promise<InheritedEmailSourceResolution> {
  const visited = new Set<string>([parentId]);
  let frontier: string[] = [parentId];

  for (let level = 0; level <= MAX_PARENT_LINK_CHAIN_LENGTH; level += 1) {
    if (frontier.length === 0) break;

    // Ordered by the queue, then re-ordered to the queue's order below: Prisma
    // returns rows in whatever order the database chooses, so the level's own
    // deterministic order has to be re-imposed rather than assumed.
    const rows = await db.member.findMany({
      where: { id: { in: frontier } },
      select: {
        id: true,
        email: true,
        ageTier: true,
        archivedAt: true,
        inheritEmailFromId: true,
        parentMemberId: true,
        secondaryParentId: true,
      },
    });
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const nextFrontier: string[] = [];

    for (const id of frontier) {
      const row = rowById.get(id);
      if (!row) continue;

      // An already-flattened pointer is itself terminal, so it short-circuits
      // the walk: this is the hop that keeps a non-login middle generation's
      // children pointed at the same mailbox as the middle generation.
      if (row.inheritEmailFromId) {
        return { sourceId: row.inheritEmailFromId, generationsAboveParent: level };
      }
      if (isUsableEmailSource(row)) {
        return { sourceId: row.id, generationsAboveParent: level };
      }

      for (const nextId of [row.parentMemberId, row.secondaryParentId]) {
        if (!nextId || visited.has(nextId)) continue;
        visited.add(nextId);
        nextFrontier.push(nextId);
      }
    }

    frontier = nextFrontier;
  }

  return { sourceId: null, generationsAboveParent: 0 };
}

export function buildParentLinks(member: {
  parent?: Omit<ParentLinkSummary, "parentLinkType"> | null;
  secondaryParent?: Omit<ParentLinkSummary, "parentLinkType"> | null;
}) {
  const links: ParentLinkSummary[] = [];
  if (member.parent) {
    links.push({ ...member.parent, parentLinkType: "PRIMARY" });
  }
  if (member.secondaryParent && member.secondaryParent.id !== member.parent?.id) {
    links.push({ ...member.secondaryParent, parentLinkType: "SECONDARY" });
  }
  return links;
}

/**
 * Which of a member's linked parents an admin's "notification email" selection
 * names. Selection-matching only — it deliberately does not decide the mailbox,
 * because that is a walk up the family chain (#2255,
 * {@link resolveInheritedEmailSourceId}) and this runs on plain arrays.
 *
 * Three outcomes, all meaningful:
 *  - `null`   — nothing selected: the member keeps their own email.
 *  - `undefined` — the selection names nobody this member is linked to; the
 *                  caller rejects the request rather than guessing.
 *  - a parent id — resolve the mailbox by walking up from that parent.
 *
 * The second lookup accepts a parent's already-flattened SOURCE id as well as
 * the parent's own id, because that is what the admin UI round-trips for a
 * parent who themselves inherits (it shows the mailbox, not the middleman).
 */
export function matchParentLinkIdForNotification(
  parentLinks: Array<{ id: string; inheritEmailFromId?: string | null }>,
  selectedId: string | null | undefined
): string | null | undefined {
  const normalized = selectedId?.trim() || null;
  if (!normalized) return null;

  const parent = parentLinks.find((link) => link.id === normalized);
  if (parent) {
    return parent.id;
  }

  const viaSource = parentLinks.find(
    (link) => getParentEmailSourceId(link) === normalized
  );
  return viaSource ? viaSource.id : undefined;
}
