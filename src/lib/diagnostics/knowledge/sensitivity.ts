/**
 * Sensitivity tagging for knowledge-bundle entries (AID-3).
 *
 * These tags are METADATA that downstream retrieval policy (#2374+) can use to
 * down-rank or gate excerpts — they are NOT an exclusion decision. Anything that
 * must not ship never reaches the bundle at all (`allowlist.ts` excludes it and
 * `secret-scan.ts` fails the build). Tagging is a pure function of the path
 * plus a coarse language, so it is deterministic and reviewable.
 */

import type { SensitivityTag } from "./types";

/** Path fragments that mark security-relevant modules. */
const SECURITY_FRAGMENTS = [
  "auth",
  "session",
  "permission",
  "admin-permission",
  "access-role",
  "crypto",
  "secret",
  "token",
  "password",
  "webhook",
  "rate-limit",
  "csrf",
  "nonce",
  "magic-link",
  "two-factor",
];

/** Path fragments that mark money / finance-relevant modules. */
const FINANCE_FRAGMENTS = [
  "xero",
  "stripe",
  "payment",
  "refund",
  "invoice",
  "finance",
  "credit-note",
  "ledger",
  "billing",
];

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/** Add the additive cross-cutting risk classes a path implies (mutates `tags`). */
function addRiskTags(lowerPath: string, tags: Set<SensitivityTag>): void {
  if (includesAny(lowerPath, SECURITY_FRAGMENTS)) tags.add("security-sensitive");
  if (includesAny(lowerPath, FINANCE_FRAGMENTS)) tags.add("finance-sensitive");
}

/**
 * Derive the sorted, de-duplicated sensitivity tag set for a repo-relative
 * POSIX path + coarse language. Always returns at least one base tag.
 */
export function classifySensitivity(
  path: string,
  language: string,
): SensitivityTag[] {
  const lower = path.toLowerCase();
  const tags = new Set<SensitivityTag>();

  // Base class from location / language.
  if (language === "markdown") {
    tags.add("public-docs");
  } else if (language === "prisma") {
    tags.add("schema");
  } else if (lower.startsWith("config/") || lower.includes(".env")) {
    tags.add("config-reference");
  } else {
    tags.add("source");
  }

  // Cross-cutting risk classes (additive).
  addRiskTags(lower, tags);

  return [...tags].sort();
}

/**
 * Sensitivity tags for a private-overlay entry (ADR-006 §4). The base class is
 * always `overlay` — deployment-supplied private knowledge is neither
 * `public-docs` nor first-party `source`, and mislabelling it as either would be
 * wrong for a retrieval-policy consumer — plus the SAME additive risk classes any
 * other entry gets, so an overlay entry whose handle names an `auth`/`xero` area
 * still carries `security-sensitive`/`finance-sensitive`. The `language` argument
 * is accepted for symmetry with `classifySensitivity`; the base tag never depends
 * on it here.
 */
export function classifyOverlaySensitivity(
  path: string,
  _language: string,
): SensitivityTag[] {
  const lower = path.toLowerCase();
  const tags = new Set<SensitivityTag>(["overlay"]);
  addRiskTags(lower, tags);
  return [...tags].sort();
}
