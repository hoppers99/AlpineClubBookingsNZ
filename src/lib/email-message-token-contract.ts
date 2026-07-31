/**
 * #2268 — the guards over the shipped email default bodies.
 *
 * The guard these replace was circular. `email-message-registry.test.ts` ran
 * `validateEmailTemplateContent` over every default body, which looks like an
 * unknown-token check; but the per-template `allowedTokens` it validates
 * against is itself built by scraping tokens out of that same default body
 * (`extractTokensFromDefaults`). Any token you put in a default was allowed
 * *because* you put it there, so the check could never fail on a default. Its
 * only teeth were against admin-authored overrides.
 *
 * Everything below takes the registries it checks as ARGUMENTS rather than
 * reading module state, so the tests can run each guard against a deliberately
 * broken fixture and prove it actually bites.
 */

export interface EmailTemplateDefaults {
  defaultSubject: string;
  defaultBody: string;
}

export interface TemplateFinding {
  key: string;
  field: "defaultSubject" | "defaultBody";
  detail: string;
}

const TOKEN_PATTERN = /\{\{([^{}]+)\}\}/g;

/**
 * Tokens whose send site may legitimately supply an EMPTY value, per template.
 *
 * This is the honest half of the contract and it is maintained BY HAND: each
 * entry was read off the sender during #2268 (a `?? ""`, a nullable column, an
 * `amountCents: number | null`). Nothing derives it, and — be precise about
 * what that means — guard 4 (`findDanglingDefaultLines`) only exercises the
 * tokens DECLARED here: it renders each declared token empty and checks no
 * line dangles. An optional value a sender supplies but nobody declares is
 * rendered with its non-empty preview sample instead, so guard 4 CANNOT catch
 * an undeclared optional; only guard 5 keeps the declared names honest in the
 * other direction (declared but no longer in the body). The declaration
 * discipline is therefore: whenever a send site starts supplying a value that
 * can be empty (`?? ""`, nullable column, conditional composition), record it
 * here in the same change — this table is the single place that turns guard 4
 * on for that token.
 */
export const OPTIONAL_TEMPLATE_TOKENS: Record<string, readonly string[]> = {
  // #2267 (F1): the promo block and the split-parent sentence are both
  // pre-composed and both empty on an ordinary confirmation. The door-code
  // line (#2267) is composed whole by the sender and empty for a lodge with
  // no code recorded — declared here so guard 4 proves the default body
  // survives its absence (it was live-but-undeclared until the #2320 review).
  "booking-confirmed": [
    "promoSummary",
    "provisionalGuestsNote",
    "doorCodeNote",
  ],
  // The credit-restored sentence is composed whole by the sender and empty
  // when no applied credit was restored (#1164 D7) — declared for the same
  // reason as booking-confirmed's doorCodeNote above.
  "booking-cancelled": ["creditRestoredMessage"],
  "booking-modified": ["paymentNote"],
  // #2268 sweep. Each of these was an "[only when …]" annotated line.
  "checkin-reminder": ["choreListNote"],
  "pre-arrival-reminder": ["expectedArrivalNote", "doorCodeNote"],
  // A roster only exists for chores that exist, so the chore block itself is
  // never empty; the completion link is (a roster can be sent without one).
  "chore-roster": ["choreLinkNote"],
  "membership-application-approved": ["committeeNote"],
  "membership-application-rejected": ["committeeNote"],
  "child-request-rejected": ["adminNoteLine"],
  "family-group-create-rejected": ["adminNoteLine"],
  "membership-cancellation-submitted": ["reasonNote"],
  "membership-cancellation-approved": [
    "reasonNote",
    "adminNoteLine",
    "rejoinProcessNote",
  ],
  "membership-cancellation-rejected": ["reasonNote", "adminNoteLine"],
  "admin-membership-cancellation-request": ["reasonNote"],
  "account-deletion-rejected": ["adminNoteLine"],
  "admin-account-deletion-requested": ["reasonNote"],
  "member-archive-approved": ["reviewNoteLine"],
  "member-archive-rejected": ["reviewNoteLine"],
  "admin-member-delete-approved": ["reviewNoteLine"],
  "admin-member-delete-rejected": ["reviewNoteLine"],
  "admin-new-booking": ["reviewReasonNote"],
  "admin-refund-request": ["requestedAmountNote"],
  "admin-booking-change-request": ["reasonNote"],
  "admin-xero-repeated-failure": [
    "localRecordNote",
    "latestErrorNote",
    "xeroLinksNote",
  ],
  "refund-request-approved": ["adminNotesLine"],
  "refund-request-declined": ["adminNotesLine"],
  "booking-request-declined": ["reasonNote"],
  "split-guest-portion-cancelled": ["bookingReferenceNote"],
  "booking-review-approved": ["adminNotesLine"],
  "booking-review-rejected": ["adminNotesLine"],
  "membership-payment-recorded": ["amountRecordedNote"],
};

