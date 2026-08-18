import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  WHY THIS OVERRIDE EXISTS, AND WHEN TO DELETE IT.

  GHSA-ggr8-5vv4-36mx (published 2026-08-17) is a high-severity stack-exhaustion
  advisory in DeepmergeTS affecting `deepmerge-ts < 8.0.0`. It reaches us only
  through Prisma:

      prisma -> @prisma/config -> deepmerge-ts

  `package.json` therefore pins `overrides["deepmerge-ts"]`. package.json is JSON
  and cannot carry a comment, so the reasoning lives here instead — and, more
  usefully, so does the condition for removing it.

  It mattered more than a single red check. `verify` runs `Audit dependencies`
  early, and a failure there SKIPS every later step: lint, the file-size ratchet,
  Prisma generate, typecheck, knip, test and build. So the advisory did not just
  turn `main` red, it silently stopped the suite from running on every branch
  while other checks stayed green (#2945).

  npm's own remedy was `prisma@6.12.0` — a major downgrade of the database
  toolchain to fix a transitive advisory. Rejected.

  THE OVERRIDE IS TEMPORARY. The second test below fails once `@prisma/config`
  itself asks for a fixed version, which is the signal that upstream has shipped
  and this override is now pinning something nobody needs pinned. When it fails:
  delete the override, delete this file, and let the dependency resolve normally.
*/

const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function major(range: string): number {
  const m = /(\d+)/.exec(range.replace(/^[\^~>=<\s]+/, ""));
  return m ? Number(m[1]) : Number.NaN;
}

describe("the deepmerge-ts override (GHSA-ggr8-5vv4-36mx)", () => {
  it("pins a version that carries the fix", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { overrides?: Record<string, unknown> };

    const pinned = pkg.overrides?.["deepmerge-ts"];
    expect(
      typeof pinned === "string" ? pinned : undefined,
      "the deepmerge-ts override is gone. If Prisma shipped the fix, the other " +
        "test in this file will say so and this file should be deleted with it; " +
        "if not, the advisory is back and `verify` will stop running its own suite.",
    ).toBeTypeOf("string");

    expect(major(pinned as string)).toBeGreaterThanOrEqual(8);

    // And the tree really resolved to it — an override that does not take is
    // exactly the kind of green that means nothing. Read the manifest off disk
    // rather than through `require.resolve`: deepmerge-ts is ESM and its
    // `exports` map does not expose `./package.json`, so resolving it throws.
    const resolved = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "node_modules", "deepmerge-ts", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(major(resolved.version)).toBeGreaterThanOrEqual(8);
  });

  it("tells us to remove itself once Prisma no longer needs it", () => {
    const config = JSON.parse(
      readFileSync(require_.resolve("@prisma/config/package.json"), "utf8"),
    ) as { version: string; dependencies?: Record<string, string> };

    const wanted = config.dependencies?.["deepmerge-ts"];

    // If @prisma/config stops depending on it at all, or asks for a fixed
    // major itself, the override has done its job.
    expect(
      wanted === undefined || major(wanted) >= 8,
      `@prisma/config@${config.version} still asks for deepmerge-ts@${wanted}, ` +
        "so the override is still load-bearing. When this expectation flips to " +
        "true, DELETE the override from package.json and delete this file.",
    ).toBe(false);
  });
});
