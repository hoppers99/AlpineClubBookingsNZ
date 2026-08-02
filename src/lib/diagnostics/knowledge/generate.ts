/**
 * PURE generator for the deployed-code knowledge bundle (AID-3, #2372).
 *
 * `buildKnowledgeBundle` is a pure function of its inputs — no filesystem, no
 * network, no database, no wall clock. Given the same `files`, `commitSha`, and
 * `observedAt` it returns a byte-identical bundle (input file ORDER does not
 * matter; files are sorted by path). This is what makes the artifact reproducible
 * and what the determinism tests assert.
 *
 * FAIL CLOSED: if any included file trips the secret scanner, the whole build
 * throws `KnowledgeBundleSecretError` — the bundle is never emitted with the
 * offending file dropped, because a partial bundle would silently hide the leak.
 * The thin script wrapper (`scripts/diagnostics/generate-knowledge-bundle.ts`)
 * turns that throw into a non-zero exit, so a real deploy fails closed.
 */

import {
  isAllowlisted,
  resolveAllowlist,
  type KnowledgeAllowlistOverlay,
} from "./allowlist";
import { buildExcerpts } from "./excerpt";
import { normalizeContent, sha256Hex } from "./hash";
import { scanForSecrets, type SecretFinding } from "./secret-scan";
import { classifySensitivity } from "./sensitivity";
import { computeEntriesDigest } from "./serialize";
import {
  KNOWLEDGE_BUNDLE_SCHEMA_VERSION,
  KNOWLEDGE_BUNDLE_HASH_ALGORITHM,
  type KnowledgeBundle,
  type KnowledgeEntry,
} from "./types";

export const KNOWLEDGE_BUNDLE_GENERATOR = `knowledge-bundle/v${KNOWLEDGE_BUNDLE_SCHEMA_VERSION}`;

export interface KnowledgeSourceFile {
  /** Repo-relative POSIX path. */
  path: string;
  /** Raw file content (normalized internally before hashing/excerpting). */
  content: string;
}

export interface BuildKnowledgeBundleInput {
  files: ReadonlyArray<KnowledgeSourceFile>;
  /** Deployed commit SHA (validity is enforced at LOAD, not here). */
  commitSha: string;
  /** Explicit ISO-8601 observed-at (never read from the clock here). */
  observedAt: string;
  /** Optional deployment-owned allowlist widening/narrowing. */
  overlay?: KnowledgeAllowlistOverlay;
}

/** Thrown when a secret would enter the bundle. Fail-closed signal. */
export class KnowledgeBundleSecretError extends Error {
  readonly findings: Array<{ path: string; finding: SecretFinding }>;
  constructor(findings: Array<{ path: string; finding: SecretFinding }>) {
    const summary = findings
      .map((f) => `${f.path}:${f.finding.line} (${f.finding.rule}: ${f.finding.preview})`)
      .join(", ");
    super(`Knowledge bundle generation refused: secret material detected — ${summary}`);
    this.name = "KnowledgeBundleSecretError";
    this.findings = findings;
  }
}

function buildEntry(file: KnowledgeSourceFile): KnowledgeEntry {
  const content = normalizeContent(file.content);
  const { language, symbols, excerpts } = buildExcerpts(file.path, content);
  const lineCount =
    content === ""
      ? 0
      : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

  return {
    path: file.path,
    language,
    contentHash: sha256Hex(content),
    byteLength: Buffer.byteLength(content, "utf8"),
    lineCount,
    sensitivity: classifySensitivity(file.path, language),
    symbols,
    excerpts,
  };
}

/**
 * Build the deterministic knowledge bundle. Files are (defensively) re-filtered
 * through the resolved allowlist, secret-scanned (fail closed), sorted by path,
 * and de-duplicated (a duplicate path is a fatal input error). The returned
 * bundle carries an integrity digest over the entries.
 */
export function buildKnowledgeBundle(
  input: BuildKnowledgeBundleInput,
): KnowledgeBundle {
  const allowlist = resolveAllowlist(input.overlay);

  // Defense in depth: even though the script pre-filters, only allowlisted paths
  // are ever considered here.
  const candidates = input.files.filter((f) => isAllowlisted(f.path, allowlist));

  // Reject duplicate paths outright — silently keeping "the last one" would make
  // the output depend on input order, breaking determinism.
  const seen = new Set<string>();
  for (const f of candidates) {
    if (seen.has(f.path)) {
      throw new Error(`Duplicate path in knowledge bundle input: ${f.path}`);
    }
    seen.add(f.path);
  }

  // Secret scan every included file BEFORE building anything. Fail closed.
  const secretFindings: Array<{ path: string; finding: SecretFinding }> = [];
  for (const f of candidates) {
    for (const finding of scanForSecrets(normalizeContent(f.content))) {
      secretFindings.push({ path: f.path, finding });
    }
  }
  if (secretFindings.length > 0) {
    throw new KnowledgeBundleSecretError(secretFindings);
  }

  const entries = candidates
    .map(buildEntry)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    schemaVersion: KNOWLEDGE_BUNDLE_SCHEMA_VERSION,
    meta: {
      commitSha: input.commitSha,
      observedAt: input.observedAt,
      generator: KNOWLEDGE_BUNDLE_GENERATOR,
      entryCount: entries.length,
    },
    integrity: {
      algorithm: KNOWLEDGE_BUNDLE_HASH_ALGORITHM,
      entriesDigest: computeEntriesDigest(entries),
    },
    entries,
  };
}
