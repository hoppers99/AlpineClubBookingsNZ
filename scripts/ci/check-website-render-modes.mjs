import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Guards the public website's render modes (issue #2352 slice 1).
 *
 * ## Why this needs a guard at all
 *
 * `(website)/layout.tsx` used to call `auth()` and `headers()`. Those two lines
 * forced EVERY route in the group to be rendered from scratch on every visit — a
 * production build prerendered zero pages — and removing them is the whole of
 * #2352 slice 1. But they also made the group's render modes uniform by accident,
 * and with them gone each route's mode is a deliberate, load-bearing choice that
 * nothing else in the repo notices when it changes:
 *
 *  • A fixed route that stops being per-request is PRERENDERED AT BUILD, where
 *    there is no database (`Dockerfile` points `DATABASE_URL` at an unreachable
 *    host) and no request and therefore no CSP nonce. The nonce half is caught by
 *    `check-prerendered-script-nonces.mjs` — after a full build. The database half
 *    is not caught at all: it silently freezes an empty page.
 *  • A DYNAMIC-SEGMENT route that stops being per-request is generated on demand
 *    and then STORED. `join/[code]` and `join/verify/[token]` carry a group code
 *    and a one-time token, so a stored copy is a page that skips its own re-check.
 *  • The CMS catch-all going the other way — losing its ISR config — is a silent
 *    return to the cost slice 1 removed, with no failing test anywhere.
 *
 * ## What it checks
 *
 * 1. Every `page.tsx` under `src/app/(website)` either declares
 *    `export const dynamic = "force-dynamic"` or is the CMS catch-all.
 * 2. The CMS catch-all declares `generateStaticParams` returning an empty array
 *    and an `export const revalidate` — the full-route ISR configuration — and
 *    does NOT declare `force-dynamic`.
 * 3. No `loading.tsx`, `template.tsx` or `default.tsx` exists anywhere under
 *    `(website)`, and no Partial Prerendering flag is set on any of its routes.
 *    This is the enforceable form of the #2434 streaming-boundary warning: any of
 *    those introduces a boundary that can commit a 200 status before the catch-all
 *    page's own `notFound()` decision is made, which would turn a missing CMS page
 *    into a soft 404 — and under ISR, would then store it.
 *
 * Source-only by design: it reads files and never needs a build or a database, so
 * it fails in seconds rather than twenty minutes into CI.
 */

const WEBSITE_GROUP = path.join("src", "app", "(website)");

/** The CMS catch-all, relative to the group root, in posix form. */
const CATCH_ALL = "[...slug]/page.tsx";

/** Segment files that introduce a boundary above the page. See check 3. */
const FORBIDDEN_SEGMENT_FILES = new Set([
  "loading.tsx",
  "template.tsx",
  "default.tsx",
]);

/**
 * Partial Prerendering, in either the per-route or the config form. PPR splits a
 * route into a prerendered shell plus a streamed hole, which is precisely the
 * boundary check 3 exists to keep out — and the prerendered shell would carry no
 * nonce.
 */
const PPR_PATTERN = /export\s+const\s+experimental_ppr\b/;

const FORCE_DYNAMIC_PATTERN =
  /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/;

/**
 * `export function generateStaticParams(...): <any return type> { return []; }`.
 *
 * The bounded `[\s\S]{0,80}?` after the opening brace is what keeps this an
 * assertion about an EMPTY list rather than about the identifier being present: a
 * body that computed paths would not match, and neither would one that returned a
 * literal with entries in it. The signature is matched with `[^\n]*` so a return
 * type containing braces (`: { slug: string[] }[]`) is allowed.
 */
const GENERATE_STATIC_PARAMS_EMPTY_PATTERN =
  /export\s+function\s+generateStaticParams\b[^\n]*\{[\s\S]{0,80}?return\s*\[\s*\]\s*;?\s*\}/;

const REVALIDATE_PATTERN = /export\s+const\s+revalidate\s*=\s*\d+/;

/** Every file under `directory`, as paths relative to it, in posix form. */
function collectFiles(directory, root, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(absolute, root, found);
      continue;
    }
    if (entry.isFile()) {
      found.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }

  return found;
}

