// Runtime import guard: a small, single-source-of-truth registry of the exact
// byte-strings that "cleanup" migrations removed from the starter/seed data,
// paired with the migration that removed each.
//
// WHY THIS EXISTS (#2511, found by the #2431 review)
//
// A config-transfer bundle exported BEFORE a cleanup migration still carries the
// old value: the exporter selects the DB column verbatim (see
// `categories/site-content.ts` — `pageContent.findMany`/`siteContent.findMany`
// select `headerText`/`contentHtml` as-is), and the applier writes it straight
// back with `pageContent.update` / `siteContent.update`, in BOTH import modes
// (merge only skips fields that are blank in the bundle, and these are full
// values). The boot auto-import (ADR-003) runs AFTER migrations —
// `bootstrap-import.ts` states the order: migrations -> base seed -> boot
// auto-import -> operational site — so a disaster-recovery rebuild or any
// interactive restore of a pre-cleanup bundle re-plants the cleaned value
// PERMANENTLY: the one-shot migration has already run and never corrects the
// row again.
//
// THE GUARD
//
// On import (both the boot auto-import and the interactive admin path) the
// site-content planner + applier ask this module whether a bundle row's RAW
// value byte-matches a cleaned literal for that (entity, key, field). When it
// does, the applier SKIPS writing that one field — leaving the cleaned state the
// migration established — and the planner surfaces a named warning row in the
// dry-run. Every OTHER field in the same bundle imports normally, and a club's
// OWN customised value never matches the exact literal, so it is imported
// untouched. The boot auto-import is unattended, so "skip" is the fail-safe
// shape by construction: it cannot re-plant, and it needs no operator decision.
//
// VALUE-SCOPED, NOT ROW-SCOPED — exactly like the migrations. The match is on
// the exact planted bytes, so a club that typed its own hero/footer/address (or
// merely reworded part of the planted one) keeps it byte for byte. This mirrors
// each cleanup migration's own `WHERE "<field>" = '<literal>'` predicate.
//
// The literals below are asserted byte-for-byte against the migrations'
// `migration.sql` by `config-transfer-cleaned-literals.test.ts`, so the registry
// and the migrations can never drift apart silently.

/** One planted value that a cleanup migration removed. */
export interface CleanedLiteral {
  /**
   * The config-transfer registry entity whose row carried the literal
   * (`registerEntity({ entity })`), e.g. `"page-content"`.
   */
  entity: string;
  /**
   * The natural-key value of the guarded row (the page slug, the site-content
   * key). `null` means "any row of this entity" — used where the cleanup was
   * purely value-scoped across every row of a table (e.g. the lodge address,
   * which the migration clears from the default lodge AND any additional one).
   */
  key: string | null;
  /** The field on that row that carried the literal, e.g. `"headerText"`. */
  field: string;
  /**
   * The EXACT byte string the cleanup migration removed. The exporter emits the
   * DB column verbatim, so a pre-cleanup bundle carries these exact bytes.
   */
  literal: string;
  /** The cleanup migration directory that removed it. */
  migration: string;
  /** The tracking issue for the cleanup. */
  issue: string;
  /** Operator-facing description of what the bundle would restore. */
  describe: string;
}

/**
 * Every cleaned literal the config-transfer import path must refuse to re-plant.
 * One source of truth; extend it whenever a new value-scoped cleanup migration
 * removes starter/seed content that a config bundle round-trips.
 */
export const CLEANED_LITERALS: readonly CleanedLiteral[] = [
  {
    // #2431 — 20260802150000_update_starter_home_guest_copy rewrote the starter
    // "/home" hero (and, via generateMetadata, the front-page meta description)
    // so the reference release stops advertising guest booking.
    entity: "page-content",
    key: "home",
    field: "headerText",
    literal:
      "Our club lodge welcomes members and guests year-round. Book a stay, " +
      "join the club, and explore New Zealand's mountains.",
    migration: "20260802150000_update_starter_home_guest_copy",
    issue: "#2431",
    describe: "the front-page hero that advertised guest booking",
  },
  {
    // #2490 — 20260802140000_clear_starter_footer_affiliations cleared the
    // starter footer affiliations that named the Ruapehu Mountain Clubs
    // Association (RMCA), a regional body a fresh install does not belong to.
    entity: "site-content",
    key: "FOOTER_AFFILIATIONS",
    field: "contentHtml",
    literal:
      '<h3>Affiliations</h3><ul><li><a href="https://www.fmc.org.nz/" target="_blank" rel="noopener noreferrer">Federated Mountain Clubs (FMC)</a></li><li><a href="https://rmca.org.nz/" target="_blank" rel="noopener noreferrer">Ruapehu Mountain Clubs Association (RMCA)</a></li><li><a href="{{facebook-url}}" target="_blank" rel="noopener noreferrer">Facebook</a></li></ul>',
    migration: "20260802140000_clear_starter_footer_affiliations",
    issue: "#2490",
    describe:
      "the starter footer affiliations naming the Ruapehu Mountain Clubs Association (RMCA)",
  },
  {
    // #2484 — 20260802110000_clear_waldvogel_lodge_address cleared the founding
    // club's real lodge address that the migration chain stamped onto the
    // default Lodge row. Registered here defensively: `Lodge.address` is NOT in
    // the config-transfer bundle today (it is absent from LODGE_FIELDS in
    // `categories/lodge-config.ts`), so this entry is DORMANT — nothing in a
    // bundle can carry it. It is kept in the one registry so that if `address`
    // is ever added to LODGE_FIELDS, wiring the same guard into the lodge
    // applier immediately closes the exposure. Value-scoped across every lodge
    // row (`key: null`), matching the migration's row-agnostic predicate.
    entity: "lodge",
    key: null,
    field: "address",
    literal: "Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand",
    migration: "20260802110000_clear_waldvogel_lodge_address",
    issue: "#2484",
    describe: "another club's lodge address (Waldvogel Lodge)",
  },
];

