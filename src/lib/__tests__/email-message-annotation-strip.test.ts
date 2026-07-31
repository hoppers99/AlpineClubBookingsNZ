import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATE_DEFINITIONS } from "@/lib/email-message-registry";
import {
  findBracketAnnotations,
  findShippedAnnotations,
  SHIPPED_ANNOTATIONS,
  SHIPPED_ANNOTATION_PATTERN,
  SHIPPED_ANNOTATION_STRIP_PATTERNS,
  stripShippedAnnotations,
} from "@/lib/email-message-token-contract";

/**
 * #2269 (F3) — the strip that heals clubs whose SAVED override still carries
 * the "[only when …]" authoring notes this project used to ship inside its
 * default bodies, and the audit trail that records what we changed.
 *
 * Three things have to be true and none of them is provable by testing the
 * TypeScript alone:
 *
 *   1. the transformation is right on bodies that look like real ones — both
 *      what it removes and, far more importantly, what it must NOT touch;
 *   2. the migration that runs in production does the SAME transformation;
 *   3. the migration writes the audit entry the issue's acceptance criterion is
 *      actually about, one per row it really changed.
 *
 * (2) and (3) are why this file reads the migration SQL off disk. The strip
 * assertions lift the regex patterns OUT of it and run the corpus through
 * those; the audit assertions read the INSERT itself, because deleting the
 * whole audit half of the migration used to leave every test in this file
 * passing.
 */

const MIGRATION_SQL_PATH = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260801150000_strip_email_override_bracket_annotations",
  "migration.sql",
);

const migrationSql = readFileSync(MIGRATION_SQL_PATH, "utf8");

/** The dollar-quoted alternation the migration's "annotation" CTE holds. */
function sqlAnnotationPattern(): string {
  const match = migrationSql.match(/\$ann\$([\s\S]*?)\$ann\$/);
  if (!match) throw new Error("migration.sql has no $ann$…$ann$ alternation");
  return match[1];
}

/**
 * The six pass patterns the migration's "patterns" CTE builds, rebuilt exactly
 * as PostgreSQL would: each is a chain of single-quoted literals and
 * `annotation."span"` references concatenated with `||`.
 */
function sqlStripPatternSequence(): string[] {
  const cte = migrationSql.slice(
    migrationSql.indexOf("patterns AS ("),
    migrationSql.indexOf("targets AS ("),
  );
  const span = sqlAnnotationPattern();
  return Array.from(cte.matchAll(/^\s{4}(.+?) AS "pass\d"/gm), (match) =>
    match[1]
      .split("||")
      .map((piece) => piece.trim())
      .map((piece) => {
        if (piece === 'annotation."span"') return span;
        const literal = piece.match(/^'([^']*)'$/);
        if (!literal) {
          throw new Error(`unexpected pass expression fragment: ${piece}`);
        }
        return literal[1];
      })
      .join(""),
  );
}

/** Run a value through the patterns lifted out of the migration SQL. */
function stripUsingMigrationSql(value: string): string {
  return sqlStripPatternSequence().reduce(
    (current, pattern) => current.replace(new RegExp(pattern, "g"), ""),
    value,
  );
}

