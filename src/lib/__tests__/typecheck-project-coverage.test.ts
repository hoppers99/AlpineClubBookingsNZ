import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import {
  isProductionFile,
  isTestFile,
} from "../../../scripts/lib/file-size-budget";

/**
 * `npm run typecheck` runs two projects: `tsconfig.json` (the app) and
 * `tsconfig.test.json` (Vitest tests). Between them they must read every
 * tracked TypeScript file. That was false before #2875: tests under
 * `scripts/__tests__/` sat in neither project, including the tests for the
 * blocking file-size gate.
 *
 * Vitest's extension surface is wider than `.test.ts(x)`. This contract pins
 * the runner's actual default, asks TypeScript which files each project
 * resolves, and distinguishes two promises deliberately:
 *
 * - `.ts`, `.tsx`, `.mts` and `.cts` tests are statically typechecked in the
 *   test project and excluded from the app project;
 * - JavaScript variants are loaded by the test project while `allowJs` remains
 *   enabled, but `checkJs` is explicitly false, so they are not presented as
 *   statically typechecked. The production-graph guard likewise enables JS
 *   only to resolve imports from every file covered by the size ratchet. #2693
 *   owns converting the test scripts and disabling the projects' `allowJs`
 *   setting alongside the deliberate Playwright project.
 */

const ROOT = process.cwd();
const VITEST_DEFAULT_INCLUDE = "**/*.{test,spec}.?(c|m)[jt]s?(x)";
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const PROJECT_SUPPORTED_VITEST_EXTENSIONS = new Set([
  ...TYPESCRIPT_EXTENSIONS,
  ...JAVASCRIPT_EXTENSIONS,
]);

type ProjectCoverage = {
  files: Set<string>;
  options: ts.CompilerOptions;
  projectReferences: readonly ts.ProjectReference[] | undefined;
};