/** A detected re-plant attempt: a bundle field that byte-matches a cleaned literal. */
export interface CleanedLiteralHit {
  entity: string;
  /** The row key that matched, or `""` for an any-row (`key: null`) literal. */
  key: string;
  field: string;
  migration: string;
  issue: string;
  describe: string;
}

/**
 * Cleaned literals that could apply to a row of `entity` keyed `rowKey` — the
 * entity-specific slice of the registry, so a caller only scans what is
 * relevant. An entity with no cleaned literals returns an empty list.
 */
function literalsFor(entity: string, rowKey: string): readonly CleanedLiteral[] {
  return CLEANED_LITERALS.filter(
    (l) => l.entity === entity && (l.key === null || l.key === rowKey),
  );
}

/**
 * Detect cleaned-literal re-plants in a bundle row's RAW values. Returns one hit
 * per field whose raw bundle value byte-matches a cleaned literal for
 * (entity, rowKey). Matching is on the RAW bundle value — the exporter writes
 * the DB column verbatim, so a pre-cleanup bundle carries the exact removed
 * bytes, and the CSV/JSON round-trip preserves them. Read-only; never mutates.
 */
export function detectCleanedLiterals(
  entity: string,
  rowKey: string,
  raw: Record<string, unknown>,
): CleanedLiteralHit[] {
  const hits: CleanedLiteralHit[] = [];
  for (const literal of literalsFor(entity, rowKey)) {
    if (!(literal.field in raw)) continue;
    const value = raw[literal.field];
    if (typeof value !== "string") continue;
    if (value !== literal.literal) continue;
    hits.push({
      entity: literal.entity,
      key: rowKey,
      field: literal.field,
      migration: literal.migration,
      issue: literal.issue,
      describe: literal.describe,
    });
  }
  return hits;
}

/**
 * Strip any cleaned-literal fields from a write payload, keyed by (entity,
 * rowKey), matching on the row's RAW bundle values. Returns a shallow copy with
 * the matched fields removed plus the hits, so the caller can surface a warning
 * for each. The removed field is simply not written: on an existing row this
 * leaves the cleaned state the migration established; every other field is
 * untouched. Does not mutate its inputs.
 *
 * The returned `write` keeps the input type `T` even though a stripped field is
 * absent at runtime: the only rows a cleaned literal can strip are always
 * present in the base seed (so imports of them are UPDATEs, where a missing
 * field is exactly the intended "leave it" semantics), and every non-stripped
 * call returns the object unchanged. A stripped CREATE is unreachable on the
 * real path; were it ever reached, the missing field would surface as a normal
 * apply error and roll the transaction back — still fail-safe (never a
 * re-plant).
 */
export function stripCleanedLiterals<T extends Record<string, unknown>>(
  entity: string,
  rowKey: string,
  raw: Record<string, unknown>,
  write: T,
): { write: T; hits: CleanedLiteralHit[] } {
  const hits = detectCleanedLiterals(entity, rowKey, raw);
  if (hits.length === 0) return { write, hits };
  const out: Record<string, unknown> = { ...write };
  for (const hit of hits) {
    delete out[hit.field];
  }
  return { write: out as T, hits };
}

/** The operator-facing dry-run warning for one detected re-plant. */
export function cleanedLiteralWarning(hit: CleanedLiteralHit): string {
  return (
    `This bundle would restore ${hit.describe}, which a cleanup migration ` +
    `(${hit.migration}, ${hit.issue}) removed. That value is being skipped and ` +
    `the current content kept — re-export the bundle after upgrading to clear ` +
    `this warning.`
  );
}
