/**
 * AI Diagnostics — AID-6C finance pack, part 0: the SHARED BOUNDS, ARGUMENT
 * SHAPES and PROJECTION HELPERS the finance entries are built from (#2377, epic
 * #2369).
 *
 * This module holds no registry entry and reads nothing. It exists because the
 * finance pack registers ten entries across three modules and three properties
 * have to be identical in every one of them — a divergence in any of the three is
 * a security defect rather than an inconsistency:
 *
 *  1. MONEY IS INTEGER CENTS, EVERYWHERE. `centsOrNull`/`centsOrZero` are the only
 *     way a monetary value reaches a projected row, and they REFUSE a non-integer
 *     rather than rounding one. There is no `toFixed`, no division by 100 and no
 *     float arithmetic anywhere in this pack's data path: the model is handed the
 *     integer and the currency code, and the surface that renders it does the
 *     formatting. A cent that became a float here would be a cent that reconciles
 *     wrongly, silently, in an answer an operator acts on.
 *  2. STORED PROVIDER TEXT IS UNTRUSTED. Every value this pack projects that did
 *     NOT originate in a closed server-side union is re-validated against a known
 *     shape on the way out and replaced by a stable sentinel when it does not
 *     conform (`providerRefOrNull`, `stableCodeOrNull`), or hard-bounded and
 *     stripped of anything that could forge structure (`untrustedTextOrNull`).
 *     AID-6A learned this on `AuditLog.requestId`; the finance pack has far more
 *     of it — an internet-banking reference is whatever the payer typed into
 *     their bank, and a Xero object number is whatever Xero returned.
 *  3. A SEARCH IS BOUNDED, EXACT AND NON-BLANK. `EXACT_REFERENCE` is the one
 *     definition of an acceptable search term: a minimum useful length, a closed
 *     character class, no wildcard metacharacter, no quotes and no angle
 *     brackets. Every predicate built on it is `=` — there is no `LIKE` in this
 *     pack, so there is nothing for a wildcard to mean even if one got through.
 *
 * WHAT THIS PACK NEVER RETURNS, and the helpers are the enforcement rather than
 * the intention: an API key, an OAuth access or refresh token, a webhook signing
 * secret, an encrypted credential value, a raw Stripe response, a raw Xero
 * response, a raw webhook payload, raw provider error TEXT, a stack trace, a card
 * number or any part of one, a bank account number, a Stripe customer or payment
 * method identifier, a member's name, email address or phone number, or an
 * operator's free-text note. Those columns are not merely unprojected: with two
 * exceptions this pack argues for by name, they are not granted to the
 * SELECT-only role at all, so PostgreSQL itself refuses them (42501).
 */

import "server-only";

import { z } from "zod";

import { defuseRoleLabels, foldUntrustedText } from "../../untrusted-text";

/**
 * The number of rows a SEARCH may return. Ten is #2377's recommended default; its
 * absolute ceiling is twenty, and nothing in this pack asks for more — the pack's
 * own contract test pins both the ten and the fact that it is under the twenty.
 *
 * A search is deliberately the NARROWEST tool in the pack. Its job is to let an
 * operator pick the right record, not to be a report: it returns enough to
 * disambiguate (the reference, the amount, the state and the instant) and nothing
 * that would make a harvested list worth having.
 */
export const FINANCE_SEARCH_ROW_LIMIT = 10;

/**
 * The byte ceiling every multi-row finance entry declares — half the substrate's
 * hard 32 768, and the same figure AID-6A settled on for the same reason.
 *
 * Gate 9 REFUSES a result over the entry's ceiling; it never trims one. So a
 * ceiling has to clear the entry's own `rowLimit` rows at the WIDEST widths its
 * projection can emit, not at today's typical ones — AID-6A shipped an 8 192-byte
 * ceiling that an ordinary deployment exceeded by 80 bytes and refused whole
 * results for a question that took no arguments. A registry contract test
 * serialises every entry's own projected shape at its own row limit and fails if
 * the ceiling is unachievable, so this number is a measurement rather than a
 * preference.
 */
export const FINANCE_BYTE_LIMIT = 16_384;

/** The byte ceiling for the single-row entries. Measured the same way. */
export const FINANCE_SINGLE_ROW_BYTE_LIMIT = 4_096;

