import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATE_DEFINITIONS } from "@/lib/email-message-registry";
import {
  findBracketAnnotations,
  findShippedAnnotations,
  SHIPPED_ANNOTATION_PATTERN,
  SHIPPED_ANNOTATION_STRIP_PATTERNS,
  stripShippedAnnotations,
} from "@/lib/email-message-token-contract";

/**
 * #2269 (F3) — the strip that heals clubs whose SAVED override still carries
 * the "[only when …]" authoring notes this project used to ship inside its
 * default bodies.
 *
 * Two things have to be true and neither is provable by testing the TypeScript
 * alone:
 *
 *   1. the transformation is right on bodies that look like real ones, and
 *   2. the migration that runs in production does the SAME transformation.
 *
 * (2) is why this file reads the migration SQL off disk, lifts the regex
 * patterns OUT of it, and runs the corpus through those. A migration edited to
 * do something else fails here even though the TypeScript still passes.
 */

const MIGRATION_SQL_PATH = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260801150000_strip_email_override_bracket_annotations",
  "migration.sql",
);

const migrationSql = readFileSync(MIGRATION_SQL_PATH, "utf8");

/**
 * Every `regexp_replace(<value>, '<pattern>', '', 'g')` in the migration, in
 * file order. The migration applies the passes as a chain of CTEs and runs each
 * pass over the subject and over the body, so the patterns come out in pairs:
 * [p1, p1, p2, p2, p3, p3, p4, p4].
 */
function sqlStripPatterns(): string[] {
  return Array.from(
    migrationSql.matchAll(/'([^']*)',\s*'',\s*'g'\)/g),
    (match) => match[1],
  );
}

/** The migration's passes, de-paired, in application order. */
function sqlStripPatternSequence(): string[] {
  const patterns = sqlStripPatterns();
  const sequence: string[] = [];
  for (let index = 0; index < patterns.length; index += 2) {
    sequence.push(patterns[index]);
  }
  return sequence;
}

/** Run the corpus through the patterns lifted out of the migration SQL. */
function stripUsingMigrationSql(value: string): string {
  return sqlStripPatternSequence().reduce(
    (current, pattern) => current.replace(new RegExp(pattern, "g"), ""),
    value,
  );
}

// Bodies a club could actually be holding. Every "before" below other than the
// two synthetic edge cases is the verbatim pre-sweep shipped default (recovered
// from the history of email-message-audit-defaults.ts), because that is exactly
// what the editor pre-filled the textarea with and what a club saved.
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
    name: "booking-modified, ten column-padded annotations from both families",
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
    name: "school attendee confirmation, quotes and apostrophes inside the notes",
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
      "The duplicate charge was refunded in full. [when the automatic refund could not complete inline: a recovery operation is queued. Failure detail: {{errorMessage}}]\n\nAmount refunded: {{amount}} [only when provided] plus fees [only when fees apply] today.",
    after:
      "The duplicate charge was refunded in full.\n\nAmount refunded: {{amount}} plus fees today.",
  },
  {
    name: "an annotation on the first line, on a line of its own, and at the start of a line with content after it",
    before: [
      "[only when localUrl exists]",
      "Repeated Xero Failures",
      "  [only when this whole block applies]",
      "Open local record [only when localUrl exists]",
      "[only when xeroObjectUrl exists] Open Xero object",
    ].join("\n"),
    after: ["Repeated Xero Failures", "Open local record", "Open Xero object"].join(
      "\n",
    ),
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

  it("uses exactly the TypeScript passes in the migration SQL, in order", () => {
    const patterns = sqlStripPatterns();
    expect(patterns).toHaveLength(SHIPPED_ANNOTATION_STRIP_PATTERNS.length * 2);
    // Subject and body must be transformed identically; a pass applied to one
    // and not the other would leave half a row healed.
    for (let index = 0; index < patterns.length; index += 2) {
      expect(patterns[index]).toBe(patterns[index + 1]);
    }
    expect(sqlStripPatternSequence()).toEqual([
      ...SHIPPED_ANNOTATION_STRIP_PATTERNS,
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

  it("matches the same annotation family the migration detects rows by", () => {
    // The migration selects candidate rows with this pattern and lists the
    // removed spans with it. If it drifted from the strip, a row could be
    // selected and not changed (a false audit row) or changed and not listed.
    const detectionPatterns = Array.from(
      migrationSql.matchAll(/'(\\\[\(\?:[^']*)'/g),
      (match) => match[1],
    ).filter((pattern) => !pattern.includes("(?<") && !pattern.includes("[ \\t]"));
    expect(detectionPatterns.length).toBeGreaterThanOrEqual(3);
    for (const pattern of detectionPatterns) {
      expect(pattern).toBe(SHIPPED_ANNOTATION_PATTERN);
    }
  });
});
