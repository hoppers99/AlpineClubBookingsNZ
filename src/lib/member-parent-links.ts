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
 * the parent is itself a usable source. NOTHING GUARANTEES THAT ANY MORE: the
 * admin link route used to require an active, non-archived ADULT parent, and
 * #2282 removed the adult half — parentage is recorded at any age. A parent may
 * now be a minor, so this one-hop reading is correct only where the caller has
 * already established that the parent can receive mail. Everywhere else — and
 * in every WRITE path without exception — use the async resolver, which walks up
 * to the nearest ancestor who actually qualifies.
 */
export function getParentEmailSourceId(
  parent: { id: string; inheritEmailFromId?: string | null } | null | undefined
) {
  if (!parent) return null;
  return parent.inheritEmailFromId || parent.id;
}

/**
 * A member who can actually receive a dependant's notifications: an adult, not
 * archived, with a real address rather than a club-internal placeholder — a
 * walk-in contact's `@no-email.invalid` (#1935) or a deletion-anonymised
 * `@deleted.invalid` (#2255). `sendEmail` silently drops the first and the
 * second hard-bounces, so neither can be a family's contact of record.
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

/**
 * What every writer says when a dependant was meant to inherit a parent's email
 * and no ancestor in reach has a real address. Refused rather than silently
 * stored as "no inheritance": the admin asked for the mail to reach a parent,
 * and quietly leaving it on the dependant's own (often placeholder) address is
 * how a family stops receiving anything without anyone noticing.
 */
export const NO_INHERITABLE_EMAIL_SOURCE_MESSAGE =
  "No parent or ancestor in this family has a real email address to inherit. Record an email address for the parent first, or link without inheriting.";

export type InheritedEmailSourceResolution = {
  /** The member whose address the dependant should inherit; null if none. */
  sourceId: string | null;
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

  // `< MAX_PARENT_LINK_CHAIN_LENGTH + 1` reads as MAX+1 LEVELS: level 0 is the
  // parent themselves and levels 1..MAX are their ancestors, so the walk covers
  // exactly the chain the cap permits above a parent and no further. The
  // previous `<=` ran one level past that, reaching a fifth generation the link
  // rules would never have allowed to exist.
  for (let level = 0; level < MAX_PARENT_LINK_CHAIN_LENGTH + 1; level += 1) {
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
      //
      // TRUSTED ONLY IF STILL VALID. A stored pointer is a snapshot of a past
      // decision, and the member it names can have been archived, aged into a
      // placeholder address, deleted, or — the case terminality catches —
      // themselves been linked as an inheriting dependant since. Following it
      // blindly would propagate a dead or CHAINED mailbox to a new dependant and
      // call it resolved, so the target is re-read and, if it no longer
      // qualifies, the walk carries on upward as though the pointer were absent.
      //
      // Terminality is checked here and nowhere else in this branch because it
      // is only reachable here: the `else` below runs on rows whose own
      // `inheritEmailFromId` is null, so those are terminal by construction.
      // Without it the resolver hands back a chaining source, and the two
      // callers fail differently and both badly — a validating writer 422s with
      // "cannot chain through another inherited member", naming a member the
      // admin never chose, while the unlink route (which has no validator)
      // simply STORES it and breaks the flat-terminal invariant every one-hop
      // reader depends on.
      if (row.inheritEmailFromId) {
        const storedSource = await db.member.findUnique({
          where: { id: row.inheritEmailFromId },
          select: {
            id: true,
            email: true,
            ageTier: true,
            archivedAt: true,
            inheritEmailFromId: true,
          },
        });
        if (
          storedSource &&
          !storedSource.inheritEmailFromId &&
          isUsableEmailSource(storedSource)
        ) {
          return { sourceId: storedSource.id };
        }
        // Falls through to the parents rather than to this row's own address: a
        // member who inherits is not a source, and their `email` column is
        // typically a stale copy of the very mailbox just rejected.
      } else if (isUsableEmailSource(row)) {
        return { sourceId: row.id };
      }

      for (const nextId of [row.parentMemberId, row.secondaryParentId]) {
        if (!nextId || visited.has(nextId)) continue;
        visited.add(nextId);
        nextFrontier.push(nextId);
      }
    }

    frontier = nextFrontier;
  }

  return { sourceId: null };
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
 * A parent as one MEMBER may see another member's parent: the name and the link
 * type always, the email address and the status fields only where the rule
 * below allows them. Every optional field here is optional because the guard
 * can withhold it, not merely because a select might omit it.
 */
