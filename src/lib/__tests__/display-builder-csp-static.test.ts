import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards for the two invariants that make the Visual builder's
 * route-scoped CSP relaxation (`src/lib/csp.ts`, issue #2246) actually work and
 * actually stay safe. Both are source assertions in the house static-test style
 * (see `email-settings-panel-static.test.ts`) because neither can be observed
 * from a rendered unit test: one is about how a document is ENTERED, the other
 * about what a future edit might add.
 */

const BUILDER_ROUTE = "/admin/display/builder";
const REPO_ROOT = process.cwd();
const BUILDER_SOURCE = "src/app/(admin)/admin/display/builder/display-builder.tsx";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  "dist",
  "build",
]);

function collectSourceFiles(directory: string, found: string[] = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectSourceFiles(absolute, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    // Tests legitimately mention the route as a string (asserting a
    // `window.open(..., "_self")` target, a CSP pathname, …); they render no
    // navigation of their own.
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (absolute.split(path.sep).includes("__tests__")) continue;
    found.push(absolute);
  }
  return found;
}

describe("Visual builder is entered by a HARD navigation (#2246)", () => {
  /*
   * WHY THIS TEST EXISTS — do not "simplify" the guarded links back to <Link>.
   *
   * A Content-Security-Policy is a property of the DOCUMENT. The browser takes
   * it from the response headers when the document is parsed and it never
   * changes for the life of that document. A Next.js App Router <Link> performs
   * a SOFT navigation: it swaps React trees inside the SAME document, so the
   * CSP stays whatever the ENTRY document was served with. There is a single
   * root layout here, so every /admin/* -> /admin/* <Link> is soft.
   *
   * `src/lib/csp.ts` grants `frame-src 'self'` to the builder route alone so its
   * **Live preview** can embed the sandboxed /display iframe. That grant is
   * INERT if the builder is reached by <Link> from another admin page — the
   * previous document's `frame-src` (Stripe hosts only, no 'self') is still in
   * force and the preview shows "Content blocked", which is the exact bug #2246
   * fixed. Only a hard document load fetches the builder's own headers.
   *
   * So every in-app route to the builder must be a hard navigation: a plain
   * `<a href>` (still a real link — same role, keyboard activation and
   * ctrl/middle-click behaviour as <Link>), or `window.open(url, "_self")` as
   * `src/app/(admin)/admin/display/templates/page.tsx` already does.
   */
  const sourceFiles = collectSourceFiles(path.join(REPO_ROOT, "src"));

  it("finds source files to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it("routes no <Link>-family component at the builder", () => {
    // Any JSX opening tag whose component name ends in "Link" — next/link's
    // default `Link`, and the wrappers around it such as `BackLink`, all of
    // which navigate softly.
    const linkTag = /<([A-Z][A-Za-z0-9]*)?Link\b[^>]*>/g;
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes(BUILDER_ROUTE)) continue;
      for (const [tag] of source.matchAll(linkTag)) {
        if (tag.includes(BUILDER_ROUTE)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${tag}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("routes no client-side router push/replace at the builder", () => {
    // `router.push`/`router.replace` are soft for the same reason a <Link> is.
    const routerNavigation = /\.(?:push|replace)\(\s*[`"'][^`"']*\/admin\/display\/builder/g;
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      const source = fs.readFileSync(file, "utf8");
      for (const [call] of source.matchAll(routerNavigation)) {
        offenders.push(`${path.relative(REPO_ROOT, file)}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the hub card's builder entry opted in to a hard navigation", () => {
    const hub = fs.readFileSync(
      path.join(REPO_ROOT, "src/app/(admin)/admin/display/page.tsx"),
      "utf8",
    );
    // The generic hub renderer (`src/components/admin-hub-page.tsx`) keeps
    // <Link> for every other card; only the section descriptor that opts in
    // renders a plain <a>. Losing the flag would silently restore the bug.
    const builderSection = hub.slice(hub.indexOf(`href: "${BUILDER_ROUTE}"`));
    expect(builderSection.slice(0, builderSection.indexOf("},"))).toMatch(
      /hardNavigate:\s*true/,
    );
  });

  it("still renders a plain anchor when a section opts in", () => {
    const hubRenderer = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/admin-hub-page.tsx"),
      "utf8",
    );
    expect(hubRenderer).toMatch(/hardNavigate\s*\?\s*\(\s*<a\b/);
  });
});

describe("Visual builder renders no authored markup itself (#161, #2246)", () => {
  /*
   * WHY THIS TEST EXISTS.
   *
   * `src/lib/csp.ts` keeps two SEPARATE exact-match allowlists. The builder is
   * in `FRAME_SRC_SELF_PATHS` (it embeds the /display iframe) but deliberately
   * NOT in `TIGHT_IMG_SRC_PATHS`, so it keeps the normal admin `img-src ... https:`
   * for avatars and uploaded imagery. That exclusion is only safe because the
   * builder never renders admin-authored display HTML/CSS in its OWN document —
   * the draft is rendered exclusively inside the opaque-origin /display frame,
   * which carries the tightened `img-src 'self' data:` itself.
   *
   * The moment the builder gains an in-canvas WYSIWYG preview (dangerouslySet-
   * InnerHTML, an iframe `srcDoc`, an `innerHTML` assignment, or an injected
   * <style> block of authored CSS), authored markup runs in an admin document
   * with `img-src https:` — reinstating the issue #161 image-beacon
   * exfiltration channel with no other test failing. If this assertion starts
   * failing, the fix is not to delete it: either keep the preview inside the
   * sandboxed frame, or add the builder to TIGHT_IMG_SRC_PATHS and re-review.
   */
  it("uses no HTML-injection sink in the builder component", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, BUILDER_SOURCE), "utf8");

    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).not.toMatch(/\bsrcDoc\b/);
    expect(source).not.toMatch(/\binnerHTML\b/);
    expect(source).not.toMatch(/<style\b/);
  });
});