// Bodies a club could actually be holding. Every "before" that carries an
// annotation carries a VERBATIM shipped one (recovered from the history of
// email-message-audit-defaults.ts), because that is exactly what the editor
// pre-filled the textarea with and what a club saved.
const CORPUS: Array<{
  name: string;
  before: string;
  after: string;
}> = [
  {
    name: "booking-confirmed, with the club's own greeting and closing line kept",
    before: [
      "Booking Confirmed",
      "",
      "Kia ora {{firstName}}, your hut booking is locked in!",
      "",
      "Check-in: {{checkIn}}",
      "Guests: {{guestCount}}",
      "Subtotal: {{subtotal}}                  [only when discountCents > 0]",
      "Discount ({{promoCode}}): -{{discount}} [only when promoCode exists]",
      "Discount: -{{discount}}                 [only when discount exists without promoCode]",
      "Total Paid: {{totalPaid}}",
      "",
      "{{provisionalGuestsNote}} [only when non-member guests are held provisionally as a split linked booking]",
      "",
      "Door code: {{doorCode}} [only when a door code is set]",
      "",
      "Remember to sign the hut book on arrival.",
    ].join("\n"),
    after: [
      "Booking Confirmed",
      "",
      "Kia ora {{firstName}}, your hut booking is locked in!",
      "",
      "Check-in: {{checkIn}}",
      "Guests: {{guestCount}}",
      "Subtotal: {{subtotal}}",
      "Discount ({{promoCode}}): -{{discount}}",
      "Discount: -{{discount}}",
      "Total Paid: {{totalPaid}}",
      "",
      "{{provisionalGuestsNote}}",
      "",
      "Door code: {{doorCode}}",
      "",
      "Remember to sign the hut book on arrival.",
    ].join("\n"),
  },
  {
    name: "booking-modified, column-padded annotations from both families",
    before: [
      "Previous Dates: {{oldCheckIn}} – {{oldCheckOut}} [only when dates changed]",
      "Dates: {{newCheckIn}} – {{newCheckOut}}           [when dates did not change]",
      "Previous Guests: {{oldGuestCount}}                [only when guest count changed]",
      "Guests: {{newGuestCount}}                         [when guest count did not change]",
      "Total: {{newTotal}}                               [when total did not change]",
      "Change Fee: {{changeFee}}                         [only when changeFeeCents > 0]",
    ].join("\n"),
    after: [
      "Previous Dates: {{oldCheckIn}} – {{oldCheckOut}}",
      "Dates: {{newCheckIn}} – {{newCheckOut}}",
      "Previous Guests: {{oldGuestCount}}",
      "Guests: {{newGuestCount}}",
      "Total: {{newTotal}}",
      "Change Fee: {{changeFee}}",
    ].join("\n"),
  },
  {
    name: "school attendee confirmation, quotes and apostrophes inside the note",
    before:
      "Hi {{firstName}}, {{schoolName}}'s stay is coming up. Please tell us who is coming. [falls back to \"your school group's stay\" when no school name is recorded]\n\nConfirm Attendees: {{BASE_URL}}/school-bookings/confirm/{{token}}",
    after:
      "Hi {{firstName}}, {{schoolName}}'s stay is coming up. Please tell us who is coming.\n\nConfirm Attendees: {{BASE_URL}}/school-bookings/confirm/{{token}}",
  },
  {
    name: "a heading annotation, which only ever appeared in a subject",
    before:
      'Confirm Your Attendee List [heading becomes "Reminder: Confirm Your Attendee List" on reminders]',
    after: "Confirm Your Attendee List",
  },
  {
    name: "two annotations on one line, one of them embedding a token",
    before:
      "The duplicate charge was refunded in full. [when the automatic refund could not complete inline: the refund could not complete and a durable recovery operation is queued — the payment recovery cron will retry it with backoff; watch the recovery queue and confirm the refund lands. Failure detail: {{errorMessage}}]\n\nAmount refunded: {{amount}} [only when provided] today.",
    after:
      "The duplicate charge was refunded in full.\n\nAmount refunded: {{amount}} today.",
  },
  {
    name: "an annotation on the first line, on a line of its own, and at the start of a line with content after it",
    before: [
      "[only when localUrl exists]",
      "Repeated Xero Failures",
      "  [only when xeroObjectUrl exists]",
      "Open local record [only when localUrl exists]",
      "[only when xeroObjectUrl exists] Open Xero object",
    ].join("\n"),
    after: ["Repeated Xero Failures", "Open local record", "Open Xero object"].join(
      "\n",
    ),
  },
  {
    name: "a whole-line annotation between two blank lines takes one blank with it",
    // Otherwise the club's paragraph break becomes two blank lines in the
    // delivered email, which is a visible change to their layout.
    before: "Para one.\n\n[only when provided]\n\nPara two.",
    after: "Para one.\n\nPara two.",
  },
  {
    name: "a run of whole-line annotations between two blank lines",
    before:
      "Para one.\n\n[only when provided]\n[only when reason exists]\n\nPara two.",
    after: "Para one.\n\nPara two.",
  },
  {
    name: "a whole-line annotation at the very start, followed by a blank line",
    before: "[only when provided]\n\nHi {{firstName}}.",
    after: "Hi {{firstName}}.",
  },
  {
    name: "no brackets at all — must come back byte-identical",
    before: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
    after: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
  },
  {
    name: "club-authored brackets only — deliberate wording, never touched",
    before:
      "Hi {{guestName}},\n\nYour chores [see the noticeboard in the drying room] are below.\n\nBring your own [sleeping bag and pillowcase].",
    after:
      "Hi {{guestName}},\n\nYour chores [see the noticeboard in the drying room] are below.\n\nBring your own [sleeping bag and pillowcase].",
  },
  {
    name: "a shipped annotation and a club-authored bracket on the same row",
    before:
      "Expected arrival: {{expectedArrivalTime}} [only when provided]\n\nBring your own [sleeping bag and pillowcase].",
    after:
      "Expected arrival: {{expectedArrivalTime}}\n\nBring your own [sleeping bag and pillowcase].",
  },
];

