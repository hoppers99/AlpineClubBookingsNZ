import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  buildInheritanceLostEmail,
  INHERITANCE_LOST_CONTACT_EMAIL_DOMAIN,
  isInheritanceLostEmail,
  isPlaceholderContactEmail,
  PLACEHOLDER_CONTACT_EMAIL_DOMAINS,
} from "@/lib/placeholder-contact-email";

type InheritanceValidationResult =
  | { ok: true }
  | { ok: false; status: 404 | 422; error: string };

type EmailInheritanceClient = Prisma.TransactionClient | typeof prisma;

/**
 * ONE HOP (#2716, owner decision on #2708, 9 Aug 2026).
 *
 * A member with no address of their own inherits from a **parent** and from
 * nobody else. Inheritance used to be TRANSITIVE — a child could inherit from a
 * grandparent through a parent who also had no address, up to the
 * four-generation link cap — and that is retired. The depth cap itself stays; it
 * governs the family TREE, not the address hop.
 *
 * The reasoning the owner gave: an address that travels an arbitrary number of
 * hops is unpredictable to the person whose address it is. A grandparent who
 * supplies an email for one grandchild does not thereby expect notifications for
 * a branch of the family they may have no involvement with. One hop is
 * explainable to a member in a sentence; three is not.
 *
 * The cost is real and was accepted: where a middle generation has no address,
 * the descendant now inherits NOBODY and the club has to ask for one. That is
 * the correct failure direction — a gap somebody can see beats a message going
 * somewhere nobody chose — but only because the gap is VISIBLE. See
 * {@link unreachableMemberWhere}, which the admin surfaces query.
 *
 * The second half of the same decision is that pointers **re-resolve
 * automatically** when an address is added, changed or removed. The two compose,
 * and the order is load-bearing: narrowing to one hop is what makes prompt-free
 * re-resolution safe, because re-resolution is now a direct parent-to-child
 * lookup rather than a walk up a tree, with nothing for a human to arbitrate. A
 * confirm-each-re-point variant was offered to the owner and declined — a queue
 * of pending confirmations is a slower version of the defect it would replace.
 */

/**
 * The two columns, and why there are two.
 *
 * `Member.inheritEmailChoiceId` is WHO WAS CHOSEN: a direct parent for a derived
 * pointer, the adult an admin named for a hand-picked one. It records a
 * decision and outlives any particular address.
 *
 * `Member.inheritEmailFromId` is WHO ACTUALLY RECEIVES THE MAIL, and is never
 * written by hand: it is {@link effectiveEmailSourceId} of the choice, and
 * nothing else. Keeping them apart is what makes "re-resolve when an address is
 * ADDED" possible at all — collapsing them would mean a removed address erased
 * the record of who was chosen, so the pointer could never come back when the
 * address did, and a member would sit unreachable until somebody noticed by
 * hand.
 */
export const EMAIL_SOURCE_SELECT = {
  id: true,
  ageTier: true,
  email: true,
  archivedAt: true,
  cancelledAt: true,
  inheritEmailFromId: true,
  inheritEmailChoiceId: true,
} as const satisfies Prisma.MemberSelect;

export type EmailSourceRow = {
  id: string;
  ageTier: string;
  email: string;
  archivedAt: Date | null;
  /**
   * OPTIONAL in the type, always selected in practice. A caller that hands over
   * a row without it gets the benefit of the doubt rather than a silent refusal,
   * because unlike the other clauses this one guards a state no writer can
   * currently produce a live pointer in (see {@link isUsableEmailSource}).
   */
  cancelledAt?: Date | null;
  inheritEmailFromId: string | null;
  inheritEmailChoiceId: string | null;
};

/**
 * A member who can actually receive somebody else's notifications.
 *
 * ADULT, not archived, not cancelled, holding a real address rather than a
 * club-internal placeholder — a walk-in's `@no-email.invalid` (#1935, silently
 * dropped by `sendEmail`) or a deletion-anonymised `@deleted.invalid` (which
 * hard-bounces) — and not themselves inheriting.
 *
 * The adult clause is deliberate and survives #2282 ("parentage may be recorded
 * at any age"): recording that a 16-year-old is a parent is a fact about the
 * family, whereas being the club's contact of record for someone else is a
 * responsibility function, and those stay adult-gated.
 *
 * CANCELLED is here and `active` is NOT, and the line between them is a
 * judgement worth recording. Cancellation means the member has left the club, so
 * they should not be receiving another member's notifications — and the
 * cancellation sweep already clears every pointer and choice naming them, so
 * this clause only ever has to stop a NEW one being written. `active: false` is
 * a reversible administrative toggle about membership standing, not a statement
 * about whether the person's mailbox reaches them; clearing a child's contact of
 * record because a parent's membership lapsed would be exactly the "family stops
 * hearing from the club without anyone noticing" failure this feature exists to
 * prevent. (Found while reviewing #2716: `archivedAt` was tested and
 * `cancelledAt` was not, which let a member who had left the club be hand-picked
 * as somebody's contact of record on the member edit page.)
 *
 * "Not themselves inheriting" tests BOTH columns, and the CHOICE column is the
 * one that makes convergence order-independent. A member whose chosen source has
 * gone unreachable holds a NULL pointer beside a live choice; if only the pointer
 * were tested they would read as a mailbox of their own, and their dependants
 * would be pointed at an address that is a stale copy of somebody else's. Testing
 * the choice means "has decided to inherit" disqualifies you whatever your
 * pointer currently says, so a sweep reaches the same fixed point whatever order
 * it visits members in.
 */