export type MemberFacingParentLink = Omit<ParentLinkSummary, "email"> & {
  email?: string;
};

/** A parent row read with the family groups it belongs to (#2424). */
export type ParentLinkWithGroups = Omit<ParentLinkSummary, "parentLinkType"> & {
  familyGroupMemberships?: Array<{ familyGroupId: string }> | null;
};

/**
 * MEMBER-FACING parent links: name and relationship always, the parent's EMAIL
 * ADDRESS only when the VIEWER shares a family group with that parent (#2424,
 * owner decision 2026-08-01).
 *
 * A parent link carries no shared-group requirement of its own — the admin link
 * route will record a parent who is in none of the child's groups — so the
 * member family payload was handing every viewer the address of people outside
 * their own family entirely. #2282 widened that further by allowing parentage at
 * any age, so the reachable set stopped being "other adults" and started
 * including children.
 *
 * The rule is enforced HERE, server-side, and never by a client choosing not to
 * render the field: the JSON is the leak, not the screen. The visible shape is
 * built by WHITELIST rather than by deleting `email` from a spread, so a field
 * added to the query later cannot leak by default.
 *
 * The withheld set is EMAIL PLUS THE STATUS FIELDS — `ageTier`, `active` and
 * `canLogin`. Those are facts about a person the viewer has no family
 * relationship with, and `ageTier` in particular says whether a named stranger
 * is a child, which is the same disclosure this issue exists to stop. No
 * member-facing client reads any of the three: the family page renders a parent
 * as name plus the notifications marker
 * (`src/app/(authenticated)/profile/family-group-section.tsx`), and the
 * onboarding wizard does not read parent links at all. So an out-of-group
 * parent yields exactly `id`, `firstName`, `lastName`, `parentLinkType` and
 * `inheritEmailFromId` — the last stays because the notifications marker is
 * matched on it, and an id pointing at a mailbox owner is not itself a contact
 * detail.
 *
 * The viewer's own groups are the yardstick, not the subject member's: the
 * subject is by construction someone the viewer already shares a group with, and
 * it is the parent hanging off them who may not be.
 */
export function buildMemberFacingParentLinks(
  member: {
    parent?: ParentLinkWithGroups | null;
    secondaryParent?: ParentLinkWithGroups | null;
  },
  viewerFamilyGroupIds: Iterable<string>,
): MemberFacingParentLink[] {
  const viewerGroupIds = new Set(viewerFamilyGroupIds);
  const groupIdsByParentId = new Map<string, string[]>();
  for (const parent of [member.parent, member.secondaryParent]) {
    if (!parent) continue;
    groupIdsByParentId.set(
      parent.id,
      (parent.familyGroupMemberships ?? []).map(
        (membership) => membership.familyGroupId,
      ),
    );
  }

  return buildParentLinks(member).map((link) => {
    const visible: MemberFacingParentLink = {
      id: link.id,
      firstName: link.firstName,
      lastName: link.lastName,
      parentLinkType: link.parentLinkType,
    };
    if (link.inheritEmailFromId !== undefined) {
      visible.inheritEmailFromId = link.inheritEmailFromId;
    }

    const sharesFamilyGroupWithViewer = (
      groupIdsByParentId.get(link.id) ?? []
    ).some((groupId) => viewerGroupIds.has(groupId));
    if (sharesFamilyGroupWithViewer) {
      visible.email = link.email;
      if (link.ageTier !== undefined) visible.ageTier = link.ageTier;
      if (link.active !== undefined) visible.active = link.active;
      if (link.canLogin !== undefined) visible.canLogin = link.canLogin;
    }
    return visible;
  });
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
