import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * `npm run typecheck` runs two projects — `tsconfig.json` (the app) and
 * `tsconfig.test.json` (the Vitest tests). Between them they are supposed to
 * read every TypeScript file in the repository. Nothing checked that they did.
 *
 * They did not (#2875). `tsconfig.json` excludes `**` + `/*.test.ts` and
 * `__tests__/`, and `tsconfig.test.json` re-included only the `src/` half of
 * what that removed, so the tests under `scripts/__tests__/` sat in neither
 * project. Three deliberate `const x: number = "string"` errors planted in
 * those files produced a green `npm run typecheck`. Among them were the tests
 * for the file-size gate this repository now blocks on — a gate whose own tests
 * the typechecker never read.
 *
 * This is the guard for the general property rather than for those three files,
 * because the specific hole is the cheap part to fix and the easy part to
 * reopen: any future `exclude`, or any test placed in a new directory, silently
 * removes files from the typechecker with no other symptom.
 *
 * It asks TypeScript itself which files each project resolves to, rather than
 * reimplementing tsconfig's include/exclude glob semantics.
 */

const ROOT = process.cwd();

/** Repo-relative paths TypeScript resolves for a project, exactly as tsc would. */
function projectFiles(configName: string): Set<string> {
  const configPath = path.join(ROOT, configName);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error, `${configName} should parse`).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    ROOT,
    undefined,
    configPath,
  );
  return new Set(
    parsed.fileNames.map((file) =>
      path.relative(ROOT, file).split(path.sep).join("/"),
    ),
  );
}

function trackedTypeScriptFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => /\.(ts|tsx|mts|cts)$/.test(file));
}

/**
 * The only files allowed to sit outside both projects, each with the reason.
 * `.semgrep/tests/` fixtures are deliberately-broken sample code whose only
 * reader is Semgrep's own `--test` runner; they import modules that do not
 * resolve from that directory and they exist in order to be reported, so
 * type-checking them would fail and fixing them would stop them being fixtures
 * (#2686, and `tsconfig.json` says the same at its `exclude`).
 */
const EXEMPT = new Set([
  ".semgrep/tests/acb-client-server-boundary.tsx",
  ".semgrep/tests/acb-unsafe-raw-sql.ts",
]);

describe("typecheck project coverage", () => {
  const app = projectFiles("tsconfig.json");
  const test = projectFiles("tsconfig.test.json");
  const tracked = trackedTypeScriptFiles();

  it("reads every tracked TypeScript file in one project or the other", () => {
    const uncovered = tracked.filter(
      (file) => !EXEMPT.has(file) && !app.has(file) && !test.has(file),
    );
    expect(
      uncovered,
      "these tracked TypeScript files are in neither tsconfig project, so `npm run typecheck` " +
        "never reads them. Add them to tsconfig.test.json (Vitest tests) or tsconfig.json " +
        "(everything else), or exempt them here with the reason.",
    ).toEqual([]);
  });

  it("puts every Vitest test in the test project, which is the one with the globals", () => {
    const testFiles = tracked.filter(
      (file) => /\.(test|spec)\.(ts|tsx)$/.test(file) || file.includes("/__tests__/"),
    );
    // `e2e/` is Playwright, not Vitest: its specs import `test`/`expect` from
    // `@playwright/test` rather than relying on Vitest globals, and they are
    // read by the app project today because `tsconfig.json` excludes only
    // `*.test.*` and `__tests__/`, not `*.spec.*`. So they are typechecked —
    // incidentally rather than deliberately. Giving them a project chosen on
    // purpose is MEP-E1 (#2693) and is not in scope here; this only asserts
    // they are not in the gap.
    const misfiled = testFiles.filter(
      (file) => !EXEMPT.has(file) && !test.has(file) && !file.startsWith("e2e/"),
    );
    expect(misfiled).toEqual([]);
    for (const file of tracked.filter((f) => f.startsWith("e2e/"))) {
      expect(app.has(file) || test.has(file)).toBe(true);
    }
  });

  it("covers the scripts/ tests specifically, which is the hole this closes", () => {
    const scriptTests = tracked.filter(
      (file) => file.startsWith("scripts/") && file.includes("/__tests__/"),
    );
    expect(scriptTests.length).toBeGreaterThan(0);
    for (const file of scriptTests) expect(test.has(file)).toBe(true);
  });

  it("is not vacuous: both projects resolve a substantial file set", () => {
    expect(tracked.length).toBeGreaterThan(3000);
    expect(app.size).toBeGreaterThan(1000);
    expect(test.size).toBeGreaterThan(1000);
  });
});