/**
 * The reason this migration matches exact strings rather than a prefix family.
 * Every line below is club prose a prefix rule deleted when three reviewers
 * ran it, and the third one survives a word-boundary fix as well, because it
 * genuinely has the same shape as a shipped note. None of it may be touched.
 */
const CLUB_PROSE_THAT_MUST_SURVIVE: string[] = [
  "Ring the bell [whenever you arrive after 8pm].",
  "Ngā mihi — the hut sits on [whenua administered by the rūnanga] so tread lightly.",
  "Ring the warden [whenever you are running late] and let us know.",
  "Ring the lodge [when you are 30 minutes away].",
  "Refunds [only when the committee agrees] are at our discretion.",
  "Chores are listed [see the noticeboard] in the drying room.",
  // An unterminated opener: we cannot know where the club meant it to end, so
  // it is left entirely alone rather than run on to the next bracket.
  "Sorry {{firstName}} [only when a refund is due\nWe review each case.\n[reviews these weekly]\nRegards, the club.",
  // Whitespace reflowed inside a shipped note: deliberately NOT healed. It
  // keeps showing up in #2320's bracket banner for a person to decide about.
  "Door code: {{doorCode}} [only  when a door code is set]",
  "Door code: {{doorCode}} [Only when a door code is set]",
];

