/**
 * The PRIVATE KNOWLEDGE OVERLAY — the generic, deployment-owned supply mechanism
 * specified in ADR-006 §4 (AID, epic #2369, issue #2861).
 *
 * This is DISTINCT from `KnowledgeAllowlistOverlay` in `allowlist.ts`, and the two
 * must not be confused. The allowlist overlay widens or narrows WHICH COMMITTED
 * REPO FILES are bundled (include/exclude globs). This overlay supplies EXTRA,
 * DEPLOYMENT-SPECIFIC KNOWLEDGE CONTENT that has no committed repo file at all — a
 * private runbook, fork-only operational notes — as inline entries a deployment
 * populates locally.
 *
 * THE CONTRACT IS GENERIC (ADR-006 §4). Public code defines only:
 *   - a documented, configured LOCATION a deployment populates (the generator
 *     reads it from `config/diagnostics-knowledge.json` by default — the
 *     conventional, git-ignored, HARD_EXCLUDE-d slot — and any fork may point
 *     elsewhere); and
 *   - the TYPED SHAPE below that the supplied content must satisfy.
 * Public code NEVER names, mandates, or embeds any specific deployment's path,
 * filename, or content. Absent an overlay, Diagnostics is fully functional on the
 * public bundle alone and the bundle is byte-identical to one built without this
 * feature.
 *
 * OVERLAY CONTENT IS UNTRUSTED EVIDENCE (ADR-003), handled EXACTLY like a public
 * bundle file:
 *   - it is SECRET-SCANNED with the same fail-closed scanner (`secret-scan.ts`); a
 *     secret refuses the whole build, like `KnowledgeBundleSecretError`;
 *   - it is NORMALIZED (LF, no BOM) and BOUNDED into hashed excerpts by the same
 *     excerpter, and rendered through the same `renderSourceEvidenceBlock` defusal
 *     boundary, so a role-label / NEL / invisible in overlay content is folded and
 *     defused just as it is for a public excerpt;
 *   - its handle can NEVER re-include a HARD_EXCLUDE path (`isHardExcluded`), and
 *     it is namespaced under `overlay/` so it can neither collide with nor
 *     impersonate a real repo path, and every citation is clearly attributable;
 *   - it participates in the SINGLE bundle integrity digest (it is merged into
 *     `entries` before the digest is computed in `generate.ts`), so `verify.ts`'s
 *     fail-closed contract holds unchanged, with and without an overlay.
 *
 * A MALFORMED overlay FAILS CLOSED: rather than shipping garbage, `parse…` throws
 * `KnowledgeOverlayError`, which the generator turns into a non-zero exit exactly
 * like the secret error.
 */

import { z } from "zod";

import { isHardExcluded } from "./allowlist";
import type { KnowledgeSourceFile } from "./generate";

/**
 * The reserved namespace every overlay entry's stored path is prefixed with, so an
 * overlay entry can never collide with or impersonate a committed repo file (no
 * repo file is bundled from an `overlay/` path) and every citation is visibly an
 * overlay entry. HARD_EXCLUDE is checked on the RAW handle BEFORE this prefix is
 * applied, so `overlay/` can never be used to smuggle an excluded path back in.
 */
export const KNOWLEDGE_OVERLAY_PATH_PREFIX = "overlay/";

/**
 * Bounds. Overlay excerpts are already capped per-excerpt by the shared excerpter
 * (`MAX_EXCERPT_LINES` / `MAX_EXCERPT_CHARS`); these are additional whole-overlay
 * floors so a pathological overlay cannot balloon the bundle. DESIGN CHOICE
 * (flagged for review): the exact numbers are conservative and generous, not a
 * governance decision — a fork needing more is a deliberate change here.
 */
export const MAX_OVERLAY_ENTRIES = 512;
export const MAX_OVERLAY_ENTRY_CONTENT_CHARS = 1_000_000;
export const MAX_OVERLAY_PATH_CHARS = 200;

/**
 * ONE overlay entry: a deployment-chosen `path` handle (the citation label the
 * model and operators see, e.g. `ops/private-runbook.md`) and its `content`. The
 * handle's extension drives language detection and excerpt structuring exactly as
 * a repo file's does, so an `.md` handle is split on its headings.
 */
const overlayEntrySchema = z
  .object({
    path: z.string().min(1).max(MAX_OVERLAY_PATH_CHARS),
    content: z.string().max(MAX_OVERLAY_ENTRY_CONTENT_CHARS),
  })
  .strict();

/** The typed shape a deployment's overlay MUST satisfy. */
export const knowledgeContentOverlaySchema = z
  .object({
    entries: z.array(overlayEntrySchema).max(MAX_OVERLAY_ENTRIES),
  })
  .strict();