/**
 * The approved search windows for the amount-plus-date search, and the days each
 * means. A closed enum rather than a pair of dates, so "a narrow date range" is a
 * TYPE rather than a validation rule a later edit can loosen, and so there is no
 * unrestricted range for a caller to ask for. #2377 forbids an unrestricted date
 * range in as many words.
 */
export const FINANCE_SEARCH_WINDOWS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
} as const;

export type FinanceSearchWindow = keyof typeof FINANCE_SEARCH_WINDOWS;

export const FINANCE_SEARCH_WINDOW_KEYS = Object.keys(
  FINANCE_SEARCH_WINDOWS,
) as [FinanceSearchWindow, ...FinanceSearchWindow[]];

/** The default when the model does not choose. The narrowest useful window. */
export const DEFAULT_FINANCE_SEARCH_WINDOW: FinanceSearchWindow = "30d";

/**
 * An exact reference an operator may search on. EXACT, never a pattern: every
 * predicate in this pack is `=`, so there is no `LIKE`, no wildcard and nothing to
 * enumerate with, whatever this accepts.
 *
 * Six characters is the minimum useful length #2377 requires. It is not an
 * arbitrary floor: the shortest real reference this pack accepts is an eight
 * character booking reference, and the shortest Stripe identifier is longer
 * still, so six refuses a blank, a single letter and a one-digit probe without
 * refusing anything real.
 *
 * The character class admits a space because an internet-banking reference is
 * whatever the payer typed into their own bank's payment form, and real ones
 * carry spaces. It refuses quotes and angle brackets, because a value that
 * reaches the evidence renderer must not be able to forge structure even before
 * the renderer neutralises it, and it refuses `%` and `*`, because a search term
 * that LOOKS like a wildcard invites a future edit to make it one.
 *
 * `_` IS ADMITTED, and an earlier revision of this class refused it — which was a
 * real defect the registry contract test caught before it shipped. Every Stripe
 * identifier this pack accepts as a search term is `<prefix>_<id>`:
 * `pi_3Q…` (PaymentIntent), `ch_…` (charge), `re_…` (refund), `evt_…` (event). A
 * class without `_` would have refused every Stripe reference an operator could
 * paste in, while the tool's own description advertised them. It is safe: `_` is
 * only a wildcard inside a `LIKE` pattern, and there is no `LIKE` anywhere in this
 * pack — every predicate built on this value is an equality.
 */
export const EXACT_REFERENCE = z
  .string()
  .min(6)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.:#/-]*$/);

/**
 * A cuid as this schema mints them: `@default(cuid())` produces a 25-character
 * lowercase alphanumeric string beginning `c`. Kept strict because every
 * per-record entry in this pack takes one, and a strict shape is what makes the
 * predicate an equality against a primary key rather than a scan.
 */
export const RECORD_ID = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/);

/**
 * The largest amount this pack will accept as a search term, in integer cents:
 * $1,000,000.00. Deliberately a bound rather than `Number.MAX_SAFE_INTEGER` —
 * a search argument becomes a bound query parameter against an `int4` column, and
 * a value outside `int4` is a query error rather than a refusal the operator can
 * read.
 */
export const MAX_SEARCH_AMOUNT_CENTS = 100_000_000;

/**
 * An exact amount to search on, in INTEGER CENTS. `z.int()` rather than
 * `z.number().int()` so a float is a rejection and never a silent truncation:
 * `1999.5` is not an amount this platform can hold, and accepting it would let a
 * model's arithmetic mistake become a search that quietly found the wrong
 * payment.
 *
 * Zero is permitted. A zero-amount payment is a real and diagnostically
 * interesting record — a fully credit-covered booking settles as one — and
 * refusing it would hide exactly the case an operator is most likely to be
 * confused by.
 *
 * PERMITTING IT PUTS THE BURDEN ON THE PREDICATE, and that is where it belongs.
 * `Payment."additionalAmountCents"` is `Int @default(0)` NOT NULL, so an
 * unguarded `additionalAmountCents = $1` matched essentially the whole relation
 * on a zero term and turned this search into the blank "recent payments" listing
 * #2377 forbids. The amount search's own SQL guards that leg with `$1::int > 0`;
 * see `AMOUNT_SEARCH_SQL` in `finance-search.ts`. Do not relax this bound
 * without re-reading that guard — the two are one control.
 */
export const AMOUNT_CENTS = z.int().min(0).max(MAX_SEARCH_AMOUNT_CENTS);