function repoRelative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/** Repo-relative paths TypeScript resolves for a project, exactly as tsc would. */
function projectCoverage(configName: string): ProjectCoverage {
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
  expect(
    parsed.errors,
    `${configName} should resolve without config errors`,
  ).toEqual([]);
  return {
    files: new Set(parsed.fileNames.map(repoRelative)),
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  };
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

function isVitestTestFile(file: string): boolean {
  return /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(file);
}

/**
 * The only TypeScript files allowed outside both projects. Semgrep fixtures
 * are deliberately broken sample code whose only reader is Semgrep's `--test`
 * runner; making them typecheck would stop them being useful fixtures (#2686).
 */
const EXEMPT = new Set([
  ".semgrep/tests/acb-client-server-boundary.tsx",
  ".semgrep/tests/acb-unsafe-raw-sql.ts",
]);

describe("typecheck project coverage", () => {
  const app = projectCoverage("tsconfig.json");
  const test = projectCoverage("tsconfig.test.json");
  const tracked = trackedFiles();
  const trackedTypeScript = tracked.filter((file) =>
    /\.(ts|tsx|mts|cts)$/.test(file),
  );
  const vitestTests = tracked.filter(
    (file) =>
      isVitestTestFile(file) &&
      !file.startsWith("e2e/") &&
      !file.includes("/.claude/"),
  );

  it("pins the Vitest default test/spec extension contract", () => {
    expect(configDefaults.include).toEqual([VITEST_DEFAULT_INCLUDE]);
    const extensionsMatchedByThatGlob = [
      ".js",
      ".jsx",
      ".cjs",
      ".cjsx",
      ".mjs",
      ".mjsx",
      ".ts",
      ".tsx",
      ".cts",
      ".ctsx",
      ".mts",
      ".mtsx",
    ];
    for (const extension of extensionsMatchedByThatGlob) {
      expect(isVitestTestFile(`scripts/example.test${extension}`)).toBe(true);
      expect(isVitestTestFile(`src/example.spec${extension}`)).toBe(true);
    }
  });

  it("reads every tracked TypeScript file in one project or the other", () => {
    const uncovered = trackedTypeScript.filter(
      (file) =>
        !EXEMPT.has(file) && !app.files.has(file) && !test.files.has(file),
    );
    expect(
      uncovered,
      "these tracked TypeScript files are in neither tsconfig project, so `npm run typecheck` never reads them",
    ).toEqual([]);
  });

  it("puts every supported TypeScript Vitest extension in the test project only", () => {
    const testFiles = vitestTests.filter((file) =>
      TYPESCRIPT_EXTENSIONS.has(path.extname(file)),
    );
    expect(testFiles.length).toBeGreaterThan(1000);
    for (const file of testFiles) {
      expect(
        test.files.has(file),
        `${file} should be in tsconfig.test.json`,
      ).toBe(true);
      expect(
        app.files.has(file),
        `${file} should stay out of tsconfig.json`,
      ).toBe(false);
    }
  });

  it("keeps ratchet-excluded test paths out of the production source graph", () => {
    const productionRoots = tracked
      .filter(isProductionFile)
      .map((file) => path.join(ROOT, file));
    expect(productionRoots.length).toBeGreaterThan(1000);

    // This Program is a module-reachability guard, not an additional
    // typechecking claim. `allowJs` lets it follow every JS-family extension
    // accepted by the ratchet; `checkJs: false` keeps the #2693 boundary honest.
    const graphOptions: ts.CompilerOptions = {
      ...app.options,
      allowJs: true,
      checkJs: false,
    };
    expect(graphOptions.allowJs).toBe(true);
    expect(graphOptions.checkJs).toBe(false);

    const program = ts.createProgram({
      rootNames: productionRoots,
      options: graphOptions,
      projectReferences: app.projectReferences,
    });
    const importedTestPaths = program
      .getSourceFiles()
      .map((sourceFile) => repoRelative(sourceFile.fileName))
      .filter(isTestFile)
      .sort();

    expect(
      importedTestPaths,
      "production app roots import these test-path modules, but the file-size ratchet excludes them from production debt",
    ).toEqual([]);
  }, 30_000);

  it("loads JavaScript Vitest files without claiming checkJs coverage", () => {
    const javaScriptTests = vitestTests.filter((file) =>
      JAVASCRIPT_EXTENSIONS.has(path.extname(file)),
    );
    expect(javaScriptTests.length).toBeGreaterThan(0);
    expect(test.options.allowJs).toBe(true);
    expect(test.options.checkJs ?? false).toBe(false);
    for (const file of javaScriptTests) {
      expect(
        test.files.has(file),
        `${file} should be loaded by tsconfig.test.json`,
      ).toBe(true);
      expect(
        app.files.has(file),
        `${file} should stay out of tsconfig.json`,
      ).toBe(false);
    }
  });

  it("refuses a Vitest-collected extension that TypeScript cannot load", () => {
    const unsupported = vitestTests.filter(
      (file) => !PROJECT_SUPPORTED_VITEST_EXTENSIONS.has(path.extname(file)),
    );
    expect(
      unsupported,
      "Vitest collects these files, but neither TypeScript project can load their compound JSX extension. Rename them to .tsx/.jsx or another supported extension.",
    ).toEqual([]);
  });

  it("keeps Playwright specs at the measured #2693 boundary", () => {
    const e2e = trackedTypeScript.filter((file) => file.startsWith("e2e/"));
    expect(e2e.length).toBeGreaterThan(0);
    for (const file of e2e) {
      expect(
        app.files.has(file),
        `${file} is currently reached by tsconfig.json`,
      ).toBe(true);
      expect(test.files.has(file), `${file} is not a Vitest test`).toBe(false);
    }
  });

  it("covers scripts/__tests__ specifically, which is the #2875 hole", () => {
    const scriptTests = trackedTypeScript.filter(
      (file) => file.startsWith("scripts/") && file.includes("/__tests__/"),
    );
    expect(scriptTests.length).toBeGreaterThan(0);
    for (const file of scriptTests) expect(test.files.has(file)).toBe(true);
  });

  it("is not vacuous: both projects resolve a substantial file set", () => {
    expect(trackedTypeScript.length).toBeGreaterThan(3000);
    expect(app.files.size).toBeGreaterThan(1000);
    expect(test.files.size).toBeGreaterThan(1000);
  });
});