describe("#2269 shipped-annotation strip", () => {
  it.each(CORPUS)("strips $name", ({ before, after }) => {
    expect(stripShippedAnnotations(before)).toBe(after);
  });

  it.each(CORPUS)(
    "produces the same result from the MIGRATION SQL for $name",
    ({ before, after }) => {
      // The patterns here come out of prisma/migrations/**/migration.sql, not
      // out of the TypeScript, so this is a statement about what production
      // will actually run.
      expect(stripUsingMigrationSql(before)).toBe(after);
    },
  );

  it.each(CLUB_PROSE_THAT_MUST_SURVIVE.map((value) => ({ value })))(
    "never touches club prose: $value",
    ({ value }) => {
      expect(stripShippedAnnotations(value)).toBe(value);
      expect(stripUsingMigrationSql(value)).toBe(value);
      // And it is never even SELECTED by the migration, so no row is written
      // and no audit entry claims we changed something we did not.
      expect(findShippedAnnotations(value)).toEqual([]);
    },
  );

  it("matches only exact shipped strings, never a prefix family", () => {
    expect(SHIPPED_ANNOTATIONS).toHaveLength(38);
    for (const annotation of SHIPPED_ANNOTATIONS) {
      expect(annotation.startsWith("[")).toBe(true);
      expect(annotation.endsWith("]")).toBe(true);
      // One line, one span: no interior "]" and no newline, which is what makes
      // an unterminated opener unmatchable.
      expect(annotation.slice(1, -1)).not.toContain("]");
      expect(annotation).not.toContain("\n");
    }
    // No entry may be a prefix of another, or JavaScript's leftmost-first
    // alternation and PostgreSQL's longest-match preference could disagree.
    for (const left of SHIPPED_ANNOTATIONS) {
      for (const right of SHIPPED_ANNOTATIONS) {
        if (left === right) continue;
        expect(right.startsWith(left)).toBe(false);
      }
    }
    // Every entry is matched by the built pattern, exactly and wholly.
    for (const annotation of SHIPPED_ANNOTATIONS) {
      expect(findShippedAnnotations(annotation)).toEqual([annotation]);
    }
  });

  it("uses exactly the TypeScript alternation and passes in the migration SQL", () => {
    expect(sqlAnnotationPattern()).toBe(SHIPPED_ANNOTATION_PATTERN);
    expect(sqlStripPatternSequence()).toEqual([
      ...SHIPPED_ANNOTATION_STRIP_PATTERNS,
    ]);
  });

  it("applies every pass to the subject and the body alike, in order", () => {
    // A pass applied to one field and not the other would leave half a row
    // healed, and re-ordering them silently changes the result.
    const applications = Array.from(
      migrationSql.matchAll(
        /regexp_replace\((?:targets|pass\d)\."(\w+)", patterns\."(pass\d)", '', 'g'\)/g,
      ),
      (match) => `${match[2]}:${match[1]}`,
    );
    expect(applications).toEqual([
      "pass1:subject",
      "pass1:bodyText",
      "pass2:newSubject",
      "pass2:newBody",
      "pass3:newSubject",
      "pass3:newBody",
      "pass4:newSubject",
      "pass4:newBody",
      "pass5:newSubject",
      "pass5:newBody",
      "pass6:newSubject",
      "pass6:newBody",
    ]);
  });

  it.each(CORPUS)("is idempotent for $name", ({ before }) => {
    const once = stripShippedAnnotations(before);
    const twice = stripShippedAnnotations(once);
    expect(twice).toBe(once);
    // The stronger statement: nothing the strip targets survives it, which is
    // what makes a re-run select no rows and write no second audit entry.
    expect(findShippedAnnotations(once)).toEqual([]);
  });

  it.each(CORPUS)(
    "never leaves trailing whitespace behind for $name",
    ({ before }) => {
      const stripped = stripShippedAnnotations(before);
      const offending = stripped
        .split("\n")
        .filter((line, index) => {
          if (!/[ \t]$/.test(line)) return false;
          // Only whitespace the strip CREATED counts; a club may have saved a
          // trailing space of its own and we do not touch it.
          return !/[ \t]$/.test(before.split("\n")[index] ?? "");
        });
      expect(offending).toEqual([]);
    },
  );

  it.each(CORPUS)("never grows a run of blank lines for $name", ({ before }) => {
    const stripped = stripShippedAnnotations(before);
    const runs = (value: string) => (value.match(/\n{3,}/g) ?? []).length;
    expect(runs(stripped)).toBeLessThanOrEqual(runs(before));
  });

  it("changes nothing at all when there is nothing to strip", () => {
    // The identity property is what lets the migration write an audit row only
    // for rows it genuinely changed: no identity, no honest audit trail.
    for (const { before, after } of CORPUS) {
      if (findShippedAnnotations(before).length > 0) continue;
      expect(after).toBe(before);
      expect(stripShippedAnnotations(before)).toBe(before);
    }
  });

  it("reports exactly the annotations it removes", () => {
    const before = CORPUS[0].before;
    expect(findShippedAnnotations(before)).toEqual([
      "[only when discountCents > 0]",
      "[only when promoCode exists]",
      "[only when discount exists without promoCode]",
      "[only when non-member guests are held provisionally as a split linked booking]",
      "[only when a door code is set]",
    ]);
  });

  it("leaves club-authored brackets for #2320's banner rather than deleting them", () => {
    const clubText =
      "Your chores [see the noticeboard] are below. [only when chores exist]";
    const stripped = stripShippedAnnotations(clubText);
    expect(stripped).toBe("Your chores [see the noticeboard] are below.");
    // Guard 1 (#2320) still flags what is left, so the admin decides.
    expect(
      findBracketAnnotations({
        "chore-roster": { defaultSubject: "", defaultBody: stripped },
      }),
    ).toEqual([
      {
        key: "chore-roster",
        field: "defaultBody",
        detail: "[see the noticeboard]",
      },
    ]);
  });

  it("is a no-op on every current shipped default", () => {
    // #2267 and #2268 removed the annotations from the code defaults. If one
    // ever comes back, the migration would silently start rewriting overrides
    // that copied it — so pin the two halves together here.
    for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
      expect(stripShippedAnnotations(definition.defaultSubject)).toBe(
        definition.defaultSubject,
      );
      expect(stripShippedAnnotations(definition.defaultBody)).toBe(
        definition.defaultBody,
      );
    }
  });

  it("selects candidate rows by the same alternation it strips with", () => {
    // If the row filter drifted from the strip, a row could be selected and not
    // changed (a false audit row) or changed and not listed.
    const detection = Array.from(
      migrationSql.matchAll(/~ annotation\."span"/g),
    );
    expect(detection).toHaveLength(2); // subject and bodyText
    expect(migrationSql).toContain(
      `WHERE COALESCE(override."subject", '') ~ annotation."span"`,
    );
    expect(migrationSql).toContain(
      `OR COALESCE(override."bodyText", '') ~ annotation."span"`,
    );
  });
});

