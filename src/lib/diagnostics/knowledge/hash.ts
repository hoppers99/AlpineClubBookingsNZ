/**
 * Deterministic hashing + canonical JSON for the knowledge bundle (AID-3).
 *
 * DETERMINISM is a security property here, not a nicety: the bundle's integrity
 * digest, every content/excerpt hash, and citation verification all depend on
 * the SAME bytes being produced from the same input on every machine. Two things
 * make that true regardless of OS or object-construction order:
 *  - `normalizeContent` collapses CRLF/CR to LF and strips a leading BOM, so a
 *    Windows checkout and a Linux CI runner hash the same file identically.
 *  - `canonicalStringify` sorts object keys recursively and pins indentation, so
 *    object key order can never shift the bytes.
 */

import { createHash } from "node:crypto";

/**
 * Normalize file/excerpt text before hashing or excerpting: LF-only newlines,
 * no leading UTF-8 BOM. Never trims content — line numbers must stay faithful.
 */
export function normalizeContent(raw: string): string {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function sortKeysDeep(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  // Primitives pass through; JSON.stringify rejects undefined/functions, which is
  // correct — the bundle is plain data.
  return value as JsonValue;
}

/**
 * Canonical JSON: recursively key-sorted, 2-space indented, LF newlines, with a
 * single trailing newline. `serializeBundle` uses this so the ON-DISK bundle is
 * byte-identical for identical inputs; array ORDER is preserved (callers sort
 * arrays explicitly where order carries meaning).
 */
export function canonicalStringify(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}
