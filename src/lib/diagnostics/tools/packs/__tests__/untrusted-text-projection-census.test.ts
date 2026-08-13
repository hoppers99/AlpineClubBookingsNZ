/**
 * TREE-WIDE CENSUS: no Diagnostics tool surface may sanitise database-derived text
 * with the NARROW control-character class, and every surface that flattens
 * untrusted free text must route it through the shared role-label defusal (#2832).
 *
 * The defect #2832 closed lived in three projection helpers and one renderer: each
 * stripped U+0000-U+001F and DEL but not the C1 block, so U+0085 (NEL) — which
 * JavaScript's `\s` does not match — survived both the class and the `\s+`
 * collapse and could fake a new line, and none of them defused a forged
 * `assistant:` turn. Fixing the four known sites does not stop a FIFTH being added
 * the same way, which is what this census is for: it reads the pack and renderer
 * SOURCE and fails the property, not a hand-listed set of files.
 *
 * MEMBERSHIP IS DISCOVERED, NOT LISTED. The pack set is whatever `readdirSync`
 * finds in the packs directory (minus tests), plus the tool-result renderer. A
 * hand-maintained list would silently exclude a new pack — the exact failure mode
 * a census exists to prevent — and this repo has shipped a census that matched an
 * empty set and passed vacuously (#2811), so every discovered set is asserted
 * NON-EMPTY and to contain files known to exist. If discovery breaks, the census
 * FAILS rather than passing over nothing.
 *
 * THE CENSUS ITSELF CONTAINS NO CONTROL CHARACTER. It detects a raw control byte by
 * CODE POINT (`charCodeAt`) and the escaped narrow class and the flatten idiom by
 * plain-text `includes`, so there is no control-range regex literal a formatter or
 * git filter could normalise away — the exact fragility that hid the raw-byte
 * spelling of the narrow class in review before #2832.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PACK_DIR = join(import.meta.dirname, "..");
const TOOLS_DIR = join(PACK_DIR, "..");

/**
 * Every production pack module, discovered from the directory. `.test.ts` is
 * excluded because a test is allowed to CONSTRUCT the narrow class (a behavioural
 * test does, to prove the fix bites) — the property is about what the shipped
 * projections do, not what a test names.
 */
const PACK_FILES = readdirSync(PACK_DIR)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort();

/**
 * The Diagnostics surfaces that render database-derived/untrusted text as evidence:
 * every pack, plus the tool-result renderer that is the shared choke point for
 * every projected value. The knowledge/source-evidence renderers are NOT here on
 * purpose — they frame maintainer-authored repository content, not member/guest
 * free text, and defusing a role label inside committed documentation would corrupt
 * a legitimate excerpt.
 */
const SURFACES: ReadonlyArray<readonly [label: string, path: string]> = [
  ...PACK_FILES.map((name) => [`packs/${name}`, join(PACK_DIR, name)] as const),
  ["render.ts", join(TOOLS_DIR, "render.ts")] as const,
];

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
 * The narrow C0 range as an ESCAPED contiguous span. The literal text
 * backslash-u-0000 to backslash-u-001f is the exact signature of the narrow class
 * from the two named call sites; the widened primitive in `untrusted-text.ts`
 * never writes that span contiguously (it carves tab/LF/CR out into separate
 * sub-ranges), so the contiguous form catches the defect without flagging the fix.
 * Matched as PLAIN TEXT, so the needle carries a literal backslash-u, never a
 * control character.
 */
const NARROW_ESCAPED_C0 = "\\u0000-\\u001f";

/**
 * A surface that FLATTENS untrusted free text, recognised by the collapse idiom
 * `.replace(/\s+/g, " ")`: the allowlist projectors (`recordRefOrNull` and the
 * rest) test-and-return and never collapse, so this idiom marks the
 * passthrough/free-text path. Matched as plain text for the same reason.
 */
const FLATTEN_IDIOM = '.replace(/\\s+/g, " ")';

describe("untrusted-text projection census (#2832)", () => {
  it("discovers a non-empty, plausible set of surfaces (non-vacuity anchor)", () => {
    // If the glob ever matches nothing, THIS fails rather than every property
    // below passing over an empty set (#2811).
    expect(PACK_FILES.length).toBeGreaterThanOrEqual(10);
    for (const known of [
      "booking-shared.ts",
      "booking-records.ts",
      "finance-shared.ts",
    ]) {
      expect(PACK_FILES).toContain(known);
    }
    expect(SURFACES.map(([label]) => label)).toContain("render.ts");
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
      expect(sourceOf(path).includes(NARROW_ESCAPED_C0)).toBe(false);
    },
  );

  const flatteningSurfaces = SURFACES.filter(([, path]) =>
    sourceOf(path).includes(FLATTEN_IDIOM),
  );

  it("finds every known flattening surface (non-vacuity anchor)", () => {
    const labels = flatteningSurfaces.map(([label]) => label);
    // The three free-text projectors and the renderer. If discovery or the idiom
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
    "%s routes flattened untrusted text through the shared defusal",
    (_label, path) => {
      const src = sourceOf(path);
      expect(src).toContain("defuseRoleLabels");
      expect(src).toContain("foldUntrustedText");
    },
  );
});
