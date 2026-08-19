/**
 * The render gate is only a guarantee while EVERY send path goes through it
 * (#2900).
 *
 * `emailPalette()` is synchronous, so nothing in the template layer can wait for
 * the club's Site Style theme to load. The guarantee therefore lives one level
 * up: a sending module builds its themed HTML inside `renderEmailHtml()`, which
 * awaits `ensureEmailPaletteReady()` first. One module that renders a template
 * directly re-opens the exact defect this issue reported — the first email from
 * a fresh process in the public default palette, the next one in the club's.
 *
 * That cannot be caught by types (the templates return plain strings) and it
 * cannot be caught by a hand-written list of send sites, because a new sender is
 * exactly the thing a list forgets. So this test reads the SOURCE TREE: it finds
 * every module that imports a render function from `email-templates/`, and
 * checks that each call to one is lexically inside a `renderEmailHtml(...)`
 * argument. A brand-new sender module is covered the moment it is written.
 *
 * Deliberate exemptions are listed in `EXEMPT_FILES` with their reasons, and the
 * list is asserted to be exactly those files — an exemption that stops being
 * needed fails this test rather than quietly widening the hole.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC_DIR = "src";
const TEMPLATE_DIR_SEGMENT = "email-templates";

/**
 * Files that import a render function but must NOT be gated.
 *
 * `src/lib/email-templates/**` is the template layer itself: those modules
 * compose each other, and gating a leaf would make the shell async.
 */
const EXEMPT_FILES: ReadonlyArray<{ file: string; why: string }> = [];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Byte ranges covered by a comment or a quoted string. */
function maskedRegions(src: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      regions.push([i, end]);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i);
      const end = close === -1 ? src.length : close + 2;
      regions.push([i, end]);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      regions.push([i, j + 1]);
      i = j + 1;
      continue;
    }
    i++;
  }
  return regions;
}

/** Index of the `)` closing the `(` at `openIdx`, ignoring strings/comments. */
function matchingParen(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  const masks = maskedRegions(src.slice(openIdx)).map(
    ([a, b]) => [a + openIdx, b + openIdx] as [number, number],
  );
  const masked = (idx: number) => masks.some(([a, b]) => idx >= a && idx < b);
  while (i < src.length) {
    if (!masked(i)) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }
  return -1;
}

const TEMPLATE_IMPORT_RE = new RegExp(
  `import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*"[^"]*${TEMPLATE_DIR_SEGMENT}\\/[^"]*"`,
  "g",
);

function importedRenderFunctions(src: string): string[] {
  const names = new Set<string>();
  for (const match of src.matchAll(TEMPLATE_IMPORT_RE)) {
    if (match[0].startsWith("import type")) continue;
    for (const raw of match[1].split(",")) {
      const spec = raw.trim();
      if (!spec || spec.startsWith("type ")) continue;
      const name = spec.split(/\s+as\s+/)[0].trim();
      // Every render function in `email-templates/` is named `*Template`; the
      // other exports there are block helpers and formatters, which the
      // templates themselves compose. `email-render-coverage.ts` reads the same
      // directory and would surface a renderer that broke that convention.
      if (name.endsWith("Template")) names.add(name);
    }
  }
  return [...names];
}

interface UngatedCall {
  file: string;
  fn: string;
  line: number;
}

function findUngatedRenderCalls(file: string, src: string): UngatedCall[] {
  const fns = importedRenderFunctions(src);
  if (fns.length === 0) return [];

  const masks = maskedRegions(src);
  const masked = (idx: number) => masks.some(([a, b]) => idx >= a && idx < b);

  // Every `renderEmailHtml(...)` argument span in the file.
  const gateSpans: Array<[number, number]> = [];
  for (const m of src.matchAll(/(^|[^\w$.])renderEmailHtml\s*\(/g)) {
    const nameIdx = m.index! + m[1].length;
    if (masked(nameIdx)) continue;
    const open = src.indexOf("(", nameIdx);
    const close = matchingParen(src, open);
    if (close !== -1) gateSpans.push([open, close]);
  }
  const gated = (idx: number) => gateSpans.some(([a, b]) => idx > a && idx < b);

  const findings: UngatedCall[] = [];
  for (const fn of fns) {
    const re = new RegExp(`(^|[^\\w$.])(${fn})\\s*\\(`, "g");
    for (const m of src.matchAll(re)) {
      const nameIdx = m.index! + m[1].length;
      if (masked(nameIdx) || gated(nameIdx)) continue;
      findings.push({
        file,
        fn,
        line: src.slice(0, nameIdx).split("\n").length,
      });
    }
  }
  return findings;
}

function sendingModules(): Array<{ file: string; src: string }> {
  return listSourceFiles(SRC_DIR)
    .map((file) => ({ file: relative(".", file).split(sep).join("/"), src: readFileSync(file, "utf8") }))
    .filter(
      ({ file, src }) =>
        !file.startsWith(`src/lib/${TEMPLATE_DIR_SEGMENT}/`) &&
        importedRenderFunctions(src).length > 0,
    );
}

describe("email render gate contract (#2900)", () => {
  const modules = sendingModules();

  it("finds the sending modules by reading the tree, not from a list", () => {
    // A guard over an empty population is a guard that passes for the wrong
    // reason. If this drops to zero the discovery above has broken.
    expect(modules.length).toBeGreaterThanOrEqual(15);
  });

  it("builds every themed email inside renderEmailHtml()", () => {
    const exempt = new Set(EXEMPT_FILES.map((e) => e.file));
    const findings = modules
      .filter(({ file }) => !exempt.has(file))
      .flatMap(({ file, src }) => findUngatedRenderCalls(file, src));

    expect(
      findings.map((f) => `${f.file}:${f.line} ${f.fn}()`),
      "Each of these renders themed email HTML outside the render gate, so on a " +
        "cold process it would be coloured with the shipped default palette " +
        "instead of the club's saved Site Style theme (#2900). Wrap the call: " +
        "`await renderEmailHtml(() => yourTemplate(...))`.",
    ).toEqual([]);
  });

  it("imports the gate wherever it renders", () => {
    const exempt = new Set(EXEMPT_FILES.map((e) => e.file));
    const missing = modules
      .filter(({ file }) => !exempt.has(file))
      .filter(({ src }) => !/renderEmailHtml/.test(src))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });

  it("keeps the exemption list to exactly the files that still need one", () => {
    // Empty today. Anything added here must carry a reason, and must really
    // import a render function — a stale exemption is a hole nobody can see.
    const discovered = new Set(modules.map((m) => m.file));
    for (const { file, why } of EXEMPT_FILES) {
      expect(why.length, `${file} needs a reason`).toBeGreaterThan(20);
      expect(discovered.has(file), `${file} no longer renders email`).toBe(true);
    }
  });
});