export function extractTokens(value: string): string[] {
  return Array.from(value.matchAll(TOKEN_PATTERN), (match) =>
    match[1].trim(),
  ).filter(Boolean);
}

/**
 * GUARD 1 — no authoring annotation may survive in a shipped default.
 *
 * The admin editor pre-fills its textarea with `defaultBody` and stores what it
 * is given verbatim, so anything in square brackets reaches a real inbox the
 * first time a club saves that template. Cheap, and permanent.
 */
export function findBracketAnnotations(
  defaults: Record<string, EmailTemplateDefaults>,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, entry] of Object.entries(defaults)) {
    for (const field of ["defaultSubject", "defaultBody"] as const) {
      // Token braces are the only legitimate markup; anything bracketed is an
      // authoring note, because the render path has no syntax of its own.
      const matches = entry[field].match(/\[[^\]]*\]/g);
      if (matches) {
        findings.push({ key, field, detail: matches.join(" | ") });
      }
    }
  }
  return findings;
}

/**
 * #2269 (F3) — the annotation families this project ever SHIPPED inside a
 * default body, expressed as a regex alternation.
 *
 * Guard 1 above treats ANY square-bracketed span as an authoring note, which is
 * the right rule for a save-time refusal and for a "your row still carries
 * junk" banner: the admin is told, and the admin decides. It is the WRONG rule
 * for a migration that rewrites club-authored content without asking. A club
 * that typed "[see the noticeboard]" into its own wording wrote that on
 * purpose; deleting it silently is the "forced reset destroys legitimate
 * customisation" failure mode #2269 exists to avoid.
 *
 * So the migration strips only text WE wrote and shipped. These four prefixes
 * are the complete set found by replaying every historical revision of
 * `email-message-registry.ts`, `email-message-audit-defaults.ts` and
 * `email-message-notes.ts` and extracting every bracketed span:
 *
 *   [only when …]          the bulk of them (conditional-line notes)
 *   [when …]               the "and when it did not" siblings
 *   [heading becomes …]    school attendee-confirmation subject note
 *   [falls back to …]      school attendee-confirmation body note
 *
 * Anything else bracketed survives the migration and keeps showing up in guard
 * 1's banner, where an admin resolves it deliberately.
 */
const SHIPPED_ANNOTATION_PREFIXES =
  "(?:only when|when|heading becomes|falls back to)";

/**
 * One shipped authoring annotation, e.g. "[only when a door code is set]".
 * Case-sensitive on purpose: this matches the text this project shipped, not
 * an approximation of it.
 */
export const SHIPPED_ANNOTATION_PATTERN = `\\[${SHIPPED_ANNOTATION_PREFIXES}[^\\]]*\\]`;

