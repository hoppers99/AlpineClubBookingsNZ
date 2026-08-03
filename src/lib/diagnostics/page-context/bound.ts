/**
 * AI Diagnostics — the ONE bounding path for page-context free text (AID-4,
 * #2373; ADR-004 §2).
 *
 * Every free-text value that can reach the model — a re-fetched database column
 * (`projections.ts`) and the operator's own filter values (`resolve.ts`) — is
 * redacted first and then hard-capped here. It lives in its own module because it
 * was previously duplicated verbatim in both callers, and two copies of a security
 * control are one edit away from disagreeing.
 */

import "server-only";

import { redactSensitiveText } from "@/lib/redact-sensitive-json";

import { DIAGNOSTICS_PAGE_CONTEXT_BOUNDS } from "./types";

/**
 * Redact, then hard-bound. Truncation is marked with an ellipsis so the model
 * cannot read a cut-off value as a whole one.
 */
export function boundedRedacted(value: string): string {
  const redacted = redactSensitiveText(value).trim();
  const max = DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.factValueMaxChars;
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}