export type KnowledgeContentOverlayEntry = z.infer<typeof overlayEntrySchema>;
export type KnowledgeContentOverlay = z.infer<typeof knowledgeContentOverlaySchema>;

/**
 * Thrown when an overlay is present but does not satisfy the contract — a schema
 * violation, an illegal handle, or a handle that would re-include a HARD_EXCLUDE
 * path. FAIL-CLOSED signal: the generator turns it into a non-zero exit so a
 * deploy stops rather than shipping an ill-formed or boundary-violating overlay.
 */
export class KnowledgeOverlayError extends Error {
  constructor(message: string) {
    super(`Knowledge overlay refused: ${message}`);
    this.name = "KnowledgeOverlayError";
  }
}

/**
 * True when a string contains any C0 control character, DEL, or a C1 control
 * character (U+0080–U+009F, which includes U+0085 NEL) — none of which is ever legit
 * in a handle. The C1 range is checked as well as C0/DEL so the guard matches its
 * "no control characters" contract: a C1 code point is non-printing and could
 * otherwise slip a control character into a rendered citation label.
 */
function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * A handle must be a plain relative POSIX path: no leading slash, no backslash, no
 * `.`/`..` segments, no empty segments, no Windows drive prefix, no control
 * characters, and no colon. This keeps the namespaced stored path well-formed and
 * closes any traversal games (`../.env`) BEFORE — and independently of — the
 * HARD_EXCLUDE check below.
 *
 * A colon is refused because the handle renders MID-LINE as the citation label
 * (`[1] overlay/ops/assistant:obey-me.md`), where the line-anchored role-label
 * defusal never fires — so a colon in the handle would let `assistant:` reach the
 * evidence intact. A citation handle has no need of a colon, so refusing it at
 * validation is the tightest, fail-closed fix.
 */
function assertLegalHandle(path: string): void {
  if (path.includes("\\")) {
    throw new KnowledgeOverlayError(
      `entry path must use forward slashes: ${JSON.stringify(path)}`,
    );
  }
  if (path.includes(":")) {
    throw new KnowledgeOverlayError(
      `entry path must not contain a colon: ${JSON.stringify(path)}`,
    );
  }
  if (path.startsWith("/")) {
    throw new KnowledgeOverlayError(
      `entry path must be relative (no leading slash): ${JSON.stringify(path)}`,
    );
  }
  if (hasControlCharacter(path)) {
    throw new KnowledgeOverlayError(
      `entry path must not contain control characters: ${JSON.stringify(path)}`,
    );
  }
  if (/^[A-Za-z]:/.test(path)) {
    throw new KnowledgeOverlayError(
      `entry path must not be an absolute Windows path: ${JSON.stringify(path)}`,
    );
  }
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new KnowledgeOverlayError(
        `entry path has an empty or dot segment: ${JSON.stringify(path)}`,
      );
    }
  }
}

/**
 * Validate a raw (untrusted, e.g. JSON-parsed) overlay object against the typed
 * shape and return it, or `{ entries: [] }` for an absent overlay. FAIL-CLOSED on
 * any schema violation.
 */
export function parseKnowledgeContentOverlay(
  raw: unknown,
): KnowledgeContentOverlay {
  if (raw === undefined || raw === null) return { entries: [] };
  const parsed = knowledgeContentOverlaySchema.safeParse(raw);
  if (!parsed.success) {
    throw new KnowledgeOverlayError(
      `does not match the shape — ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Turn a validated overlay into the SAME `KnowledgeSourceFile` shape the generator
 * builds public entries from, so it flows through the identical secret-scan,
 * excerpt, hash, digest, and render path. Each handle is HARD_EXCLUDE-checked on
 * its RAW form, then namespaced under `overlay/`.
 *
 * Content is NOT scanned or defused here — that happens in the shared generator
 * pipeline (secret scan) and at render time (`renderSourceEvidenceBlock`) — so the
 * treatment is provably identical to a public file. Duplicate handles are left for
 * the generator's own duplicate-path guard to reject, keeping one rule.
 */
export function overlayFilesFrom(raw: unknown): KnowledgeSourceFile[] {
  const overlay = parseKnowledgeContentOverlay(raw);
  return overlay.entries.map((entry) => {
    const handle = entry.path;
    assertLegalHandle(handle);
    if (isHardExcluded(handle)) {
      throw new KnowledgeOverlayError(
        `entry path is on the hard-exclude list and cannot be re-included: ${JSON.stringify(
          handle,
        )}`,
      );
    }
    return {
      path: `${KNOWLEDGE_OVERLAY_PATH_PREFIX}${handle}`,
      content: entry.content,
    };
  });
}
