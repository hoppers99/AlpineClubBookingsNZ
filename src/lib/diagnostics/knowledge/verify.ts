/**
 * PURE verification of a knowledge bundle (AID-3, #2372). No filesystem, no
 * `server-only` — so scripts, build checks, and the runtime loader all share one
 * fail-closed decision procedure. `load.ts` adds the disk read on top of this.
 *
 * FAIL CLOSED: any deviation — schema-invalid, count mismatch, integrity digest
 * mismatch, a tampered excerpt hash, or an unverified commit SHA (including the
 * build-time placeholder) — returns `{ ok: false }`. There is no "close enough".
 */

import { sha256Hex } from "./hash";
import { computeEntriesDigest } from "./serialize";
import {
  COMMIT_SHA_PATTERN,
  KNOWLEDGE_BUNDLE_PLACEHOLDER_SHA,
  knowledgeBundleSchema,
  type KnowledgeBundle,
} from "./types";

export type KnowledgeBundleLoadFailure =
  | "missing"
  | "malformed"
  | "invalid-schema"
  | "integrity-mismatch"
  | "excerpt-hash-mismatch"
  | "count-mismatch"
  | "unverified-commit";

export type KnowledgeBundleLoadResult =
  | { ok: true; bundle: KnowledgeBundle }
  | { ok: false; reason: KnowledgeBundleLoadFailure; detail?: string };

/** True only for a real, lowercase, non-zero git SHA-1 (rejects the placeholder). */
export function isVerifiedCommitSha(sha: string): boolean {
  return COMMIT_SHA_PATTERN.test(sha) && sha !== KNOWLEDGE_BUNDLE_PLACEHOLDER_SHA;
}

/**
 * Verify an already-parsed bundle object. Pure and total — never throws — so the
 * caller always gets a decision, not an exception.
 */
export function verifyBundleObject(raw: unknown): KnowledgeBundleLoadResult {
  const parsed = knowledgeBundleSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid-schema", detail: parsed.error.message };
  }
  const bundle = parsed.data as KnowledgeBundle;

  // Cheap tripwire before the O(n) hashing.
  if (bundle.meta.entryCount !== bundle.entries.length) {
    return {
      ok: false,
      reason: "count-mismatch",
      detail: `meta.entryCount=${bundle.meta.entryCount} entries=${bundle.entries.length}`,
    };
  }

  // Whole-bundle integrity: the entries must hash to the recorded digest.
  const recomputed = computeEntriesDigest(bundle.entries);
  if (recomputed !== bundle.integrity.entriesDigest) {
    return { ok: false, reason: "integrity-mismatch" };
  }

  // Per-excerpt tamper check: every excerpt's stored text must hash to its
  // stored hash. Catches a swapped/edited excerpt that left the hash stale.
  for (const entry of bundle.entries) {
    for (const excerpt of entry.excerpts) {
      if (sha256Hex(excerpt.text) !== excerpt.hash) {
        return { ok: false, reason: "excerpt-hash-mismatch", detail: excerpt.id };
      }
    }
  }

  // The commit SHA must be a real, verified git SHA — the placeholder and any
  // malformed/zero SHA fail closed.
  if (!isVerifiedCommitSha(bundle.meta.commitSha)) {
    return { ok: false, reason: "unverified-commit", detail: bundle.meta.commitSha };
  }

  return { ok: true, bundle };
}