/**
 * The strip, as an ORDERED list of regex sources, each applied globally with an
 * EMPTY replacement.
 *
 * This exact list is what the #2269 migration runs: every pattern below appears
 * verbatim as a `regexp_replace(..., '<pattern>', '', 'g')` in
 * `prisma/migrations/20260801150000_strip_email_override_bracket_annotations/migration.sql`,
 * and `email-message-annotation-strip.test.ts` reads the SQL file back and
 * proves the two lists are identical, then runs the fixture corpus through the
 * patterns lifted OUT OF THE SQL. Every construct used here means the same
 * thing in PostgreSQL's ARE engine and in JavaScript's — verified against
 * postgres:16 before the patterns were fixed:
 *
 *   `[^\]]`          an escape inside a bracket expression (ARE, not POSIX)
 *   `(?=\n|$)`       lookahead; `$` is end-of-STRING in both (no n/m flag)
 *   `(?<=[^ \t\r\n])` fixed-width lookbehind
 *   `^`              start-of-STRING in both (no n/m flag)
 *
 * Why four passes rather than one:
 *
 *   1. an annotation that occupies a whole line takes the line with it, so a
 *      stripped body does not grow a blank line where a note used to sit;
 *   2. the same, for an annotation on the very first line;
 *   3. an annotation with content before it on the line takes the whitespace
 *      that separated it — the defaults padded them into a column
 *      ("Subtotal: {{subtotal}}          [only when discountCents > 0]"), and
 *      leaving that padding behind would be its own trailing-whitespace defect;
 *   4. whatever is left is an annotation at the start of a line with content
 *      after it, which takes the whitespace that follows instead.
 *
 * Order matters: 3 must run before 4, or a padded end-of-line annotation would
 * be removed by 4 and leave its padding as trailing whitespace.
 */
export const SHIPPED_ANNOTATION_STRIP_PATTERNS: readonly string[] = [
  `\\n[ \\t]*${SHIPPED_ANNOTATION_PATTERN}[ \\t\\r]*(?=\\n|$)`,
  `^[ \\t]*${SHIPPED_ANNOTATION_PATTERN}[ \\t\\r]*\\n`,
  `(?<=[^ \\t\\r\\n])[ \\t]*${SHIPPED_ANNOTATION_PATTERN}`,
  `${SHIPPED_ANNOTATION_PATTERN}[ \\t]*`,
];

/** Every shipped annotation present in a value, in the order they appear. */
export function findShippedAnnotations(value: string): string[] {
  return Array.from(
    value.matchAll(new RegExp(SHIPPED_ANNOTATION_PATTERN, "g")),
    (match) => match[0],
  );
}

/**
 * Remove every shipped authoring annotation from a stored template value.
 *
 * Idempotent by construction: the output contains no span matching
 * SHIPPED_ANNOTATION_PATTERN, so a second run matches nothing and returns its
 * input unchanged. A value with no shipped annotation is returned as-is
 * (identity), which is what lets the migration write an audit row only for rows
 * it genuinely changed.
 */
export function stripShippedAnnotations(value: string): string {
  return SHIPPED_ANNOTATION_STRIP_PATTERNS.reduce(
    (current, pattern) => current.replace(new RegExp(pattern, "g"), ""),
    value,
  );
}

/**
 * GUARD 2 — every token in a shipped default must be in the APPROVED registry.
 *
 * Not circular: the approved set is a hand-maintained list in
 * `email-message-registry.ts`, not something scraped back out of the defaults.
 * A default that introduces a token nobody approved fails here, and would
 * otherwise be a token the admin editor rejects on the very body it shipped.
 */
export function findUnapprovedDefaultTokens(
  defaults: Record<string, EmailTemplateDefaults>,
  approvedTokens: ReadonlySet<string>,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, entry] of Object.entries(defaults)) {
    for (const field of ["defaultSubject", "defaultBody"] as const) {
      const unapproved = extractTokens(entry[field]).filter(
        (token) => !approvedTokens.has(token),
      );
      if (unapproved.length > 0) {
        findings.push({ key, field, detail: unapproved.sort().join(", ") });
      }
    }
  }
  return findings;
}