/**
 * The sentinel a value takes when it does not conform to the shape its column is
 * supposed to hold. It deliberately contains characters every validator in this
 * module refuses, so no real stored value can collide with it and no model can
 * turn round and search on it.
 */
export const FINANCE_UNPARSEABLE_VALUE = "(unparseable)";

/**
 * A PROVIDER REFERENCE on the way out — a Stripe PaymentIntent, Charge or Refund
 * id, a Xero object id or number, a webhook event id, a correlation key.
 *
 * Re-validated rather than trusted for the same reason AID-6A re-validates
 * `AuditLog.requestId`: the value is whatever a third party or an importer wrote
 * into the column, nothing normalises it on the way in, and the evidence
 * renderer's row format is `key=value` pairs joined by `"; "`. A stored value
 * carrying `"`, `;` or `=` would be a field-forgery payload if it were projected
 * raw, and a long one is a denial of service against the entry's own byte
 * ceiling. The renderer quotes and neutralises every value as the second layer;
 * this is the first, and it is specific to these columns' provenance.
 *
 * The class is deliberately narrow — provider identifiers really are
 * `[A-Za-z0-9_.:-]` in every scheme this platform stores — so anything else is
 * evidence that the column holds something other than an identifier, which is a
 * fact worth reporting as a sentinel rather than a string worth shipping.
 */
const PROJECTABLE_PROVIDER_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

/**
 * A STABLE CODE on the way out — a status, an outcome, an error code, an object
 * type. Most of these come from a closed Prisma enum and cannot be anything else;
 * several (`PaymentRefund.status`, `XeroSyncOperation.status` and `lastErrorCode`,
 * `XeroInboundEvent.status`, `WebhookLog.status`) are plain `String` columns whose
 * values come from a provider or from application code, so the shape is checked
 * rather than assumed.
 *
 * Shorter and stricter than a provider reference: a code has no dots, no slashes
 * and no spaces, so a sentence that arrived in a status column is refused instead
 * of being reported as though it were a classification.
 */
const PROJECTABLE_STABLE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;

/**
 * A RECORD IDENTIFIER on the way out — a cuid primary key, a booking reference,
 * an audit row id.
 *
 * Validated rather than passed through, which an earlier revision of this pack did
 * not do and which its own hostile-row test caught. The argument for passing them
 * through was that `@default(cuid())` generates them, so nothing hostile can be in
 * one — and it is wrong twice: this codebase does hand-set ids in imports,
 * fixtures and migrations, and "the column is usually server-generated" is exactly
 * the kind of reasoning a later edit invalidates without noticing. An id that is
 * not id-shaped is not an identifier, so reporting a sentinel is both safer and
 * more honest than reporting the value.
 *
 * Slightly wider than a cuid (`_` and `-` are admitted) because the schema's
 * hand-set ids and the eight-character uppercase booking reference both have to
 * pass, and narrower than a provider reference (no `.` or `:`) because a local
 * record id never carries either.
 */
const PROJECTABLE_RECORD_REF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function recordRefOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length === 0) return null;
  return PROJECTABLE_RECORD_REF.test(text) ? text : FINANCE_UNPARSEABLE_VALUE;
}

/**
 * An ISO-8601 UTC instant on the way out.
 *
 * Every instant this pack projects is produced by `to_char` in the entry's own SQL
 * or by `.toISOString()` in its evidence source, so a value that is not
 * instant-shaped means the projection read a column it did not think it was
 * reading. Reporting the sentinel makes that visible instead of shipping whatever
 * the column held into a field a consumer will parse as a date.
 */
const PROJECTABLE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export function instantOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length === 0) return null;
  return PROJECTABLE_INSTANT.test(text) ? text : FINANCE_UNPARSEABLE_VALUE;
}

/**
 * A SERVER-OWNED operator-facing label — today, only the payment display status
 * from `payment-status-display.ts` ("Paid", "Credit Issued + Card Refund",
 * "Cancelled Before Payment").
 *
 * It is server-owned, so it is not untrusted in the way a bank reference is; it is
 * bounded and stripped anyway, because "this string comes from our own code" is a
 * property of today's call graph rather than of the projection, and the projection
 * is the boundary. The character class is a positive allowlist: letters, digits,
 * spaces and the three punctuation marks the real labels use.
 */
