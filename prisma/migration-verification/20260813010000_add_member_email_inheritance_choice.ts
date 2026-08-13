import type { DataMigrationVerification } from "./types";

/**
 * #2716 — email inheritance narrows to DIRECT-PARENT ONLY, and every existing
 * pointer is re-seated on the decision behind it.
 *
 * This migration decides which adult receives a minor's notifications, on live
 * club data, in one shot. `Migration drift check` applies it to an empty
 * database, where both `UPDATE`s match nothing and are proven only to parse. So
 * the cases below are families: the transitive chain the rule abolishes, the
 * one-hop pointers it must leave alone, and the two shapes that look like
 * transitive pointers and are not — a hand-picked source on a member who also
 * has parents, and a family-group login cluster whose adults are pointed at
 * their login holder by hand.
 *
 * Those last two are why the migration tests "the pointer names an ANCESTOR who
 * is not a direct parent" rather than the simpler "the pointer does not name a
 * parent". The simpler test passes the abolition case and quietly moves two
 * other families' contact of record, and it is the mutant this fixture exists
 * to catch.
 */

/**
 * One member row, as a pre-state a real club could hold. Written as a helper
 * because a Member row needs five NOT NULL columns that say nothing about this
 * feature, and repeating them per member would bury the three that matter.
 */
function member(input: {
  id: string;
  email: string;
  ageTier?: "ADULT" | "YOUTH";
  archivedAt?: string | null;
  parentMemberId?: string | null;
  secondaryParentId?: string | null;
  inheritParentEmail?: boolean;
  inheritEmailFromId?: string | null;
}): string {
  const quote = (value: string | null | undefined) =>
    value === null || value === undefined ? "NULL" : `'${value}'`;
  return `INSERT INTO "Member" (
      "id", "email", "passwordHash", "firstName", "lastName", "updatedAt",
      "ageTier", "archivedAt", "parentMemberId", "secondaryParentId",
      "inheritParentEmail", "inheritEmailFromId"
    ) VALUES (
      '${input.id}', '${input.email}', 'x', '${input.id}', 'Test',
      timezone('UTC', TIMESTAMP '2026-01-01 00:00:00'),
      '${input.ageTier ?? "ADULT"}'::"AgeTier",
      ${input.archivedAt ? `timezone('UTC', TIMESTAMP '${input.archivedAt}')` : "NULL"},
      ${quote(input.parentMemberId)},
      ${quote(input.secondaryParentId)},
      ${input.inheritParentEmail === false ? "false" : "true"},
      ${quote(input.inheritEmailFromId)}
    );`;
}

/** The columns every expectation reads, in one place so they cannot drift. */
const POINTER_QUERY = `SELECT "id", "inheritEmailChoiceId", "inheritEmailFromId", "inheritParentEmail"
   FROM "Member" WHERE "id" IN (%IDS%) ORDER BY "id"`;

const pointerQuery = (...ids: string[]) =>
  POINTER_QUERY.replace("%IDS%", ids.map((id) => `'${id}'`).join(", "));