/**
 * GUARD 3 — every token a send site supplies for override use must be APPROVED.
 *
 * This is exactly the state `{{promoAdjustment}}` was in before #2267: the
 * value was computed correctly and passed to the renderer, the registry allowed
 * it for that template, and the editor still rejected it as an unknown token,
 * so no admin could ever use it. Runs over the extra-token map, which is where
 * a supplied-but-not-in-the-body token is declared.
 */
export function findUnapprovedSuppliedTokens(
  extraTokens: Partial<Record<string, readonly string[]>>,
  approvedTokens: ReadonlySet<string>,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, tokens] of Object.entries(extraTokens)) {
    const unapproved = (tokens ?? []).filter(
      (token) => !approvedTokens.has(token),
    );
    if (unapproved.length > 0) {
      findings.push({
        key,
        field: "defaultBody",
        detail: unapproved.sort().join(", "),
      });
    }
  }
  return findings;
}

/**
 * GUARD 4 — no default body may leave a dangling line when an OPTIONAL token
 * renders empty.
 *
 * This is the invariant the bracket annotations were standing in for, and the
 * one that actually matters to a member: `Door code: {{doorCode}}` on a lodge
 * with no door code, or `Requested: {{requestedAmount}}` on an appeal that
 * named no figure, renders a label with nothing after it. Every default is
 * rendered here with its optional tokens EMPTY and everything else filled from
 * the editor's own preview samples, then every line is checked.
 */
export function findDanglingDefaultLines(
  defaults: Record<string, EmailTemplateDefaults>,
  optionalTokens: Record<string, readonly string[]>,
  sampleFor: (token: string) => string,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, entry] of Object.entries(defaults)) {
    const optional = new Set(optionalTokens[key] ?? []);
    const render = (value: string) =>
      value.replace(TOKEN_PATTERN, (_match, rawToken: string) => {
        const token = rawToken.trim();
        return optional.has(token) ? "" : sampleFor(token);
      });

    for (const field of ["defaultSubject", "defaultBody"] as const) {
      const bad: string[] = [];
      // Compared line by line against the template, because a line that ENDS
      // in a colon in the template is a heading for the block beneath it
      // ("Guest list:", "Reason:") and is perfectly fine. What is never fine
      // is a line that had content after the label in the template and lost it
      // in the render — "Door code: {{doorCode}}" becoming "Door code:".
      for (const templateLine of entry[field].split("\n")) {
        const renderedLine = render(templateLine).trimEnd();
        const labelPattern = /[-:–—]$/;
        if (
          labelPattern.test(renderedLine) &&
          !labelPattern.test(templateLine.trimEnd())
        ) {
          bad.push(renderedLine);
          continue;
        }
        // A possessive left without its noun ("'s stay at …" when no school
        // name is recorded).
        if (/(^|\s)'s\b/.test(renderedLine)) {
          bad.push(renderedLine);
        }
      }
      if (bad.length > 0) {
        findings.push({
          key,
          field,
          detail: bad.map((line) => JSON.stringify(line)).join(" | "),
        });
      }
    }
  }
  return findings;
}

/**
 * GUARD 5 — an optional-token declaration must name tokens that are actually in
 * the default it claims to describe, so the contract cannot rot into a list of
 * names that no longer appear anywhere.
 */
export function findStaleOptionalTokens(
  defaults: Record<string, EmailTemplateDefaults>,
  optionalTokens: Record<string, readonly string[]>,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, tokens] of Object.entries(optionalTokens)) {
    const entry = defaults[key];
    if (!entry) {
      findings.push({
        key,
        field: "defaultBody",
        detail: "no such registered template",
      });
      continue;
    }
    const present = new Set([
      ...extractTokens(entry.defaultSubject),
      ...extractTokens(entry.defaultBody),
    ]);
    const stale = tokens.filter((token) => !present.has(token));
    if (stale.length > 0) {
      findings.push({ key, field: "defaultBody", detail: stale.join(", ") });
    }
  }
  return findings;
}
