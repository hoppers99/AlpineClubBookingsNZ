/**
 * AI Diagnostics — typed structured page context: shared types, bounds, and the
 * UNTRUSTED client selector schema (AID-4, epic #2369, issue #2373).
 *
 * WHAT THIS REPLACES (for Diagnostics only). Page help ships a flat, free-text
 * `pageContext` string that the client composes and the server forwards verbatim
 * (`src/components/help-widget/help-page-context.ts`,
 * `src/app/api/help/chat/route.ts`). That is fine for a powerless, member-facing
 * assistant with no tools and no data, and it is deliberately left alone —
 * ADR-001 forbids Diagnostics from reusing Page help's plumbing as its policy
 * surface. Diagnostics instead takes a **typed selector** and re-derives every
 * fact on the server.
 *
 * THE ONE INVARIANT THAT MATTERS: a client value SELECTS, it never ASSERTS.
 * Nothing in a `DiagnosticsPageSelector` is treated as a fact about the system.
 * The selector names the registry route the operator is on, optionally one
 * record id, and a handful of route-allowlisted view tokens. Every value that
 * reaches the model is then re-fetched or re-derived server-side, under the
 * caller's FRESHLY re-read permissions, and stamped with an observed-at instant.
 *
 * SECURITY POSTURE (do not weaken without an owner decision on #2370):
 *  - ADR-001: no DOM scrape, no screenshot, no hidden form, no arbitrary
 *    serialization channel. The selector is a closed, bounded, typed shape; a
 *    field that is not in this schema cannot travel at all (`.strict()`).
 *  - ADR-002: the route's declared admin areas are re-checked at `view`, fresh
 *    from the database-joined access roles, on EVERY resolution — never from a
 *    session/JWT snapshot, and never cached across calls. Cross-area routes need
 *    every area (AND), fail-closed.
 *  - ADR-003: the resolved context is UNTRUSTED, prompt-injection-capable
 *    evidence. It carries no system authority, and it always carries observed-at
 *    plus a citation.
 *  - ADR-004: identifying fields are OPT-IN per invocation. Without the opt-in a
 *    record resolves to non-identifying state only, plus an explicit omission
 *    notice. Audit metadata carries a hash of the record reference, never the
 *    raw id, and never any field value.
 */

import { z } from "zod";

import type { AdminPermissionArea } from "@/lib/admin-permissions";

/**
 * Selector/context format version. Bump only on a breaking shape change; a
 * consumer pins the exact value so it can never silently read a shape it does
 * not understand (same discipline as the knowledge bundle, AID-3).
 */
export const DIAGNOSTICS_PAGE_CONTEXT_SCHEMA_VERSION = 1 as const;

/**
 * Every bound the selector and the resolved context are held to. They are small
 * on purpose: this channel exists to say "the operator is on THIS page looking
 * at THIS record", not to move data. Anything larger belongs to a tool
 * (AID-5+), where it is gated, metered, and audited as such.
 */
export const DIAGNOSTICS_PAGE_CONTEXT_BOUNDS = {
  /** Registry key, e.g. `admin.member-detail`. */
  routeKeyMaxChars: 64,
  /** A cuid-ish opaque record id. */
  recordIdMaxChars: 64,
  /** A tab / step / status / error-code token. */
  tokenMaxChars: 48,
  /** A filter key (must also be in the route's allowlist). */
  filterKeyMaxChars: 32,
  /** A filter VALUE — free-ish text, so the tightest bound of the lot. */
  filterValueMaxChars: 120,
  /** How many filters one selector may carry. */
  maxFilters: 8,
  /** Cap on any single re-fetched free-text fact after redaction. */
  factValueMaxChars: 200,
  /** Hard cap on the rendered evidence block handed to the model. */
  renderedBlockMaxChars: 4000,
} as const;

/**
 * A registry route key: lowercase dotted/hyphenated segments only. Deliberately
 * NOT a pathname — a pathname is attacker-shaped input that invites prefix
 * tricks; a key is looked up in a closed server-side table or rejected.
 */
const ROUTE_KEY_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * An opaque record id. Alphanumeric plus `_`/`-` only, so it can never carry a
 * wrapper delimiter, whitespace, a path separator, or a quote into anything
 * downstream.
 */
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A view token (tab, step, status, error code). Lowercase and punctuation-poor. */
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** A filter key. Same alphabet as a token, plus camelCase (`lodgeId`). */
const FILTER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Reject control characters on EVERY string field. Two reasons, and the second
 * is the load-bearing one:
 *
 *  1. A control character in a selector means the selector is malformed, and
 *     silently repairing malformed input is how a bypass gets built.
 *  2. It closes a real hole in the anchors above. In JavaScript `$` ALSO matches
 *     immediately before a final line terminator, so a pattern like
 *     `/^[a-z]+$/` accepts a value with a trailing newline. A record id or route
 *     key allowed to carry one is exactly the value that later fakes a new line
 *     inside a rendered evidence block. This check refuses it whatever the
 *     anchor does. Written as an explicit scan rather than a regex so no escape
 *     sequence has to survive a future edit intact.
 */
function noControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const CONTROL_CHARACTER_MESSAGE = "must not contain control characters";

const routeKeySchema = z
  .string()
  .min(1)
  .max(DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.routeKeyMaxChars)
  .regex(ROUTE_KEY_PATTERN)
  .refine(noControlCharacters, { message: CONTROL_CHARACTER_MESSAGE });

const recordIdSchema = z
  .string()
  .min(1)
  .max(DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.recordIdMaxChars)
  .regex(RECORD_ID_PATTERN)
  .refine(noControlCharacters, { message: CONTROL_CHARACTER_MESSAGE });

const tokenSchema = z
  .string()
  .min(1)
  .max(DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.tokenMaxChars)
  .regex(TOKEN_PATTERN)
  .refine(noControlCharacters, { message: CONTROL_CHARACTER_MESSAGE });

const filterKeySchema = z
  .string()
  .min(1)
  .max(DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.filterKeyMaxChars)
  .regex(FILTER_KEY_PATTERN)
  .refine(noControlCharacters, { message: CONTROL_CHARACTER_MESSAGE });

/**
 * A filter value is the ONLY genuinely free-text field in the selector, so it is
 * bounded hard here and redacted + delimiter-neutralised again on the way out.
 */
const filterValueSchema = z
  .string()
  .min(1)
  .max(DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.filterValueMaxChars)
  .refine(noControlCharacters, { message: CONTROL_CHARACTER_MESSAGE });

/**
 * The untrusted, client-supplied selector. `.strict()` is load-bearing: an
 * unknown key is a REJECTION, not something to ignore, so no future client can
 * quietly open a second serialization channel through this object.
 */
export const diagnosticsPageSelectorSchema = z
  .object({
    routeKey: routeKeySchema,
    recordId: recordIdSchema.optional(),
    tab: tokenSchema.optional(),
    step: tokenSchema.optional(),
    status: tokenSchema.optional(),
    errorCode: tokenSchema.optional(),
    /**
     * NOTE: a `record` cannot refuse every key by itself — zod never surfaces
     * `__proto__` to the key schema, and it vanishes rather than being rejected.
     * `parse.ts` refuses reserved keys on the RAW input before this schema runs,
     * so a selector must go through `parseDiagnosticsPageSelector` and never
     * through this schema alone.
     */
    filters: z
      .record(filterKeySchema, filterValueSchema)
      .refine(
        (value) =>
          Object.keys(value).length <=
          DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.maxFilters,
        { message: "too many filters" },
      )
      .optional(),
    /**
     * ADR-004 §1 opt-in. Absent or `false` means identifying fields are withheld
     * and an explicit omission notice is returned instead. There is deliberately
     * no "include everything" mode and no server-side default that flips this on.
     */
    includeSensitiveRecord: z.boolean().optional(),
  })
  .strict();

export type DiagnosticsPageSelector = z.infer<
  typeof diagnosticsPageSelectorSchema
>;

/** The record kinds a page-context re-fetch may read. Closed set, server-owned. */
export const DIAGNOSTICS_RECORD_KINDS = [
  "booking",
  "member",
  "payment",
] as const;

export type DiagnosticsRecordKind = (typeof DIAGNOSTICS_RECORD_KINDS)[number];

/**
 * Why a resolution produced no (or partial) evidence. Every value is a stable
 * machine code; the operator-facing sentence travels beside it so the UI never
 * has to invent one and the model never has to guess.
 */
export type DiagnosticsPageContextReason =
  | "invalid_selector"
  | "unknown_route"
  /** The acting member row does not exist (a stale or forged acting member id). */
  | "actor_unresolved"
  /**
   * The role read itself failed. Kept distinct from `actor_unresolved` so a
   * database fault and an authorization anomaly are not the same audit row —
   * both still deny, and neither ever produces an empty-matrix pass.
   */
  | "actor_read_failed"
  | "permission_denied"
  | "record_not_found"
  | "lookup_failed";

export type DiagnosticsPageContextOmissionCode =
  | "sensitive_opt_out"
  | "permission_denied"
  | "record_not_found";

export interface DiagnosticsPageContextOmission {
  code: DiagnosticsPageContextOmissionCode;
  /** Plain-English, safe to show an operator verbatim. Never echoes input. */
  message: string;
  /** Set when the omission is a permission one. */
  area?: AdminPermissionArea;
}