export function isUsableEmailSource(member: EmailSourceRow): boolean {
  return (
    member.ageTier === "ADULT" &&
    !member.archivedAt &&
    !member.cancelledAt &&
    !isPlaceholderContactEmail(member.email) &&
    member.inheritEmailFromId === null &&
    member.inheritEmailChoiceId === null
  );
}

/**
 * The SQL mirror of {@link isUsableEmailSource}, so a query and the predicate
 * cannot drift. Both `.invalid` domains come from
 * `PLACEHOLDER_CONTACT_EMAIL_DOMAINS` rather than being spelled out here:
 * listing one would let a picker offer a source the write route refuses, which
 * is the #2254 drift in miniature.
 */
export function usableEmailSourceWhere(): Prisma.MemberWhereInput[] {
  return [
    { ageTier: "ADULT" },
    { archivedAt: null },
    { cancelledAt: null },
    { inheritEmailFromId: null },
    { inheritEmailChoiceId: null },
    ...PLACEHOLDER_CONTACT_EMAIL_DOMAINS.map(
      (domain): Prisma.MemberWhereInput => ({
        NOT: { email: { endsWith: `@${domain}`, mode: "insensitive" } },
      }),
    ),
  ];
}

/** Everything {@link effectiveEmailSourceId} needs about the member itself. */
export const EMAIL_INHERITANCE_SUBJECT_SELECT = {
  id: true,
  inheritParentEmail: true,
  parentMemberId: true,
  secondaryParentId: true,
  inheritEmailChoiceId: true,
  inheritEmailFromId: true,
} as const satisfies Prisma.MemberSelect;

export type EmailInheritanceSubject = {
  id: string;
  inheritParentEmail: boolean;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  inheritEmailChoiceId: string | null;
  inheritEmailFromId: string | null;
};

/**
 * THE RULE, and the only place it is written down.
 *
 * `inheritEmailFromId` is a pure, total function of (this member's row, the
 * chosen member's row). Pure and total is not decoration: it is what makes the
 * re-resolution idempotent, so a sweep that fails halfway is repaired by running
 * it again rather than by hand, and what makes it safe to run automatically
 * without an admin confirming each re-point.
 *
 * Three ways to resolve to nobody, and each is a state an admin can be shown:
 *  - no choice was ever recorded — the member uses their own address;
 *  - the chosen member can no longer receive mail (archived, anonymised, aged
 *    into a placeholder address, or now inheriting themselves);
 *  - the choice names the member themselves, which no writer produces and which
 *    would make the pointer meaningless.
 *
 * WHERE THE ONE-HOP RULE IS ENFORCED, and why it is not enforced here. This
 * function judges DELIVERABILITY, not provenance. One hop is a constraint on
 * what may be RECORDED as a choice, and it is enforced at the three places a
 * choice comes into being: every writer resolves through
 * `resolveInheritedEmailSourceId`, which now answers "that parent or nobody";
 * the migration re-seats every existing transitive choice onto a direct parent;
 * and {@link adoptedEmailInheritanceChoiceId} below refuses to adopt an
 * unaccompanied pointer that is not a direct parent. After those, no transitive
 * choice can exist, so re-testing it here would buy nothing.
 *
 * It would also be actively WRONG to test it here, and the reason is worth
 * recording because it is not obvious: `Member.inheritParentEmail` carries
 * `@default(true)`, so it reads `true` for every member who was never a
 * dependant at all. A "derived pointers must name a direct parent" test gated on
 * that flag would fire on a family-group login cluster — adults who share one
 * login and are pointed at the holder by hand, none of whom is anyone's parent —
 * and quietly disconnect the whole cluster from its own mailbox on the next
 * sweep. The flag is sound as PROVENANCE where a writer has set it deliberately
 * (INV-LIFE-052, the unlink rule) and unsound as a universal test; this is the
 * line between the two.
 */
