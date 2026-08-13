/**
 * TREE-WIDE CENSUS: no Diagnostics tool surface may sanitise database-derived text
 * with the NARROW control-character class, and every surface that flattens
 * untrusted free text must route it through the shared role-label defusal (#2832).
 *
 * The defect #2832 closed lived in three projection helpers and one renderer: each
 * stripped the C0 range and DEL but not the C1 block, so the NEL character — which
 * JavaScript's `\s` does not match — survived both the class and the `\s+` collapse
 * and could fake a new line, and none of them defused a forged `assistant:` turn.
 * Fixing the four known sites does not stop a FIFTH being added the same way, which
 * is what this census is for: it reads the tool-tree SOURCE and asserts a property
 * over it, not a hand-listed set of files.
 *
 * MEMBERSHIP IS DISCOVERED RECURSIVELY, NOT LISTED. The surface set is every
 * production source file (`.ts`/`.mts`/`.cts`, tests excluded) found by walking the
 * whole `tools` tree — packs, the renderer, and every other tool module, including
 * any future nested subdirectory. A hand-maintained list, or a non-recursive
 * `readdirSync` of one directory, would silently exclude a new pack or a
 * `packs/<subdir>/*.ts` — the exact failure mode a census exists to prevent — and
 * this repo has shipped a census that matched an empty set and passed vacuously
 * (#2811), so every discovered set is asserted NON-EMPTY and to contain files known
 * to exist. If discovery breaks, the census FAILS rather than passing over nothing.
 *
 * WHAT THIS CENSUS MECHANICALLY GUARANTEES, precisely, and no more:
 *
 *  1. No production source file under the tools tree carries a RAW C0/DEL control
 *     byte (detected by code point, so no control-range regex literal a formatter
 *     or git filter could normalise away — the fragility that hid the raw-byte
 *     spelling of the narrow class in review before #2832).
 *  2. No such file writes the CONTIGUOUS narrow C0 control class as a regex range,
 *     in any of the notations an evader would reach for first: the `\u`-escape
 *     form (either hex case), the `\x`-escape form (either case), or the `\c@` /
 *     `\cA`-`\c_` control-escape form. The widened primitive in `untrusted-text.ts`
 *     never writes the span contiguously — it carves tab/LF/CR out into separate
 *     sub-ranges — so this catches the defect without flagging the fix, and
 *     `untrusted-text.ts` itself sits ABOVE the tools tree and is not scanned.
 *  3. Every file that FLATTENS untrusted free text (recognised by the whitespace-
 *     collapse regex `/\s+/` and the two equivalent run-of-whitespace spellings)
 *     INVOKES both shared primitives — `foldUntrustedText(` and `defuseRoleLabels(`
 *     — rather than merely importing them.
 *
 * WHAT IT CANNOT GUARANTEE, stated so no reader mistakes a green run for a proof:
 *
 *  - A narrow control class built by a COMPUTED expression — `String.fromCharCode`,
 *    a variable holding the range, a class assembled at runtime — leaves no literal
 *    range to match and is invisible to a source-pattern census. So is a
 *    whitespace collapse spelled without `/\s+/` (e.g. `.split(/\s/).join(" ")` or
 *    an explicit `[ \t\n]+`): such a surface would not be recognised as a
 *    flattening one and so would not be held to the routing rule.
 *  - The routing check proves the two primitives are CALLED in a flattening file,
 *    not that a given call receives the specific free-text value — a file could
 *    call them on some other string. It is file-granular, not expression-granular:
 *    `emailOrNull` in `booking-shared.ts`, for instance, folds and defuses without
 *    the `/\s+/` idiom and is covered only because its sibling `personNameOrNull`
 *    already makes that file a flattening surface, not because the census sees
 *    `emailOrNull`'s own routing.
 *
 * The real, model-visible guard is the renderer's `neutralize` (`render.ts`), which
 * re-folds and defuses EVERY tool-result string before the model sees it regardless
 * of how a caller assembled the row. This census is a source-level backstop that
 * makes the COMMON regressions loud at the projection layer — where a value also
 * reaches the audit `resultHash`, which no renderer touches — not a substitute for
 * that guard.
 *
 * THE CENSUS ITSELF CONTAINS NO CONTROL CHARACTER. It detects a raw control byte by
 * CODE POINT (`charCodeAt`) and every escaped narrow class and flatten idiom by
 * plain-text `includes`, so there is no control-range regex literal a formatter or
 * git filter could normalise away — the exact fragility that hid the raw-byte
 * spelling of the narrow class in review before #2832.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const PACK_DIR = join(import.meta.dirname, "..");
const TOOLS_DIR = join(PACK_DIR, "..");

/**
 * Every production source file under the tools tree, discovered by a RECURSIVE
 * walk. `.test.ts`/`.spec.ts` are excluded because a test is allowed to CONSTRUCT
 * the narrow class (a behavioural test does, to prove a fix bites) — the property
 * is about what the shipped tools do, not what a test names — and `__tests__`
 * directories are skipped wholesale. `.mts`/`.cts` are covered so a module in
 * either spelling cannot slip discovery, and a nested subdirectory is walked so a
 * `packs/<subdir>/projector.ts` cannot either.
 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") out.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.(ts|mts|cts)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|mts|cts)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/** A stable, platform-independent label: the path relative to the tools tree. */