/** One re-derived fact. `value` is already redacted, bounded, and stringified. */
export interface DiagnosticsPageContextFact {
  /** Stable machine key, e.g. `booking.status`. */
  key: string;
  value: string;
  /** True when the fact is an identifying/personal field surfaced by opt-in. */
  sensitive: boolean;
}

export interface DiagnosticsPageContextRecord {
  kind: DiagnosticsRecordKind;
  /**
   * The record id, echoed for the operator's own citation. It is the id THEY
   * supplied for the page they are already on, and it is validated against
   * `RECORD_ID_PATTERN`. Audit rows never get this — they get `recordRefHash`.
   */
  id: string;
  /** True only when the caller opted in AND the identifying fields were read. */
  sensitiveIncluded: boolean;
  facts: DiagnosticsPageContextFact[];
  /** ISO-8601 instant the projection was read (ADR-003 §3). */
  observedAt: string;
}

/**
 * The APPROVED audit metadata for one page-context resolution (ADR-004 §4).
 * Deliberately a separate object from the evidence so a caller that persists an
 * audit row cannot accidentally persist a fact value: nothing here is, or is
 * derived from, a field's contents.
 */
export interface DiagnosticsPageContextAudit {
  /**
   * The route that was VALIDATED, even on an exit that withheld it from the
   * evidence — a burst of actor failures is only triageable if the surface they
   * hit is recorded. Null only when no valid route was ever established.
   */
  routeKey: string | null;
  areasChecked: AdminPermissionArea[];
  authOutcome: "allowed" | "denied";
  /**
   * The record kind that was ATTEMPTED, not the one that was found. A lookup
   * that missed still records its kind and hash: an audit row that looked like
   * "no record was requested" would make id enumeration through this path
   * unattributable, because almost every probe in a sweep is a miss.
   */
  recordKind: DiagnosticsRecordKind | null;
  /**
   * sha256 of `${kind}:${id}` for the ATTEMPTED reference — never the raw id,
   * and never omitted merely because the record was not found. Null only when
   * the resolution named no record at all.
   */
  recordRefHash: string | null;
  factCount: number;
  /** UTF-8 byte length of the rendered evidence block. */
  byteCount: number;
  observedAt: string;
}

/** The route identity echoed into the evidence. All three values are server-owned. */
export interface DiagnosticsPageContextRouteRef {
  key: string;
  pathname: string;
  label: string;
}

/** Route-allowlisted view tokens, re-emitted after validation. */
export interface DiagnosticsPageSelection {
  tab?: string;
  step?: string;
  status?: string;
  errorCode?: string;
  filters?: Record<string, string>;
}

/**
 * The resolved page context. One shape for all three outcomes so a caller can
 * never forget to handle a failure branch, and so the audit metadata exists even
 * when nothing was resolved.
 *
 * `status`:
 *  - `resolved`  — the caller held every required area; `route` is set and the
 *                  facts (possibly none) are current as at `observedAt`.
 *  - `denied`    — authorization failed; NO page facts are present.
 *  - `unavailable` — the selector was malformed, the route unknown, the acting
 *                  member unresolvable (absent, or their roles unreadable), or
 *                  the projection read failed.
 */
export interface DiagnosticsPageContext {
  schemaVersion: typeof DIAGNOSTICS_PAGE_CONTEXT_SCHEMA_VERSION;
  status: "resolved" | "denied" | "unavailable";
  reason: DiagnosticsPageContextReason | null;
  route: DiagnosticsPageContextRouteRef | null;
  selection: DiagnosticsPageSelection;
  record: DiagnosticsPageContextRecord | null;
  omissions: DiagnosticsPageContextOmission[];
  observedAt: string;
  audit: DiagnosticsPageContextAudit;
}

/**
 * Operator-facing copy for the sensitive-record opt-in (ADR-004 §1). It lives
 * here, next to the contract it explains, so the Diagnostics UI (AID-7, #2378)
 * renders the SAME words the resolver enforces — a checkbox whose label
 * disagrees with the server's behaviour is worse than no checkbox.
 */
export const DIAGNOSTICS_SENSITIVE_INCLUSION_COPY = {
  /** Checkbox label. */
  label: "Include this record's personal details",
  /** Helper text under the checkbox. */
  description:
    "Off by default. When you tick this, the specific record you are looking at — and only that record — has its identifying details (such as a person's name) included in the question sent to the AI provider. Everything else stays non-identifying.",
  /** The notice returned, and shown, whenever the opt-in was NOT given. */
  omittedNotice:
    "Personal detail omitted. Tick “Include this record's personal details” to include the identifying fields for this record.",
} as const;
