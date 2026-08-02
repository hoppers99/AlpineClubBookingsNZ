/**
 * Runtime LOADER for the deployed-code knowledge bundle (AID-3, #2372).
 *
 * FAIL CLOSED is the entire contract. A caller (the later Diagnostics tool,
 * #2374+) may answer code/docs/schema questions ONLY when this returns
 * `{ ok: true }`. Every other outcome — file missing, malformed, schema-invalid,
 * integrity digest mismatch, a tampered excerpt hash, or an unverified commit
 * SHA (including the build-time placeholder) — DISABLES code answers. There is
 * deliberately no fallback to a working tree, a live `.git` (absent in the
 * runner), or model memory: an unverifiable bundle is treated as no bundle.
 *
 * The verification logic itself is pure and lives in `verify.ts` (no fs, no
 * `server-only`) so it is exhaustively unit-testable and reusable; this module
 * only adds the disk read.
 */

import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { KNOWLEDGE_BUNDLE_RELATIVE_PATH } from "./types";
import {
  verifyBundleObject,
  type KnowledgeBundleLoadResult,
} from "./verify";

// Convenience re-export so a consumer of `loadKnowledgeBundle` can name its
// result type from one import site. (The `KnowledgeBundleLoadFailure` reason
// type is named directly from `./verify` by the one consumer that needs it.)
export type { KnowledgeBundleLoadResult } from "./verify";

/**
 * Resolve the on-disk bundle path. Defaults to the traced runtime path under
 * `process.cwd()` (= `/app` in the standalone runner); overridable via
 * `KNOWLEDGE_BUNDLE_PATH` for tests / non-standard layouts.
 */
export function resolveKnowledgeBundlePath(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env.KNOWLEDGE_BUNDLE_PATH;
  if (fromEnv) return fromEnv;
  return path.join(process.cwd(), KNOWLEDGE_BUNDLE_RELATIVE_PATH);
}

/**
 * Load + verify the bundle from disk. A missing file (ENOENT) is the expected
 * "diagnostics not provisioned" case and maps to `missing`; any other read or
 * parse failure maps to `malformed`. Never throws.
 */
export async function loadKnowledgeBundle(opts: {
  path?: string;
} = {}): Promise<KnowledgeBundleLoadResult> {
  const bundlePath = resolveKnowledgeBundlePath(opts.path);

  let raw: string;
  try {
    raw = await readFile(bundlePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    return {
      ok: false,
      reason: "malformed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "malformed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  return verifyBundleObject(parsed);
}