const labelOf = (path: string): string =>
  relative(TOOLS_DIR, path).split(sep).join("/");

const SOURCE_FILES = collectSourceFiles(TOOLS_DIR).sort();

const SURFACES: ReadonlyArray<readonly [label: string, path: string]> =
  SOURCE_FILES.map((path) => [labelOf(path), path] as const);

const sourceOf = (path: string): string => readFileSync(path, "utf8");

/**
 * A raw C0/DEL control byte in the source — tab (9), LF (10) and CR (13) excluded
 * because those are ordinary in source. Detected by code point, never by a regex
 * that would have to embed the very bytes it hunts for, which is how the finance
 * pack's narrow class was originally — and invisibly — spelt.
 */
function hasRawControlByte(source: string): boolean {
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    const isControl =
      code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
    if (isControl) return true;
  }
  return false;
}

/**
 * The CONTIGUOUS narrow C0 control range as an ESCAPED span, in every notation an
 * evader would reach for first. Each needle is the range's start truncated one hex
 * digit short of its end, so a single plain-text `includes` matches both hex cases
 * (lower and upper). The widened primitive never writes any of these — it splits
 * the range at tab/LF/CR into separate sub-ranges — so a present needle is the
 * defect, not the fix. Matched as PLAIN TEXT, so each needle carries a literal
 * backslash-u / backslash-x / backslash-c, never a control character.
 */
const NARROW_CONTROL_CLASS_SIGNATURES = [
  "\\u0000-\\u001", // backslash-u escape form, lower or upper final hex digit
  "\\x00-\\x1", // backslash-x escape form, lower or upper final hex digit
  "\\c@-\\c_", // backslash-c control-escape form, NUL..US
  "\\cA-\\c_", // backslash-c control-escape form starting at SOH
] as const;

function usesNarrowControlClass(source: string): boolean {
  return NARROW_CONTROL_CLASS_SIGNATURES.some((needle) => source.includes(needle));
}

/**
 * The whitespace-collapse regex bodies that mark a FLATTENING (free-text) surface:
 * the allowlist projectors (`recordRefOrNull` and the rest) test-and-return and
 * never collapse, so this idiom marks the passthrough/free-text path. Matched as
 * the regex BODY so the flags (`g`, `gu`, …) and replacement do not matter. This is
 * a heuristic proxy for "projects free text", broadened past the single spelling
 * the previous census keyed on but — as the file docblock states — not exhaustive:
 * a collapse spelled some other way evades recognition. It errs toward
 * over-inclusion (a non-projecting file that happens to collapse whitespace is
 * still held to the routing rule), which fails safe.
 */
const FLATTEN_SIGNATURES = ["/\\s+/", "/\\s\\s*/", "/\\s{2,}/"] as const;

function flattensUntrustedText(source: string): boolean {
  return FLATTEN_SIGNATURES.some((needle) => source.includes(needle));
}

describe("untrusted-text projection census (#2832)", () => {
  it("discovers a non-empty, plausible set of surfaces (non-vacuity anchor)", () => {
    // If the recursive walk ever matches nothing (or far too little), THIS fails
    // rather than every property below passing over an empty set (#2811).
    expect(SOURCE_FILES.length).toBeGreaterThanOrEqual(20);
    const labels = SURFACES.map(([label]) => label);
    for (const known of [
      "packs/booking-shared.ts",
      "packs/booking-records.ts",
      "packs/finance-shared.ts",
      "render.ts",
    ]) {
      expect(labels).toContain(known);
    }
  });

  it.each(SURFACES)(
    "%s carries no raw control byte in its source",
    (_label, path) => {
      expect(hasRawControlByte(sourceOf(path))).toBe(false);
    },
  );

  it.each(SURFACES)(
    "%s does not sanitise with the narrow escaped control class",
    (_label, path) => {
      expect(usesNarrowControlClass(sourceOf(path))).toBe(false);
    },
  );

  const flatteningSurfaces = SURFACES.filter(([, path]) =>
    flattensUntrustedText(sourceOf(path)),
  );

  it("finds every known flattening surface (non-vacuity anchor)", () => {
    const labels = flatteningSurfaces.map(([label]) => label);
    // The free-text projector modules and the renderer. If discovery or the idiom
    // needle breaks, this drops below four and fails instead of the property below
    // passing over an empty set.
    expect(flatteningSurfaces.length).toBeGreaterThanOrEqual(4);
    expect(labels).toEqual(
      expect.arrayContaining([
        "packs/booking-shared.ts",
        "packs/booking-records.ts",
        "packs/finance-shared.ts",
        "render.ts",
      ]),
    );
  });

  it.each(flatteningSurfaces)(
    "%s invokes the shared fold and defusal, not merely imports them",
    (_label, path) => {
      const src = sourceOf(path);
      // Call syntax (an open paren), so a bare import or a re-export cannot satisfy
      // it. This proves the primitives are CALLED in a flattening file; it does not
      // prove the call receives the specific free-text value — see the file
      // docblock and `render.ts` for the real model-visible guarantee.
      expect(src).toContain("foldUntrustedText(");
      expect(src).toContain("defuseRoleLabels(");
    },
  );
});