export function effectiveEmailSourceId(
  member: EmailInheritanceSubject,
  choice: EmailSourceRow | null,
): string | null {
  if (!member.inheritEmailChoiceId) return null;
  if (!choice || choice.id !== member.inheritEmailChoiceId) return null;
  if (choice.id === member.id) return null;
  return isUsableEmailSource(choice) ? choice.id : null;
}

/**
 * A pointer with no choice beside it: what to record as the choice, if anything.
 *
 * The state is not one this application's writers produce — they write both
 * columns together — but two things can produce it, and both matter. A DRAINING
 * OLD COLOUR knows only `inheritEmailFromId`, so anything it writes between
 * migrate and cutover arrives unaccompanied; and any future writer that forgets
 * the choice column would too.
 *
 * The answer refuses exactly one shape: an ANCESTOR-SHAPED pointer, meaning the
 * member has at least one parent link and the pointer names somebody who is not
 * one of them. That is the shape this issue exists to abolish, so an old
 * colour's transitive write is refused and the pointer clears; the retired
 * behaviour cannot re-enter through the back door while the old colour is still
 * serving. An old colour's ordinary one-hop write is preserved intact.
 *
 * WHY IT IS NOT SIMPLY "NAMES A DIRECT PARENT", which is what this function
 * tested when review found it. A member with NO parent links at all who holds a
 * pointer is not a transitive inheritance — they are a HAND-PICK: the admin
 * member-edit source, or a family-group login cluster, where adults sharing one
 * login are pointed at the holder by hand and none of them is anyone's parent.
 * The bare direct-parent test refused those, `convergeSubjects` then cleared the
 * pointer, and a whole login cluster lost its shared mailbox on the next sweep
 * with no choice recorded to bring it back.
 *
 * That is not a hypothetical: the sibling docblock on {@link
 * effectiveEmailSourceId} above names this exact failure as the reason one hop
 * is not tested THERE, and this function then reproduced it. The migration's own
 * fixtures preserve both shapes deliberately (its `EXISTS (SELECT 1 FROM
 * ancestry …)` clause refuses ancestors, not non-parents), so the rule here is
 * now the same rule the migration applies, which is what it should always have
 * been.
 *
 * Adoption is the ONLY circumstance in which reconciliation writes the choice
 * column. It repairs a state no decision produced; it never changes a decision
 * somebody made.
 */
export function adoptedEmailInheritanceChoiceId(
  member: EmailInheritanceSubject,
): string | null {
  if (member.inheritEmailChoiceId) return member.inheritEmailChoiceId;
  if (!member.inheritEmailFromId) return null;
  if (
    member.inheritEmailFromId === member.parentMemberId ||
    member.inheritEmailFromId === member.secondaryParentId
  ) {
    return member.inheritEmailFromId;
  }
  // No parent links at all: nothing about this pointer can be transitive,
  // because there is no middle generation for it to have reached through. It is
  // a hand-pick, and adopting it is what keeps a login cluster connected to its
  // own mailbox across the drain.
  if (!member.parentMemberId && !member.secondaryParentId) {
    return member.inheritEmailFromId;
  }
  return null;
}

export type EmailInheritanceReconciliation = {
  /** Members whose pointer was examined. */
  examined: number;
  /** Members whose pointer now names somebody it did not name before. */
  repointed: number;
  /** Members whose pointer was cleared because nobody chosen can receive mail. */
  cleared: number;
  /**
   * Members left with a recorded choice and no pointer — the accepted cost of
   * the one-hop rule, made countable so it can be logged and surfaced rather
   * than discovered.
   */
  unresolved: string[];
};

const EMPTY_RECONCILIATION: EmailInheritanceReconciliation = {
  examined: 0,
  repointed: 0,
  cleared: 0,
  unresolved: [],
};

function mergeReconciliations(
  a: EmailInheritanceReconciliation,
  b: EmailInheritanceReconciliation,
): EmailInheritanceReconciliation {
  return {
    examined: a.examined + b.examined,
    repointed: a.repointed + b.repointed,
    cleared: a.cleared + b.cleared,
    unresolved: [...a.unresolved, ...b.unresolved],
  };
}

/**
 * Converge one batch of members onto {@link effectiveEmailSourceId}.
 *
 * Writes ONLY `inheritEmailFromId`, and only where the value would change. Not
 * touching `inheritEmailChoiceId` is deliberate: the choice records a decision a
 * person made, and only an explicit action — a link, an unlink, a hand-pick, or
 * the removal of the chosen member — may change it. A sweep that also rewrote
 * choices could quietly move a family's contact of record, which is the very
 * consent question this job must not answer by itself.
 */