/**
 * The pure half, so the rules are unit-testable without a checkout.
 *
 * `files` is a map of group-relative posix path -> file contents. Returns a list of
 * plain-English problems; an empty list is a pass.
 */
export function auditWebsiteRenderModes(files) {
  const problems = [];
  const pages = [...files.keys()].filter((file) => file.endsWith("page.tsx"));

  // A scan that finds nothing must fail rather than pass: a renamed route group
  // would otherwise sail through with a green tick and zero files inspected.
  if (pages.length === 0) {
    problems.push(
      "No page.tsx found under src/app/(website). Either the route group moved or " +
        "this check is looking in the wrong place — it must not pass on an empty scan.",
    );
    return problems;
  }

  if (!files.has(CATCH_ALL)) {
    problems.push(
      `The CMS catch-all (${CATCH_ALL}) is missing. #2352 slice 1 makes it the one ` +
        "route in this group served from full-route ISR; if it moved, this check has " +
        "to move with it.",
    );
  }

  for (const [file, source] of files) {
    const basename = file.split("/").pop();

    if (FORBIDDEN_SEGMENT_FILES.has(basename)) {
      problems.push(
        `${file} introduces a render boundary above the page. Not allowed under ` +
          "(website) (#2352, #2434): a boundary can commit a 200 before the CMS " +
          "catch-all decides a URL is a 404, which would make a missing page a soft " +
          "404 and — under ISR — store it.",
      );
    }

    if (PPR_PATTERN.test(source)) {
      problems.push(
        `${file} enables Partial Prerendering. Not allowed under (website) (#2352): ` +
          "PPR prerenders a shell at build time, which has no request and therefore " +
          "no CSP nonce, and streams the rest behind exactly the boundary this check " +
          "keeps out.",
      );
    }

    if (!file.endsWith("page.tsx")) continue;

    if (file === CATCH_ALL) {
      if (FORCE_DYNAMIC_PATTERN.test(source)) {
        problems.push(
          `${file} declares force-dynamic. That is the one route in this group that ` +
            "must NOT: it is the admin-authored CMS page cache, and per-request " +
            "rendering is the cost #2352 slice 1 removed.",
        );
      }
      if (!GENERATE_STATIC_PARAMS_EMPTY_PATTERN.test(source)) {
        problems.push(
          `${file} must export a generateStaticParams() that returns an empty array. ` +
            "Returning paths would prerender them at build, where there is no " +
            "database and no CSP nonce (#2352).",
        );
      }
      if (!REVALIDATE_PATTERN.test(source)) {
        problems.push(
          `${file} must export a numeric \`revalidate\` — the freshness backstop the ` +
            "owner set at 300 seconds (#2352 D3).",
        );
      }
      continue;
    }

    if (!FORCE_DYNAMIC_PATTERN.test(source)) {
      problems.push(
        `${file} must declare \`export const dynamic = "force-dynamic"\`. Since #2352 ` +
          "the shared (website) layout no longer reads the request, so a route that " +
          "does not say this is prerendered at build (no database, no CSP nonce) or, " +
          "if it has a dynamic segment, generated on demand and then STORED.",
      );
    }
  }

  return problems;
}

export function checkWorkingTree(repoRoot) {
  const groupRoot = path.join(repoRoot, WEBSITE_GROUP);

  if (!fs.existsSync(groupRoot)) {
    throw new Error(
      `No route group at ${WEBSITE_GROUP}. This check cannot pass without inspecting it.`,
    );
  }

  const files = new Map(
    collectFiles(groupRoot, groupRoot)
      // Tests colocated under the group are not routes.
      .filter((file) => !file.includes("__tests__/"))
      .map((file) => [
        file,
        fs.readFileSync(path.join(groupRoot, file), "utf8"),
      ]),
  );

  return { fileCount: files.size, problems: auditWebsiteRenderModes(files) };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const { fileCount, problems } = checkWorkingTree(process.cwd());

    if (problems.length > 0) {
      console.error("Public website render modes are wrong (#2352):");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(
        `Public website render-mode check passed: ${fileCount} file(s) under src/app/(website).`,
      );
    }
  } catch (error) {
    console.error(`Public website render-mode check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
