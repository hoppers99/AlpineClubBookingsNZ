/**
 * Canonical serialization + integrity digest for the knowledge bundle (AID-3),
 * shared by the generator (writes + signs) and the loader (reads + verifies) so
 * both compute bytes and digests the SAME way.
 */

import { canonicalStringify, sha256Hex } from "./hash";
import type { KnowledgeBundle, KnowledgeEntry } from "./types";

/**
 * The integrity digest covers the ENTRIES ONLY (not `meta`). This makes it
 * stable across two builds of byte-identical source at different commits/times,
 * and is exactly the surface a tamper would have to alter to change an answer.
 */
export function computeEntriesDigest(entries: readonly KnowledgeEntry[]): string {
  return sha256Hex(canonicalStringify(entries));
}

/** Serialize a bundle to its canonical on-disk bytes (deterministic). */
export function serializeBundle(bundle: KnowledgeBundle): string {
  return canonicalStringify(bundle);
}