const verification: DataMigrationVerification = {
  migration: "20260813010000_add_member_email_inheritance_choice",
  intent:
    "Record the CHOICE behind every existing email-inheritance pointer, re-seating a transitive pointer (one naming an ancestor who is not a direct parent) onto a direct parent; then derive the effective pointer from that choice, keeping it only while the chosen member can receive mail. Hand-picked sources and one-hop pointers are left exactly as they are.",
  // The migration adds a column and an index, so re-running the whole file
  // cannot be a no-op and is not claimed to be. The re-runnable half is the
  // application sweep (`reconcileAllEmailInheritance`), which is where recovery
  // from a partial failure actually comes from.
  idempotentReRun: false,
  cases: [
    {
      name: "four generations, the middle two with no address: the case the rule abolishes",
      seed: [
        // great-grandparent, the only real mailbox in the family
        member({ id: "g1-great", email: "great@example.test" }),
        // grandparent: no address of their own, inheriting ONE HOP from their
        // own parent — this pointer is already legal under the new rule
        member({
          id: "g1-grand",
          email: "walk-in-a@no-email.invalid",
          parentMemberId: "g1-great",
          inheritEmailFromId: "g1-great",
        }),
        // parent: no address, inheriting TWO hops up past the grandparent
        member({
          id: "g1-parent",
          email: "walk-in-b@no-email.invalid",
          parentMemberId: "g1-grand",
          inheritEmailFromId: "g1-great",
        }),
        // child: no address, inheriting THREE hops up
        member({
          id: "g1-child",
          email: "walk-in-c@no-email.invalid",
          ageTier: "YOUTH",
          parentMemberId: "g1-parent",
          inheritEmailFromId: "g1-great",
        }),
      ].join("\n"),
      expectations: [
        {
          claim:
            "the grandparent's pointer is ONE HOP and survives untouched, choice and pointer both naming the great-grandparent; the parent and the child are re-seated onto their own direct parents and resolve to NOBODY, because those parents have no address — the accepted cost, recorded rather than silently dropped, with the choice kept so the pointer restores itself if that parent ever gains an address",
          sql: pointerQuery("g1-child", "g1-grand", "g1-parent"),
          rows: [
            {
              id: "g1-child",
              inheritEmailChoiceId: "g1-parent",
              inheritEmailFromId: null,
              inheritParentEmail: true,
            },
            {
              id: "g1-grand",
              inheritEmailChoiceId: "g1-great",
              inheritEmailFromId: "g1-great",
              inheritParentEmail: true,
            },
            {
              id: "g1-parent",
              inheritEmailChoiceId: "g1-grand",
              inheritEmailFromId: null,
              inheritParentEmail: true,
            },
          ],
        },
      ],
    },
    {
      name: "a transitive pointer whose direct parent CAN receive mail",
      seed: [
        member({ id: "g2-grand", email: "grand@example.test" }),
        member({
          id: "g2-parent",
          email: "parent@example.test",
          parentMemberId: "g2-grand",
        }),
        // The pointer skipped the parent even though the parent has an address —
        // the shape the old walk produced when the parent's address arrived
        // after the link was made, and the shape nothing ever revisited.
        member({
          id: "g2-child",
          email: "parent@example.test",
          ageTier: "YOUTH",
          parentMemberId: "g2-parent",
          inheritEmailFromId: "g2-grand",
        }),
      ].join("\n"),
      expectations: [
        {
          claim:
            "the child's notifications move from the grandparent to the parent, which is the live defect this issue was filed about: a minor's mail was reaching an adult who is no longer the right one, indefinitely, and nobody found out",
          sql: pointerQuery("g2-child"),
          rows: [
            {
              id: "g2-child",
              inheritEmailChoiceId: "g2-parent",
              inheritEmailFromId: "g2-parent",
              inheritParentEmail: true,
            },
          ],
        },
      ],
    },
    {
      name: "a family-group login cluster: adults sharing one login, none of them anyone's parent",
      seed: [
        member({ id: "g3-holder", email: "shared@example.test" }),
        // No parent links at all, and `inheritParentEmail` left at its schema
        // DEFAULT of true — which is exactly why the migration cannot use that
        // flag on its own to decide what looks derived.
        member({
          id: "g3-partner",
          email: "shared@example.test",
          inheritEmailFromId: "g3-holder",
        }),
      ].join("\n"),
      expectations: [
        {
          claim:
            "the cluster keeps its mailbox: the partner has no parent links, so nothing about this pointer was ever derived from one and the one-hop rule has nothing to say about it",
          sql: pointerQuery("g3-partner"),
          rows: [
            {
              id: "g3-partner",
              inheritEmailChoiceId: "g3-holder",
              inheritEmailFromId: "g3-holder",
              inheritParentEmail: true,
            },
          ],
        },
      ],
    },
    {
      name: "a hand-picked source who is not in the family tree at all",
      seed: [
        member({ id: "g4-unrelated", email: "guardian@example.test" }),
        member({ id: "g4-parent", email: "parent4@example.test" }),
        // `inheritParentEmail` is left at its schema DEFAULT of true, which is
        // the hard version of this case and the realistic one: the admin
        // member-edit hand-pick writes the pointer without touching the
        // provenance flag, so a hand-picked source on a member who also has
        // parents is indistinguishable from a derived one by that flag alone.
        // Only the ancestry test can tell them apart.
        member({
          id: "g4-child",
          email: "walk-in-d@no-email.invalid",
          ageTier: "YOUTH",
          parentMemberId: "g4-parent",
          inheritEmailFromId: "g4-unrelated",
        }),
      ].join("\n"),
      expectations: [
        {
          claim:
            "an admin's explicit pick is left alone even though the child has a parent with a perfectly good address — the walk could never have landed on somebody outside the family, so this is a decision, not a resolution, and re-seating it would move a family's contact of record without being asked",
          sql: pointerQuery("g4-child"),
          rows: [
            {
              id: "g4-child",
              inheritEmailChoiceId: "g4-unrelated",
              inheritEmailFromId: "g4-unrelated",
              inheritParentEmail: true,
            },
          ],
        },
      ],
    },
    {
      name: "a parent who has a real address of their own but inherits somebody else's",
      seed: [
        member({ id: "g5-guardian", email: "guardian5@example.test" }),
        member({
          id: "g5-parent",
          email: "stale-copy@example.test",
          inheritParentEmail: false,
          inheritEmailFromId: "g5-guardian",
        }),
        member({
          id: "g5-child",
          email: "walk-in-e@no-email.invalid",
          ageTier: "YOUTH",
          parentMemberId: "g5-parent",
          inheritEmailFromId: "g5-parent",
        }),
      ].join("\n"),
      expectations: [
        {
          claim:
            "the child resolves to NOBODY rather than to the parent, because a member who inherits is not a mailbox: the parent's own email column is a stale copy of the guardian's address, and delivering a child's notifications to it would send them somewhere nobody chose while every screen showed an inheritance in place",
          sql: pointerQuery("g5-child"),
          rows: [
            {
              id: "g5-child",
              inheritEmailChoiceId: "g5-parent",
              inheritEmailFromId: null,
              inheritParentEmail: true,
            },
          ],
        },
      ],
    },
    {
      name: "a member with no inheritance at all",
      seed: member({ id: "g6-plain", email: "plain@example.test" }),
      expectations: [
        {
          claim:
            "a member the feature has never touched is not written by either statement — both WHERE clauses require an existing pointer, so the backfill's blast radius is the families that actually inherit",
          sql: pointerQuery("g6-plain"),
          rows: [
            {
              id: "g6-plain",
              inheritEmailChoiceId: null,
              inheritEmailFromId: null,
              inheritParentEmail: true,
            },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "drop the ancestry test, so any pointer that does not name a direct parent counts as transitive",
      harm: "Re-seats a hand-picked source onto a parent the admin did not choose. A club that had deliberately routed a child's notifications to a guardian outside the family would find them silently moved to a parent — the exact consent question this migration must not answer by itself.",
      find: `       AND EXISTS (
             SELECT 1 FROM ancestry a
              WHERE a.member_id = m."id"
                AND a.ancestor_id = m."inheritEmailFromId"
           )`,
      replace: "",
    },
    {
      name: "drop the fallback to the primary parent when neither parent can receive mail",
      harm: "Loses the record of who was chosen for exactly the members the one-hop rule strands. Their pointer would clear with no choice beside it, so the day that parent finally records an address nothing would bring the pointer back and the member would stay unreachable until somebody noticed by hand.",
      find: `        m."parentMemberId",
        m."secondaryParentId"
      )`,
      replace: `        NULL,
        NULL
      )`,
    },
    {
      name: "let a member who themselves inherits count as a usable source",
      harm: "Delivers a child's notifications to a parent's own `email` column while that parent is inheriting somebody else's address — so the column is a stale copy of a third person's mailbox. Mail goes somewhere nobody chose, and every admin screen shows a valid inheritance.",
      find: `        AND c."inheritEmailFromId" IS NULL`,
      replace: "",
    },
    {
      name: "record the existing transitive pointer as the choice instead of re-seating it on a parent",
      harm: "The transitive route survives the migration outright: every child keeps the grandparent the owner's decision removed, and the pointer is now blessed as a recorded choice so no later sweep will question it. The defect ships under a migration that claims to have fixed it.",
      find: `      THEN COALESCE(`,
      replace: `      THEN COALESCE(m."inheritEmailFromId", `,
    },
  ],
};

export default verification;