/**
 * The audit half of the acceptance criterion: "a per-mutated-row audit entry so
 * a club can see what we changed". None of it was covered before the #2269
 * review — the whole `audited` CTE could be deleted and every test above still
 * passed. These assertions are textual because the statement cannot be executed
 * without a PostgreSQL server, and they are deliberately specific enough that
 * deleting or weakening the INSERT fails them.
 */
describe("#2269 migration audit trail", () => {
  const auditInsert = migrationSql.slice(
    migrationSql.indexOf('INSERT INTO "AuditLog"'),
  );

  it("writes an AuditLog row at all", () => {
    expect(migrationSql).toContain('INSERT INTO "AuditLog"');
  });

  it("names every column it writes, including createdAt", () => {
    const columns = Array.from(
      auditInsert
        .slice(auditInsert.indexOf("("), auditInsert.indexOf(")"))
        .matchAll(/"(\w+)"/g),
      (match) => match[1],
    );
    expect(columns).toEqual([
      "id",
      "action",
      "targetId",
      "entityType",
      "entityId",
      "category",
      "severity",
      "outcome",
      "summary",
      "metadata",
      "retentionClass",
      "expiresAt",
      // #1627/#1656 class: left unnamed, "createdAt" takes the column default
      // CURRENT_TIMESTAMP, which writes the SESSION's local wall clock into a
      // naive column — 12 hours out on a Pacific/Auckland session.
      "createdAt",
    ]);
  });

  it("writes one row per row the UPDATE actually changed, and no other", () => {
    // The audit must be driven BY the update, not run beside it: an INSERT in a
    // parallel CTE cannot know whether the UPDATE hit the row, and produced an
    // audit entry for a template a concurrent Restore Default had just deleted.
    expect(migrationSql).toContain("RETURNING changed.*");
    expect(auditInsert).toContain("FROM updated");
    expect(auditInsert).not.toContain("FROM changed");
    // And the UPDATE only writes a row still holding what the strip was
    // computed from, so a concurrent admin save is never clobbered.
    expect(migrationSql).toContain(
      `AND override."subject" IS NOT DISTINCT FROM changed."oldSubject"`,
    );
    expect(migrationSql).toContain(
      `AND override."bodyText" IS NOT DISTINCT FROM changed."oldBody"`,
    );
  });

  it("records the whole previous row and the whole new content", () => {
    // This is what makes the change recoverable by a club that disagrees with
    // it, which is the entire point of auditing a silent content rewrite.
    for (const fragment of [
      `'previousOverride', jsonb_build_object(`,
      `'subject', updated."oldSubject"`,
      `'bodyText', updated."oldBody"`,
      `'newOverride', jsonb_build_object(`,
      `'subject', updated."newSubject"`,
      `'bodyText', updated."newBody"`,
      // Matches the EMAIL_TEMPLATE_OVERRIDE_UPDATED metadata the save route
      // writes, which carries updatedByMemberId on both sides.
      `'updatedByMemberId', updated."updatedByMemberId"`,
      `'source', 'migration:20260801150000_strip_email_override_bracket_annotations'`,
      `'issue', 2269`,
    ]) {
      expect(auditInsert).toContain(fragment);
    }
  });

  it("lists the removed annotations per field, never across a concatenation", () => {
    // subject || E'\n' || body invents spans that straddle the join: a subject
    // ending "Trailing opener [only when" and a body starting "x]" produced a
    // phantom entry naming an annotation that was never removed.
    expect(auditInsert).toContain("'removedAnnotations'");
    expect(auditInsert).toContain(
      `FROM (VALUES (1, updated."oldSubject"), (2, updated."oldBody"))`,
    );
    expect(auditInsert).toContain(
      `jsonb_agg(match."annotation"[1] ORDER BY field."rank", match."position")`,
    );
    expect(auditInsert).not.toMatch(/oldSubject"\s*\|\|/);
  });

  it("keeps the retention and action constants the app's audit builder uses", () => {
    expect(auditInsert).toContain("'EMAIL_TEMPLATE_OVERRIDE_UPDATED'");
    expect(auditInsert).toContain("'EmailTemplateOverride'");
    expect(auditInsert).toContain("'admin'");
    expect(auditInsert).toContain("'important'");
    expect(auditInsert).toContain("'success'");
    expect(auditInsert).toContain("'critical'");
    expect(auditInsert).toContain(
      `timezone('UTC', statement_timestamp()) + interval '7 years'`,
    );
  });

  it("never writes a session-local clock", () => {
    // Every timestamp this statement writes is explicitly UTC. A bare now() /
    // CURRENT_TIMESTAMP / LOCALTIMESTAMP would take the session's zone.
    const timestampWrites = Array.from(
      migrationSql
        .slice(migrationSql.indexOf("WITH annotation AS ("))
        .matchAll(/\b(now\(\)|CURRENT_TIMESTAMP|LOCALTIMESTAMP|clock_timestamp\(\))/gi),
    );
    expect(timestampWrites).toEqual([]);
    expect(migrationSql).toContain(`timezone('UTC', statement_timestamp())`);
  });

  it("renders metadata timestamps as ISO instants with a Z", () => {
    // jsonb_build_object on a naive timestamp emits "2026-01-01T00:00:00",
    // which JavaScript parses as LOCAL time; the app's sanitizer writes
    // toISOString().
    for (const field of ["createdAt", "updatedAt"]) {
      expect(auditInsert).toContain(
        `'${field}', to_char(updated."${field}", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      );
    }
  });

  it("normalises an emptied value to NULL rather than an empty string", () => {
    // '' is a state the app never stores, and #2269's own staleContent would
    // report it as "your saved copy differs" and diff the whole default.
    expect(migrationSql).toContain(`btrim(pass6."newSubject", E' \\t\\r\\n') = ''`);
    expect(migrationSql).toContain(`btrim(pass6."newBody", E' \\t\\r\\n') = ''`);
  });
});