const PROJECTABLE_LABEL = /^[A-Za-z0-9 +,.'-]{1,64}$/;

export function serverLabelOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length === 0) return null;
  return PROJECTABLE_LABEL.test(text) ? text : FINANCE_UNPARSEABLE_VALUE;
}

/**
 * A COMMA-JOINED LIST of stable codes — the shape AID-6A's readiness entry uses
 * for its blocker codes, reused here so a consumer parses one convention.
 *
 * Validated as a whole rather than per element: the list is built from a closed
 * server-owned catalogue, and anything that does not look like that catalogue is a
 * sentinel rather than a partially-trusted string.
 */
const PROJECTABLE_CODE_LIST = /^[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*$/;

export function codeListOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length === 0) return null;
  return PROJECTABLE_CODE_LIST.test(text) ? text : FINANCE_UNPARSEABLE_VALUE;
}

/**
 * Project a provider reference, or the sentinel when the column does not hold
 * something shaped like one.
 */
export function providerRefOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length === 0) return null;
  return PROJECTABLE_PROVIDER_REF.test(text) ? text : FINANCE_UNPARSEABLE_VALUE;
}

/** Project a stable code, or the sentinel when the column does not hold one. */
export function stableCodeOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length === 0) return null;
  return PROJECTABLE_STABLE_CODE.test(text) ? text : FINANCE_UNPARSEABLE_VALUE;
}

/**
 * The hard cap on a genuinely free-text untrusted value — today, only the
 * internet-banking payment reference, which is whatever the payer typed into
 * their own bank.
 *
 * WELL BELOW the substrate's own 200-character field cap, on purpose. A bank
 * reference this platform can act on is short; a long one is either noise or an
 * attempt to spend an entry's byte ceiling, and 64 characters is enough to
 * recognise a real one while making the attack pointless. The truncation is
 * marked, so a clipped value never reads as a complete one.
 */
export const UNTRUSTED_TEXT_MAX_CHARS = 64;

/**
 * Project a free-text untrusted value: folded and role-label defused, quotes and
 * angle brackets removed, whitespace collapsed, hard-capped and marked when
 * clipped.
 *
 * `foldUntrustedText(value, "flatten")` REPLACES the old narrow control class,
 * which missed the C1 block — U+0085 (NEL) is not matched by JavaScript's `\s`,
 * so it survived both that class and the `\s+` collapse below and could fake a
 * new line in the rendered evidence (#2832). The fold maps every C0/DEL/C1
 * control character and every line terminator to a space, drops every
 * invisible/format code point, and folds compatibility colon and bracket
 * spellings — the same primitive the page-context renderer uses after PR #2831,
 * so this database-derived path is no weaker than that one.
 *
 * `defuseRoleLabels` — the ANYWHERE-in-span variant, NOT the line-anchored one —
 * because the `\s+` collapse renders this value on ONE line inside a `key="…"`
 * cell: there is no line start for a label to anchor to, so a forged
 * `assistant:` turn is dangerous wherever it sits, exactly the choice `render.ts`
 * made. The fold runs BEFORE the bracket strip so a folded `＜` (U+FF1C → `<`) is
 * still stripped.
 *
 * The quote and angle-bracket strip duplicates what `render.ts` does, and stays
 * anyway: this pack's values also reach the audit `resultHash` and any consumer
 * that reads a result without rendering it — neither of which the renderer's own
 * fold touches — so the defusal has to happen at the projection too, not only at
 * the render boundary.
 */