async function convergeSubjects(
  db: EmailInheritanceClient,
  subjects: EmailInheritanceSubject[],
  /**
   * Skip a member whose row moved underneath us instead of throwing.
   *
   * TRUE ONLY FOR THE DAILY SWEEP, and the asymmetry is the point. The sweep
   * runs on the top-level client, so each update is its own implicit
   * transaction: a member merged or hard-deleted between the batch read and a
   * later write raises P2025 or P2003, and without this the throw escapes the
   * whole job and leaves every remaining batch unswept until tomorrow. Skipping
   * costs nothing, because the next run re-examines that member anyway.
   *
   * It stays FALSE for the in-transaction callers, where swallowing would be
   * wrong: those exist so a re-resolution commits with the address change or not
   * at all, and a caught error there would turn that guarantee into a best
   * effort silently.
   */
  options: { skipRowsThatMoved?: boolean } = {},
): Promise<EmailInheritanceReconciliation> {
  if (subjects.length === 0) return EMPTY_RECONCILIATION;

  // Adoption first, so the rest of the pass sees one shape: every subject either
  // has a choice or has nothing.
  const adopted = subjects.map((subject) => ({
    ...subject,
    inheritEmailChoiceId: adoptedEmailInheritanceChoiceId(subject),
  }));

  const choiceIds = Array.from(
    new Set(
      adopted
        .map((subject) => subject.inheritEmailChoiceId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const choices =
    choiceIds.length === 0
      ? []
      : await db.member.findMany({
          where: { id: { in: choiceIds } },
          select: EMAIL_SOURCE_SELECT,
        });
  const choiceById = new Map(choices.map((row) => [row.id, row]));

  const result: EmailInheritanceReconciliation = {
    examined: subjects.length,
    repointed: 0,
    cleared: 0,
    unresolved: [],
  };

  for (let index = 0; index < subjects.length; index += 1) {
    const before = subjects[index]!;
    const subject = adopted[index]!;
    const choice = subject.inheritEmailChoiceId
      ? (choiceById.get(subject.inheritEmailChoiceId) ?? null)
      : null;
    const next = effectiveEmailSourceId(subject, choice);
    const choiceChanged =
      subject.inheritEmailChoiceId !== before.inheritEmailChoiceId;

    if (next === null && subject.inheritEmailChoiceId) {
      result.unresolved.push(subject.id);
    }
    if (next === before.inheritEmailFromId && !choiceChanged) continue;

    try {
      await db.member.update({
        where: { id: subject.id },
        data: {
          inheritEmailFromId: next,
          ...(choiceChanged
            ? { inheritEmailChoiceId: subject.inheritEmailChoiceId }
            : {}),
        },
      });
    } catch (error) {
      if (!options.skipRowsThatMoved) throw error;
      // The member was merged or deleted between this batch's read and now, or
      // the source it names was. Either way the row this pass computed no longer
      // exists as read, and the next run recomputes it from whatever is there.
      logger.warn(
        { err: error, memberId: subject.id },
        "email inheritance: skipped a member whose row moved during the sweep",
      );
      continue;
    }
    if (next === before.inheritEmailFromId) continue;
    if (next === null) {
      result.cleared += 1;
    } else {
      result.repointed += 1;
    }
  }

  return result;
}

/** Converge the named members' own pointers. */
export async function reconcileEmailInheritanceForMembers(
  db: EmailInheritanceClient,
  memberIds: string[],
): Promise<EmailInheritanceReconciliation> {
  const ids = Array.from(new Set(memberIds.filter(Boolean)));
  if (ids.length === 0) return EMPTY_RECONCILIATION;
  const subjects = await db.member.findMany({
    where: { id: { in: ids } },
    select: EMAIL_INHERITANCE_SUBJECT_SELECT,
  });
  return convergeSubjects(db, subjects);
}

/**
 * Converge everybody who depends on these members, after their address (or
 * anything else that decides whether they can receive mail) has changed.
 *
 * CALL THIS IN THE SAME TRANSACTION AS THE ADDRESS WRITE. It is cheap — one
 * indexed read plus an update per genuinely changed row — and doing it inside
 * the write's transaction is what makes it a guarantee rather than a best
 * effort: a rolled-back address change rolls the re-resolution back with it, and
 * a committed one cannot commit without it.
 *
 * The dependant set is matched on the CHOICE column and on the pointer column.
 * The choice column is the live relationship; the pointer column is there to
 * catch rows a draining old colour wrote (it knows only the pointer) and legacy
 * rows the backfill could not seat on a choice.
 *
 * ADD, CHANGE and REMOVE are all one case here, which is the point: the function
 * does not ask what happened, it recomputes what should be true. A REMOVED
 * address — the case most likely to be missed, and the one that leaves a pointer
 * naming a mailbox nobody reads — is handled by exactly the same call as an
 * added one.
 */
export async function reconcileEmailInheritanceAfterSourceChange(
  db: EmailInheritanceClient,
  sourceMemberIds: string[],
): Promise<EmailInheritanceReconciliation> {
  const ids = Array.from(new Set(sourceMemberIds.filter(Boolean)));
  if (ids.length === 0) return EMPTY_RECONCILIATION;

  const subjects = await db.member.findMany({
    where: {
      OR: [
        { inheritEmailChoiceId: { in: ids } },
        { inheritEmailFromId: { in: ids } },
        // A member who has recorded a choice but currently resolves to nobody
        // is exactly who an ADDED address must reach. Their choice already names
        // one of these members, so the first clause covers them — this clause
        // covers the other half of "add": a direct parent whose child recorded
        // the choice through the OTHER parent column is not caught by id alone.
        { inheritEmailChoiceId: { not: null }, parentMemberId: { in: ids } },
        { inheritEmailChoiceId: { not: null }, secondaryParentId: { in: ids } },
      ],
    },
    select: EMAIL_INHERITANCE_SUBJECT_SELECT,
  });
  return convergeSubjects(db, subjects);
}

/**
 * What almost every writer wants: converge these members' OWN pointers, then
 * everyone who depends on them.
 *
 * The order is not cosmetic. A member who has just started inheriting somebody
 * else's address stops being a usable source at that moment, so their own
 * pointer has to settle before their dependants are judged against it —
 * otherwise a child could be left pointing at a parent whose `email` column is
 * about to become a copy of a third member's mailbox.
 *
 * Call it inside the transaction that made the change: an address added, changed
 * or removed, an archive, a cancellation, an anonymisation, a member merge, an
 * age-tier change, a hand-picked source chosen or cleared.
 *
 * WHAT IS ACTUALLY WIRED, stated honestly because an earlier version of this
 * comment claimed the set was closed and it is not. Every address write, the
 * three departure sweeps, member merge, the dependant link and unlink routes,
 * the login-holder transfer and the admin member edit call it. Of the age-tier
 * writers only the admin member edit does; self-service profile, delegated
 * family details, both seasonal-assignment paths and the admin bulk update all
 * resolve an enforced tier without re-resolving, so a source who drops out of
 * ADULT there keeps live pointers until the daily sweep converges them (#2821).
 *
 * That residue is bounded rather than silent — `reconcileAllEmailInheritance`
 * runs at 06:45 and is a total function of the tree, so the worst case is a
 * pointer naming a no-longer-qualified adult for less than a day, and the
 * address it names is still that person's real mailbox rather than a stranger's.
 * It is written down here so the next reader does not infer a guarantee from a
 * list.
 */
export async function reconcileEmailInheritanceForMemberChange(
  db: EmailInheritanceClient,
  memberIds: string[],
): Promise<EmailInheritanceReconciliation> {
  const own = await reconcileEmailInheritanceForMembers(db, memberIds);
  const dependants = await reconcileEmailInheritanceAfterSourceChange(
    db,
    memberIds,
  );
  return mergeReconciliations(own, dependants);
}

/**
 * Retire the DENORMALISED COPY of a departing member's address from everyone who
 * inherited it (#2716, owner decision 13 Aug 2026).
 *
 * Call this from the sweeps that remove a member from the club — archive,
 * cancellation, anonymisation, hard delete — in the SAME transaction, alongside
 * the existing clear of `inheritEmailFromId` / `inheritEmailChoiceId`.
 *
 * WHY CLEARING THE POINTERS IS NOT ENOUGH, which is what review found. A
 * dependant's `email` column holds a copy of whoever they inherit from, so a
 * reader can resolve an address without a join. Clearing the pointers leaves
 * that copy behind, and `resolveEffectiveEmail` then falls straight through to
 * it: the club keeps sending the dependant's mail to the departed member's
 * mailbox, and because the copy is a perfectly ordinary deliverable address the
 * dependant never appears on the unreachable surface. After an ERASURE that is
 * squarely a privacy failure — the request rewrites the deleted member's own
 * row and leaves their real address sitting on every dependant.
 *
 * CALL IT BEFORE CLEARING THE POINTERS, not after. The set this may touch is
 * defined by who INHERITED from the departing member, and that is knowable only
 * while the pointers still say so. Running it afterwards would leave the address
 * as the only available key, which is not good enough: two members can hold the
 * same address without either inheriting it — a couple who were both entered by
 * hand, most obviously — and stamping a placeholder over a spouse's own address
 * because their partner left the club would be a worse bug than the one this
 * fixes.
 *
 * TWO CONDITIONS, BOTH REQUIRED. A member is retired only if they point at the
 * departing member (by pointer or by choice) AND their stored address is still
 * case-insensitively equal to the departing address. The first establishes that
 * the column holds a COPY rather than their own address; the second that it is
 * still that copy. A dependant who has since been given an address of their own
 * fails the second and is untouched. Nothing that was ever this member's own
 * address is destroyed.
 *
 * Idempotent: a second call finds no row satisfying both, because the first
 * replaced every address with a unique `.invalid` string.
 */
export async function retireInheritedEmailCopies(
  db: EmailInheritanceClient,
  departing: { id: string; email: string },
): Promise<{ retired: number }> {
  // The parameter is typed `string` and `Member.email` is NOT NULL, so a real
  // caller cannot reach here without an address — the compiler is the guard.
  // The coalesce is for narrow in-memory test doubles that select a subset of
  // columns: a missing address means there is nothing to retire, which is the
  // same answer as an empty one, and is better than throwing inside somebody
  // else's cancellation transaction.
  const address = (departing.email ?? "").trim();
  // A departing member whose own address is already a placeholder has no real
  // address to leave behind, so there is nothing to retire and stamping the
  // dependants would only trade one placeholder for another.
  if (!address || isPlaceholderContactEmail(address)) return { retired: 0 };

  const stale = await db.member.findMany({
    where: {
      id: { not: departing.id },
      OR: [
        { inheritEmailFromId: departing.id },
        { inheritEmailChoiceId: departing.id },
      ],
      email: { equals: address, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (stale.length === 0) return { retired: 0 };

  // One statement per member rather than an `updateMany`: each replacement must
  // be a DISTINCT address, for the same reason walk-in placeholders are unique.
  for (const member of stale) {
    await db.member.update({
      where: { id: member.id },
      data: { email: buildInheritanceLostEmail() },
    });
  }
  return { retired: stale.length };
}

/** How many members one sweep batch reads and writes. */
const RECONCILE_BATCH_SIZE = 500;

/**
 * Converge the WHOLE tree, in batches, and report what moved.
 *
 * This is the guaranteed follow-up behind every in-transaction call above, and
 * the answer to the hazard this feature has to be designed against: a
 * re-resolution that fires on the wrong event, or fails partway, would leave a
 * pointer naming somebody nobody chose — the original defect with extra steps.
 * Because the rule is a pure function of the tree, running this again always
 * moves the database closer to the fixed point and never away from it, so a
 * partial failure is repaired by re-running rather than by hand.
 *
 * Only members who have recorded a choice, or who still hold a pointer, are
 * examined. A member who never inherited is not a candidate for inheriting now,
 * so the sweep's cost tracks the size of the family graph and not the roll.
 */
export async function reconcileAllEmailInheritance(
  db: EmailInheritanceClient = prisma,
): Promise<EmailInheritanceReconciliation> {
  let result = EMPTY_RECONCILIATION;
  let cursor: string | undefined;

  for (;;) {
    const subjects = await db.member.findMany({
      where: {
        OR: [
          { inheritEmailChoiceId: { not: null } },
          { inheritEmailFromId: { not: null } },
        ],
      },
      select: EMAIL_INHERITANCE_SUBJECT_SELECT,
      orderBy: { id: "asc" },
      take: RECONCILE_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (subjects.length === 0) break;

    result = mergeReconciliations(
      result,
      // The only caller that passes this: the sweep is a backstop, so one
      // member whose row moved must not cost the rest of the tree its pass.
      await convergeSubjects(db, subjects, { skipRowsThatMoved: true }),
    );
    if (subjects.length < RECONCILE_BATCH_SIZE) break;
    cursor = subjects[subjects.length - 1]?.id;
    if (!cursor) break;
  }

  return result;
}

/**
 * Members the club currently has no way to reach — the admin-visible half of the
 * one-hop decision, and part of the deliverable rather than a nicety. Where a
 * middle generation has no address the descendant now inherits nobody, and that
 * is only the right failure direction if somebody can find those members.
 *
 * Two reasons, and the first is the sharper one:
 *
 *  - `inheritance-unresolved` — a choice is recorded and resolves to nobody. The
 *    club decided who should receive this member's mail and currently nobody
 *    does. This catches the case a placeholder-address test would MISS: a
 *    dependant's own `email` column is routinely a copy of the address they used
 *    to inherit, so after the pointer clears they look perfectly reachable while
 *    their mail goes to somebody else's mailbox.
 *  - `inheritance-lost` — the source DEPARTED (archived, cancelled, anonymised,
 *    hard-deleted) and took the choice with it. Review found the hole this
 *    closes: those sweeps clear both pointer columns, so the member matches
 *    neither reason above, while their `email` column still holds a copy of the
 *    departed member's real address. They looked reachable, were invisible here,
 *    and their mail kept arriving in the departed member's mailbox — worst of
 *    all after an ERASURE, which rewrites the deleted member's own row and
 *    leaves the copies. The sweeps now stamp
 *    {@link buildInheritanceLostEmail} over the stale copy, which both stops the
 *    misdelivery and lands the member here. It is reported separately from
 *    `placeholder-address` because "the arrangement they had broke" is a
 *    different job for an admin than "never had an address".
 *  - `placeholder-address` — no inheritance at all and their own address is a
 *    club-internal `.invalid` placeholder, which `sendEmail` drops or which
 *    hard-bounces.
 *
 * Scoped to people the club is supposed to be able to reach: active, not
 * archived, not cancelled, and not an organisation or school account. A walk-in
 * SCHOOL or NON_MEMBER contact with a placeholder address is not a fault to fix,
 * and listing them would bury the members who are.
 */
export type UnreachableMemberReason =
  | "inheritance-unresolved"
  | "inheritance-lost"
  | "placeholder-address";

export function unreachableMemberWhere(
  reason?: UnreachableMemberReason,
): Prisma.MemberWhereInput {
  const inheritanceLost: Prisma.MemberWhereInput = {
    email: {
      endsWith: `@${INHERITANCE_LOST_CONTACT_EMAIL_DOMAIN}`,
      mode: "insensitive" as const,
    },
  };
  // The OTHER placeholder domains. `inheritance-lost` is one of them for
  // deliverability — `sendEmail` and the Xero guards must drop it like any
  // other — but it is reported as its own reason, so listing it here as well
  // would double-count it in the unfiltered set.
  const placeholderAddress: Prisma.MemberWhereInput = {
    OR: PLACEHOLDER_CONTACT_EMAIL_DOMAINS.filter(
      (domain) => domain !== INHERITANCE_LOST_CONTACT_EMAIL_DOMAIN,
    ).map((domain) => ({
      email: { endsWith: `@${domain}`, mode: "insensitive" as const },
    })),
  };
  const unresolvedInheritance: Prisma.MemberWhereInput = {
    inheritEmailChoiceId: { not: null },
  };

  const reasons: Prisma.MemberWhereInput[] =
    reason === "inheritance-unresolved"
      ? [unresolvedInheritance]
      : reason === "inheritance-lost"
        ? [inheritanceLost]
        : reason === "placeholder-address"
          ? [placeholderAddress]
          : [unresolvedInheritance, inheritanceLost, placeholderAddress];

  return {
    // No effective source: whatever else is true, a member with a live pointer
    // is reachable at that mailbox.
    inheritEmailFromId: null,
    active: true,
    archivedAt: null,
    cancelledAt: null,
    role: { notIn: ["SCHOOL", "NON_MEMBER", "LODGE"] },
    OR: reasons,
  };
}

/** Which of the two reasons applies, given a row read with the fields above. */
export function unreachableMemberReason(member: {
  email: string;
  inheritEmailFromId: string | null;
  inheritEmailChoiceId: string | null;
}): UnreachableMemberReason | null {
  if (member.inheritEmailFromId) return null;
  if (member.inheritEmailChoiceId) return "inheritance-unresolved";
  // Checked BEFORE the general placeholder test, which would otherwise swallow
  // it: `inheritance-lost.invalid` is a placeholder domain too, and the more
  // specific reason is the one worth telling an admin.
  if (isInheritanceLostEmail(member.email)) return "inheritance-lost";
  if (isPlaceholderContactEmail(member.email)) return "placeholder-address";
  return null;
}

export const UNREACHABLE_MEMBER_REASON_LABEL: Record<
  UnreachableMemberReason,
  string
> = {
  "inheritance-unresolved":
    "Inherits a parent's email, but that parent has no address the club can send to",
  "inheritance-lost":
    "Lost the address they inherited when that member left the club, and has none of their own",
  "placeholder-address": "No email address on record",
};

/** How many unreachable members the dashboard names before it stops listing. */
const UNREACHABLE_MEMBER_DETAIL_LIMIT = 10;

export type UnreachableMemberSummary = {
  total: number;
  /** Of the total, how many are waiting on a chosen parent's address. */
  inheritanceUnresolved: number;
  members: Array<{
    id: string;
    name: string;
    reason: UnreachableMemberReason;
  }>;
};

/**
 * The admin dashboard's view of who the club cannot reach.
 *
 * Counts are exact; the named list is bounded, because the point of the
 * dashboard item is to say "this exists and here is where to fix it", and the
 * members list filter (`?contactability=unreachable`) is where the whole set
 * lives. Splitting the count by reason matters more than it looks: "waiting on
 * a parent's address" is a different job from "we never had an address", and an
 * admin who cannot tell them apart will work the wrong one first.
 */
export async function getUnreachableMemberSummary(
  db: EmailInheritanceClient = prisma,
): Promise<UnreachableMemberSummary> {
  const [total, inheritanceUnresolved, rows] = await Promise.all([
    db.member.count({ where: unreachableMemberWhere() }),
    db.member.count({
      where: unreachableMemberWhere("inheritance-unresolved"),
    }),
    db.member.findMany({
      where: unreachableMemberWhere(),
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        inheritEmailFromId: true,
        inheritEmailChoiceId: true,
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: UNREACHABLE_MEMBER_DETAIL_LIMIT,
    }),
  ]);

  return {
    total,
    inheritanceUnresolved,
    members: rows.map((row) => ({
      id: row.id,
      name: [row.firstName, row.lastName].filter(Boolean).join(" ").trim(),
      // `unreachableMemberWhere` and `unreachableMemberReason` are two
      // renderings of one rule, so a row it returned always has a reason; the
      // fallback exists because TypeScript cannot know that, and naming the
      // narrower reason is the honest default if they ever drift.
      reason: unreachableMemberReason(row) ?? "inheritance-unresolved",
    })),
  };
}

export async function validateInheritEmailSource(input: {
  inheritEmailFromId: string;
  memberId?: string;
  db?: EmailInheritanceClient;
}, dbOverride?: EmailInheritanceClient): Promise<InheritanceValidationResult> {
  const db = dbOverride ?? input.db ?? prisma;
  const inheritEmailFrom = await db.member.findUnique({
    where: { id: input.inheritEmailFromId },
    select: EMAIL_SOURCE_SELECT,
  });

  if (!inheritEmailFrom) {
    return {
      ok: false,
      status: 404,
      error: "Email inheritance member not found",
    };
  }

  if (input.memberId && inheritEmailFrom.id === input.memberId) {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance cannot point to the same member",
    };
  }

  if (inheritEmailFrom.ageTier !== "ADULT") {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance must point to an adult member",
    };
  }

  // #2255 (D9): the source may itself have parents. Family links run to four
  // generations, so a source is often a MIDDLE generation — an adult who is
  // someone's child and someone's parent at once. The old "must point to a
  // primary adult member" clause (source has no parents) made that source
  // unusable, and it stays retired under #2716: the one-hop rule is about how
  // far an ADDRESS travels, not about where in the tree the mailbox owner sits.
  //
  // #2716: the terminality test now reads the CHOICE column as well. A member
  // whose chosen source went unreachable holds a live choice beside a NULL
  // pointer; accepting them as a source would make a dependant inherit an
  // `email` column that is a stale copy of the very mailbox that just went away.
  if (inheritEmailFrom.inheritEmailFromId || inheritEmailFrom.inheritEmailChoiceId) {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance cannot chain through another inherited member",
    };
  }

  if (inheritEmailFrom.archivedAt) {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance cannot point to an archived member",
    };
  }

  // #2716 review: CANCELLED was not tested here, and archive was. The two are
  // separate states in this product — cancellation deactivates and de-logs a
  // member while leaving `archivedAt` null — so a member who had left the club
  // could still be hand-picked as somebody's contact of record on the member
  // edit page, which has no other lifecycle gate behind it. (The dependant-link
  // route was already safe: `dependentParentEligibleWhere` requires an active,
  // non-archived parent.) Existing pointers were never the exposure — the
  // cancellation sweep clears the pointer AND the choice in its own transaction
  // — so this closes the write, and `isUsableEmailSource` closes the read.
  if (inheritEmailFrom.cancelledAt) {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance cannot point to a member who has left the club",
    };
  }

  // #2255 (D9): with the "source has no parents" clause gone, the remaining
  // structural guards no longer imply a DELIVERABLE address, so check it
  // directly. A walk-in placeholder (`@no-email.invalid`, #1935) is silently
  // dropped by `sendEmail`, so inheriting one would leave the dependant with no
  // reachable contact at all while the admin UI showed an inheritance in place.
  if (isPlaceholderContactEmail(inheritEmailFrom.email)) {
    return {
      ok: false,
      status: 422,
      error:
        "Email inheritance must point to a member with a real email address",
    };
  }

  return { ok: true };
}
