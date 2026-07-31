import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Fails the build when a PRERENDERED page ships an inline `<script>` with no
 * `nonce` (issue #2356).
 *
 * Why this needs a guard at all: production CSP is nonce-only
 * (`script-src 'self' 'nonce-…'`, `src/lib/csp.ts`), and Next stamps its nonce
 * into the inline bootstrap/RSC scripts only during DYNAMIC rendering, reading
 * it from the request's own CSP header. A statically prerendered route was
 * rendered once with no request, so it ships unnonced inline scripts that the
 * browser then blocks — the page never hydrates. Nothing else in the repo
 * notices: the build succeeds, the HTML looks right, and the failure is visible
 * only in a browser console. `/display` (fork #54) and the global 404 (#2356)
 * have both hit this already.
 *
 * This runs against the real build output, after `npm run build`, because that
 * is the only place the property is observable. It fails LOUDLY when the build
 * output is absent rather than passing quietly.
 */

const DIST_DIR = ".next";

/**
 * Prerendered artefacts that are KNOWN to ship unnonced inline scripts and
 * cannot be fixed. Closed list, keyed by the build-relative posix path.
 *
 * Only entry: the global error page. A global error boundary must be a Client
 * Component (Next's `docs/01-app/03-api-reference/03-file-conventions/error.md`),
 * and route segment config is not read from a client module — `export const
 * dynamic = "force-dynamic"` there is accepted by the build with no error and no
 * warning, and changes nothing (measured, #2356). `server/pages/500.html` is
 * Next's own byte-identical copy of the same render.
 *
 * This is not a licence to add more. Each entry is asserted to still be an
 * offender below, so a Next release that fixes one fails this check and the
 * carve-out gets deleted rather than quietly outliving its reason.
 */
export const KNOWN_UNNONCED_PRERENDERS = new Map([
  [
    "server/app/_global-error.html",
    "global-error.tsx must be a Client Component, so it cannot be forced dynamic (#2356)",
  ],
  [
    "server/pages/500.html",
    "Next's copy of _global-error.html, served by base-server for a 500 that escapes the app render (#2356)",
  ],
]);

/**
 * Every inline `<script>` open tag in `html` that carries no non-empty `nonce`.
 *
 * A tag with `src=` is external and is covered by `script-src 'self'`, so it is
 * not an offender. `nonce=""` does NOT count as nonced: an empty attribute
 * matches no `'nonce-…'` source expression, so the browser blocks it just the
 * same, and treating it as satisfied would be the exact silent pass this guard
 * exists to prevent.
 */
export function findUnnoncedInlineScripts(html) {
  const offenders = [];

  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes)) continue;
    if (/\bnonce\s*=\s*(?:"[^"]+"|'[^']+'|[^\s"'>]+)/i.test(attributes)) continue;
    offenders.push(match[0]);
  }

  return offenders;
}

/** Every `.html` file under `directory`, as build-relative posix paths. */
function collectHtmlFiles(directory, distRoot, found = []) {
  if (!fs.existsSync(directory)) return found;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectHtmlFiles(absolute, distRoot, found);
      continue;
    }
    if (entry.isFile() && path.extname(entry.name) === ".html") {
      found.push(path.relative(distRoot, absolute).split(path.sep).join("/"));
    }
  }

  return found;
}

/**
 * The pure half, so the rules are unit-testable without a build.
 *
 * `artefacts` is a map of build-relative posix path -> HTML string. Returns the
 * two ways this check can fail: `offenders` (an unexpected artefact shipping
 * unnonced inline scripts) and `staleAllowances` (an allowlisted artefact that
 * is missing or has stopped offending, so its carve-out should be removed).
 */
export function auditPrerenderedHtml(artefacts, allowlist = KNOWN_UNNONCED_PRERENDERS) {
  const offenders = [];
  const staleAllowances = [];

  for (const [file, html] of artefacts) {
    const unnonced = findUnnoncedInlineScripts(html);
    if (unnonced.length === 0) continue;
    if (allowlist.has(file)) continue;
    offenders.push({ file, count: unnonced.length, samples: unnonced.slice(0, 3) });
  }

  for (const [file, reason] of allowlist) {
    const html = artefacts.get(file);
    if (html === undefined) {
      staleAllowances.push(`${file} is allowlisted but was not emitted by the build (${reason})`);
      continue;
    }
    if (findUnnoncedInlineScripts(html).length === 0) {
      staleAllowances.push(
        `${file} is allowlisted but no longer ships unnonced inline scripts — delete the carve-out (${reason})`,
      );
    }
  }

  return { offenders, staleAllowances };
}

export function checkBuildOutput(distRoot) {
  if (!fs.existsSync(distRoot)) {
    throw new Error(
      `No build output at ${distRoot}. This check must run AFTER \`npm run build\` — it cannot pass without one.`,
    );
  }

  const files = [
    ...collectHtmlFiles(path.join(distRoot, "server", "app"), distRoot),
    ...collectHtmlFiles(path.join(distRoot, "server", "pages"), distRoot),
  ];

  const artefacts = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(distRoot, file), "utf8")]),
  );

  const { offenders, staleAllowances } = auditPrerenderedHtml(artefacts);
  return { files, offenders, staleAllowances };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const distRoot = path.resolve(process.cwd(), DIST_DIR);
    const { files, offenders, staleAllowances } = checkBuildOutput(distRoot);

    const problems = [];

    if (offenders.length > 0) {
      problems.push(
        "Prerendered pages ship inline <script> tags with no nonce, which the production CSP blocks:",
        ...offenders.map(
          ({ file, count, samples }) =>
            `  - ${file}: ${count} unnonced inline script(s), e.g. ${samples.join(" ")}`,
        ),
        "",
        "Fix: force the route to render per-request (`export const dynamic = \"force-dynamic\"`),",
        "as src/app/not-found.tsx and src/app/display/page.tsx do. Next stamps the nonce only",
        "during dynamic rendering. See docs/SECURITY-ATTACK-SURFACE.md -> \"Prerendered Pages And",
        "The Nonce-Only CSP\".",
      );
    }

    if (staleAllowances.length > 0) {
      problems.push(
        "Allowlist in scripts/ci/check-prerendered-script-nonces.mjs is out of date:",
        ...staleAllowances.map((entry) => `  - ${entry}`),
      );
    }

    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(
        `Prerendered script-nonce check passed: ${files.length} prerendered HTML artefact(s), ` +
          `${KNOWN_UNNONCED_PRERENDERS.size} documented exception(s).`,
      );
    }
  } catch (error) {
    console.error(`Prerendered script-nonce check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