export function untrustedTextOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = defuseRoleLabels(
    foldUntrustedText(String(value), "flatten")
      .replace(/["<>]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (cleaned.length === 0) return null;
  if (cleaned.length <= UNTRUSTED_TEXT_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, UNTRUSTED_TEXT_MAX_CHARS - 1)}…`;
}

/**
 * Project an amount as INTEGER CENTS, or null.
 *
 * A non-integer is `null` and NOT a rounded number, deliberately. Every monetary
 * column this pack reads is `Int` in PostgreSQL, so a non-integer arriving here
 * means the value did not come from where the projection thinks it did — and a
 * rounded cent presented as evidence is how a reconciliation answer becomes
 * confidently wrong. An absent amount is an honest absence; a rounded one is not.
 */
export function centsOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number") {
    // `Number("")` is 0, and `Number(" ")` is 0, and `Number([])` is 0. An empty
    // or blank value is an ABSENT amount, not a zero one, and the difference
    // matters: "nothing is recorded" and "nothing is owed" are different answers
    // and only one of them is a finding. Measured — this is the case the pack's own
    // contract test caught.
    if (typeof value !== "string" || value.trim().length === 0) return null;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric)) return null;
  return numeric;
}

/**
 * Project an amount as integer cents, defaulting to 0. For columns the schema
 * declares `@default(0)` and NOT NULL, where an absent value means zero rather
 * than unknown.
 */
export function centsOrZero(value: unknown): number {
  return centsOrNull(value) ?? 0;
}

/** Project a boolean. Anything that is not exactly `true` is `false`. */
export function boolOf(value: unknown): boolean {
  return value === true;
}

/**
 * Project a count as a non-negative integer.
 *
 * `count(*)` comes back from node-postgres as a STRING, because PostgreSQL types
 * it `bigint` and the driver refuses to lose precision on one. Every count in
 * this pack's SQL is cast `::int` for that reason; this is the belt, so a cast
 * somebody forgets becomes a zero rather than a `redaction_failed` on a
 * non-finite number.
 */
export function countOf(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.trunc(numeric));
}

/**
 * The SQL fragment that formats a naive UTC `timestamp` column as an ISO-8601
 * instant, exported so every entry in the pack formats an instant the same way.
 *
 * TIMEZONE-INDEPENDENT, and that is a correctness control rather than a
 * cosmetic one. Every instant in this schema is a naive `timestamp` holding UTC,
 * so `to_char` applied to a `timestamptz` — or a comparison that crosses between
 * the two — is resolved using the SESSION's `TimeZone`, and a deployment that
 * sets `Pacific/Auckland` would stamp local time with a `Z` and shift a window by
 * 12-13 hours. The executor also pins `TimeZone` to UTC per transaction; nothing
 * here relies on that.
 */
export function utcInstant(column: string): string {
  return `pg_catalog.to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
}

/**
 * The SQL fragment for `now()` as a naive UTC timestamp, for comparison against
 * this schema's naive `timestamp` columns. Same reasoning as `utcInstant`.
 */
export const NOW_UTC = `(pg_catalog.now() AT TIME ZONE 'UTC')`;

/**
 * The sentence every finance entry appends to its own `evidenceScope`.
 *
 * THIS IS THE STORED-EVIDENCE DISCLOSURE, and it is the most important sentence
 * in the pack. #2377's first release reads only what the application already
 * stored: nothing here calls Stripe, Xero, a bank or any other provider, so every
 * provider state reported is the last state this platform WROTE DOWN, not the
 * state the provider holds now. Without the sentence a model narrates a stored
 * `SUCCEEDED` as though it had just asked Stripe, which is precisely the
 * "presenting a likely cause as a confirmed provider fact" failure the issue
 * forbids.
 *
 * It also names the one thing an operator can do about it — check the provider's
 * own console — because the honest answer to "is this really what Stripe thinks?"
 * is that Diagnostics cannot tell, and saying so is more useful than an implied
 * certainty.
 */
export const STORED_EVIDENCE_DISCLOSURE =
  "Every provider value here is STORED evidence: it is what this platform last recorded, not a live answer from Stripe, Xero or a bank. No provider is contacted by any diagnostics tool. Treat a provider state as true only as at its own stored instant, and say so; if the question turns on what the provider believes RIGHT NOW, that needs a check in the provider's own console, which is outside Diagnostics.";

/**
 * The tail every finance tool DESCRIPTION shares — the model-facing half of the
 * same disclosure, plus the read-only boundary in the words a model is most
 * likely to act on.
 *
 * "Never state that an action was taken" is spelled out because the failure mode
 * is specific and expensive: a model that has just explained how to issue a
 * refund is one sentence away from reporting that it issued one, and a Finance
 * Officer who believes a refund has been sent does not send it.
 */
export const FINANCE_DESCRIPTION_TAIL =
  "All amounts are INTEGER CENTS in the currency named on the row; never convert, round or add them into a formatted total — report the cents and let the screen format them. This tool is READ ONLY and contacts no provider: it cannot create, change, allocate, reconcile, refund, retry, replay or void anything, and you must never state or imply that an action was performed. Provider values are the last state this platform stored, not a live provider answer. If the evidence does not settle the question, say which fact is missing and which screen or provider console would settle it.";
