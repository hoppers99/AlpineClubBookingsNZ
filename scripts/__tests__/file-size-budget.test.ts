import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { run } from "../ci/check-file-size-budget";

import {
  BASELINE_PATH,
  PRODUCTION_LIMIT,
  ROUTE_HANDLER_LIMIT,
  ROUTE_PAGE_LIMIT,
  baselineEntriesFor,
  budgetForFile,
  evaluateRatchet,
  findOversizedProductionFiles,
  findUnclassifiedFiles,
  isProductionFile,
  parseBaseline,
  scanRepository,
  serializeBaseline,
  type BaselineEntry,
  type FileStat,
  type RatchetFindingKind,
} from "../lib/file-size-budget";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function kinds(findings: readonly { kind: RatchetFindingKind }[]): RatchetFindingKind[] {
  return findings.map((finding) => finding.kind);
}

/** A small synthetic tree: one file per budget category, all within budget. */
const CLEAN_TREE: FileStat[] = [
  { file: "src/lib/small-module.ts", lines: PRODUCTION_LIMIT },
  { file: "src/app/api/example/route.ts", lines: ROUTE_HANDLER_LIMIT },
  { file: "src/app/(admin)/admin/example/page.tsx", lines: ROUTE_PAGE_LIMIT },
];

function baselineFor(stats: FileStat[]): string {
  return serializeBaseline(baselineEntriesFor(stats));
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function writeLines(root: string, file: string, lines: number): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "line\n".repeat(lines), "utf8");
}

function createTrackedRepo(file: string, lines: number): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "acb-file-size-budget-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(
    path.join(root, ".gitattributes"),
    "*.ts text eol=lf\n*.txt text eol=lf\n",
    "utf8",
  );
  writeLines(root, file, lines);
  const baseline = serializeBaseline(
    baselineEntriesFor([{ file, lines }]),
  );
  const baselineTarget = path.join(root, BASELINE_PATH);
  mkdirSync(path.dirname(baselineTarget), { recursive: true });
  writeFileSync(baselineTarget, baseline, "utf8");
  git(root, ["add", "--", ".gitattributes", file, BASELINE_PATH]);
  return root;
}

function captureRun(root: string, argv: readonly string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  try {
    return { code: run(root, argv), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

function verifyJobSource(workflow: string): string {
  const start = workflow.search(/^  verify:\s*$/m);
  if (start === -1) return "";
  const afterStart = workflow.slice(start + "  verify:".length);
  const nextJob = afterStart.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return nextJob === -1 ? afterStart : afterStart.slice(0, nextJob);
}

describe("blocking CI wiring", () => {
  it("maps the public check command to the file-size ratchet entry point exactly", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["quality:budget"]).toBe(
      "tsx scripts/ci/check-file-size-budget.ts",
    );
    expect(packageJson.scripts?.["quality:budget:update"]).toBe(
      "tsx scripts/ci/check-file-size-budget.ts --update",
    );
  });

  it("runs the public check command exactly once in the blocking verify job", () => {
    const workflow = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    const verify = verifyJobSource(workflow);
    expect(verify, "ci.yml must contain a top-level verify job").not.toBe("");
    expect(verify.match(/^        run: npm run quality:budget\s*$/gm) ?? []).toHaveLength(1);
  });
});

describe("budget classification", () => {
  it("applies the documented budget for each kind of production file", () => {
    expect(budgetForFile("src/app/api/bookings/route.ts")).toMatchObject({
      slug: "route-handler",
      limit: ROUTE_HANDLER_LIMIT,
    });
    expect(budgetForFile("src/app/(admin)/admin/members/page.tsx")).toMatchObject({
      slug: "route-page-shell",
      limit: ROUTE_PAGE_LIMIT,
    });
    expect(budgetForFile("src/lib/email.ts")).toMatchObject({
      slug: "domain-module",
      limit: PRODUCTION_LIMIT,
    });
    // A co-located client component under app/ is a domain module, not a shell.
    expect(budgetForFile("src/app/(admin)/admin/members/members-client.tsx")).toMatchObject({
      slug: "domain-module",
      limit: PRODUCTION_LIMIT,
    });
  });

  it("covers every executable source extension, not just .ts/.tsx", () => {
    // The hole this closes: `git mv audit.ts audit.js` took a baselined file
    // out of scope entirely, and the tool reported it as a debt REDUCTION.
    for (const ext of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
      expect(isProductionFile(`src/lib/audit.${ext}`)).toBe(true);
    }
    expect(budgetForFile("src/app/api/x/route.js")).toMatchObject({
      slug: "route-handler",
    });
    expect(budgetForFile("src/app/admin/x/page.jsx")).toMatchObject({
      slug: "route-page-shell",
    });
    expect(isProductionFile("src/lib/thing.test.js")).toBe(false);
    expect(isProductionFile("src/styles/app.css")).toBe(false);
  });

  it("gives root-level App Router files their real budget", () => {
    expect(budgetForFile("src/app/route.ts")).toMatchObject({
      slug: "route-handler",
      limit: ROUTE_HANDLER_LIMIT,
    });
    expect(budgetForFile("src/app/page.tsx")).toMatchObject({
      slug: "route-page-shell",
      limit: ROUTE_PAGE_LIMIT,
    });
  });

  it("treats the budget as exclusive: exactly at the limit is not over", () => {
    expect(findOversizedProductionFiles(CLEAN_TREE)).toEqual([]);
    expect(
      findOversizedProductionFiles([{ file: "src/lib/x.ts", lines: PRODUCTION_LIMIT + 1 }]),
    ).toHaveLength(1);
  });
});

describe("baseline serialisation", () => {
  it("round-trips and is byte-stable regardless of input order", () => {
    const entries: BaselineEntry[] = [
      { file: "src/lib/zeta.ts", lines: 900, slug: "domain-module" },
      { file: "src/app/api/a/route.ts", lines: 300, slug: "route-handler" },
      { file: "src/app/b/page.tsx", lines: 600, slug: "route-page-shell" },
    ];
    const forward = serializeBaseline(entries);
    const reversed = serializeBaseline([...entries].reverse());
    expect(forward).toBe(reversed);
    expect(parseBaseline(forward).problems).toEqual([]);
    expect(parseBaseline(forward).entries).toEqual(
      [...entries].sort((a, b) => (a.file < b.file ? -1 : 1)),
    );
  });

  it("carries no timestamp, count or other regenerating noise in its header", () => {
    const a = serializeBaseline([{ file: "src/lib/a.ts", lines: 800, slug: "domain-module" }]);
    const b = serializeBaseline([
      { file: "src/lib/a.ts", lines: 800, slug: "domain-module" },
      { file: "src/lib/b.ts", lines: 900, slug: "domain-module" },
    ]);
    const headerOf = (text: string) =>
      text.split("\n").filter((line) => line.startsWith("#")).join("\n");
    expect(headerOf(a)).toBe(headerOf(b));
    expect(headerOf(a)).not.toMatch(/\d{4}-\d{2}-\d{2}|generated at|total/i);
  });

  it("round-trips a path containing a space rather than going permanently red", () => {
    // The generator writes `<path> <loc> <slug>`; a strict three-field split
    // could not read back what it had just written, and the advertised fix
    // (regenerate) reproduced the identical line.
    const entry: BaselineEntry = {
      file: "src/lib/zz probe.ts",
      lines: 800,
      slug: "domain-module",
    };
    const text = serializeBaseline([entry]);
    const parsed = parseBaseline(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries).toEqual([entry]);
    expect(
      evaluateRatchet([{ file: "src/lib/zz probe.ts", lines: 800 }], text).findings,
    ).toEqual([]);
  });

  it("rejects every hand-edit shape that would make the file unreliable", () => {
    const cases: Array<[string, RegExp]> = [
      ["src/lib/a.ts 800", /expected `<path> <loc> <budget-category>`/],
      ["src/lib/a.ts eight-hundred domain-module", /positive integer/],
      ["src/lib/a.ts 0 domain-module", /positive integer/],
      ["src/lib/a.ts -5 domain-module", /positive integer/],
      ["src/lib/a.ts 800 tiny-module", /unknown budget category/],
      ["scripts/a.ts 800 domain-module", /under src\//],
      ["src\\lib\\a.ts 800 domain-module", /forward slashes/],
      ["src/lib/../etc.ts 800 domain-module", /normalised/],
      ["  src/lib/a.ts 800 domain-module", /whitespace/],
      ["", /blank line/],
    ];
    for (const [line, expected] of cases) {
      const parsed = parseBaseline(`# header\n${line}\n`);
      expect(parsed.problems.map((problem) => problem.message).join(" | ")).toMatch(expected);
    }
  });

  it("rejects duplicate and out-of-order records", () => {
    const duplicate = parseBaseline(
      "src/lib/a.ts 800 domain-module\nsrc/lib/a.ts 900 domain-module\n",
    );
    expect(duplicate.problems[0].message).toMatch(/duplicate entry/);

    const unsorted = parseBaseline(
      "src/lib/b.ts 800 domain-module\nsrc/lib/a.ts 900 domain-module\n",
    );
    expect(unsorted.problems[0].message).toMatch(/out of order/);
  });
});

describe("the ratchet", () => {
  it("passes when the tree matches the committed baseline exactly", () => {
    const tree: FileStat[] = [
      ...CLEAN_TREE,
      { file: "src/lib/big.ts", lines: 1200 },
      { file: "src/app/api/big/route.ts", lines: 400 },
    ];
    const result = evaluateRatchet(tree, baselineFor(tree));
    expect(result.findings).toEqual([]);
    expect(result.oversizedFiles).toBe(2);
    expect(result.currentOverage).toBe(1200 - PRODUCTION_LIMIT + (400 - ROUTE_HANDLER_LIMIT));
  });

  it("fails on a NEW over-budget file", () => {
    const before: FileStat[] = [...CLEAN_TREE];
    const after: FileStat[] = [...CLEAN_TREE, { file: "src/lib/brand-new.ts", lines: 900 }];
    const result = evaluateRatchet(after, baselineFor(before));
    expect(kinds(result.findings)).toEqual(["new-over-budget"]);
    const [finding] = result.findings;
    expect(finding.severity).toBe("regression");
    expect(finding.file).toBe("src/lib/brand-new.ts");
    expect(finding.budget).toBe("domain module, <= 700 LOC");
    expect(finding.current).toContain("900 LOC");
    expect(finding.action).toMatch(/split or reduce/);
  });

  it("fails when an already-oversized file grows beyond its baseline", () => {
    const before: FileStat[] = [{ file: "src/lib/big.ts", lines: 1200 }];
    const after: FileStat[] = [{ file: "src/lib/big.ts", lines: 1201 }];
    const result = evaluateRatchet(after, baselineFor(before));
    expect(kinds(result.findings)).toEqual(["grown-beyond-baseline"]);
    const [finding] = result.findings;
    expect(finding.severity).toBe("regression");
    expect(finding.baseline).toBe("1200 LOC");
    expect(finding.current).toContain("+1 since the baseline");
  });

  it("fails when a file shrinks and the baseline is not regenerated, and the regenerated baseline is lower", () => {
    const before: FileStat[] = [{ file: "src/lib/big.ts", lines: 1200 }];
    const after: FileStat[] = [{ file: "src/lib/big.ts", lines: 900 }];
    const stale = evaluateRatchet(after, baselineFor(before));
    expect(kinds(stale.findings)).toEqual(["shrunk-below-baseline"]);
    expect(stale.findings[0].severity).toBe("stale");
    expect(stale.findings[0].action).toMatch(/quality:budget:update/);

    // Regenerating is the fix, the new ceiling is the lower number, and the
    // old ceiling no longer passes.
    const regenerated = stale.regenerated;
    expect(regenerated).toContain("src/lib/big.ts 900 domain-module");
    expect(evaluateRatchet(after, regenerated).findings).toEqual([]);
    expect(kinds(evaluateRatchet(before, regenerated).findings)).toEqual([
      "grown-beyond-baseline",
    ]);
  });

  it("fails when an oversized file drops out of the baseline's scope without regeneration", () => {
    const before: FileStat[] = [{ file: "src/lib/big.ts", lines: 1200 }];
    const withinBudget = evaluateRatchet(
      [{ file: "src/lib/big.ts", lines: 400 }],
      baselineFor(before),
    );
    expect(kinds(withinBudget.findings)).toEqual(["no-longer-over-budget"]);
    expect(withinBudget.findings[0].current).toMatch(/now within budget/);

    const deleted = evaluateRatchet([{ file: "src/lib/other.ts", lines: 10 }], baselineFor(before));
    expect(kinds(deleted.findings)).toEqual(["no-longer-over-budget"]);
    expect(deleted.findings[0].current).toMatch(/deleted, renamed, or moved out of src\//);
  });

  it("fails clearly when the baseline is missing rather than skipping enforcement", () => {
    const result = evaluateRatchet([{ file: "src/lib/big.ts", lines: 1200 }], null);
    expect(kinds(result.findings)).toEqual(["missing-baseline"]);
    expect(result.findings[0].severity).toBe("unusable");
    expect(result.findings[0].problem).toContain(BASELINE_PATH);
  });

  it("fails on a tracked src/ file the classifier does not recognise", () => {
    const unclassified = findUnclassifiedFiles([
      "src/lib/big.ts",
      "src/styles/app.css",
      "src/lib/mystery.rs",
      "src/lib/no-extension",
      "scripts/outside-scope.rs",
    ]);
    expect(unclassified.map((entry) => entry.file)).toEqual([
      "src/lib/mystery.rs",
      "src/lib/no-extension",
    ]);

    const tree: FileStat[] = [{ file: "src/lib/big.ts", lines: 1200 }];
    const result = evaluateRatchet(tree, baselineFor(tree), unclassified);
    expect(kinds(result.findings)).toEqual([
      "unclassified-source-file",
      "unclassified-source-file",
    ]);
    expect(result.findings[0].severity).toBe("unusable");
    expect(result.findings[0].action).toMatch(/SOURCE_EXTENSIONS/);
  });

  it("fails clearly when the scan finds no production files at all", () => {
    const result = evaluateRatchet([], "");
    expect(kinds(result.findings)).toEqual(["empty-scan"]);
    expect(result.findings[0].severity).toBe("unusable");
  });

  it("fails on a malformed baseline instead of comparing against a partial one", () => {
    const tree: FileStat[] = [{ file: "src/lib/big.ts", lines: 1200 }];
    const result = evaluateRatchet(tree, "# header\nsrc/lib/big.ts twelve-hundred domain-module\n");
    expect(kinds(result.findings)).toEqual(["malformed-baseline"]);
    expect(result.findings[0].severity).toBe("unusable");
  });

  it("refuses a baseline whose recorded budget category is not the one the path implies", () => {
    const tree: FileStat[] = [{ file: "src/app/api/big/route.ts", lines: 400 }];
    // Hand-edited from route-handler (250) to domain-module (700) so the file
    // would look within budget. Rejected, not obeyed.
    const result = evaluateRatchet(tree, "# header\nsrc/app/api/big/route.ts 400 domain-module\n");
    expect(kinds(result.findings)).toEqual(["malformed-baseline"]);
    expect(result.findings[0].problem).toMatch(/does not match the one this path implies/);
  });

  it("refuses a baseline entry that is not over its budget", () => {
    const tree: FileStat[] = [{ file: "src/lib/small.ts", lines: 100 }];
    const result = evaluateRatchet(tree, "# header\nsrc/lib/small.ts 100 domain-module\n");
    expect(kinds(result.findings)).toEqual(["malformed-baseline"]);
    expect(result.findings[0].problem).toMatch(/not over its budget/);
  });

  it("cannot be quietly curated: deleting a still-oversized record reads as new debt", () => {
    const tree: FileStat[] = [
      { file: "src/lib/a.ts", lines: 1200 },
      { file: "src/lib/b.ts", lines: 1300 },
    ];
    const curated = serializeBaseline([
      { file: "src/lib/a.ts", lines: 1200, slug: "domain-module" },
    ]);
    const result = evaluateRatchet(tree, curated);
    expect(kinds(result.findings)).toEqual(["new-over-budget"]);
    expect(result.findings[0].file).toBe("src/lib/b.ts");
  });

  it("rejects a hand-raised ceiling that the tree does not justify", () => {
    const tree: FileStat[] = [{ file: "src/lib/big.ts", lines: 1200 }];
    const inflated = serializeBaseline([
      { file: "src/lib/big.ts", lines: 5000, slug: "domain-module" },
    ]);
    expect(kinds(evaluateRatchet(tree, inflated).findings)).toEqual(["shrunk-below-baseline"]);
  });

  it("rejects a baseline whose records match but whose bytes do not", () => {
    const tree: FileStat[] = [{ file: "src/lib/big.ts", lines: 1200 }];
    const tampered = baselineFor(tree).replace(
      /^# File-size budget baseline.*$/m,
      "# nothing to see here",
    );
    const result = evaluateRatchet(tree, tampered);
    expect(kinds(result.findings)).toEqual(["malformed-baseline"]);
    expect(result.findings[0].problem).toMatch(/byte-identical/);
  });

  it("reports several regressions at once rather than stopping at the first", () => {
    const before: FileStat[] = [{ file: "src/lib/a.ts", lines: 1200 }];
    const after: FileStat[] = [
      { file: "src/lib/a.ts", lines: 1300 },
      { file: "src/lib/b.ts", lines: 800 },
      { file: "src/app/api/c/route.ts", lines: 300 },
    ];
    const result = evaluateRatchet(after, baselineFor(before));
    expect(result.findings).toHaveLength(3);
    expect(new Set(kinds(result.findings))).toEqual(
      new Set(["grown-beyond-baseline", "new-over-budget"]),
    );
  });
});

describe("the visible baseline-update escape", () => {
  it("refuses update when the reviewed baseline is missing and does not recreate it", () => {
    const root = createTrackedRepo("src/lib/original.ts", 800);
    try {
      rmSync(path.join(root, BASELINE_PATH));

      const refused = captureRun(root, ["--update"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("refusing baseline update");
      expect(refused.stderr).toContain("UNUSABLE");
      expect(refused.stderr).toContain("missing");
      expect(refused.stderr).toContain("No baseline bytes were written");
      expect(() => readFileSync(path.join(root, BASELINE_PATH), "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an untracked baseline instead of promoting it to reviewed truth", () => {
    const root = createTrackedRepo("src/lib/original.ts", 800);
    try {
      const original = readFileSync(path.join(root, BASELINE_PATH), "utf8");
      git(root, ["rm", "--cached", "--", BASELINE_PATH]);

      const refused = captureRun(root, ["--update"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("not tracked by git");
      expect(refused.stderr).toContain("No baseline bytes were written");
      expect(readFileSync(path.join(root, BASELINE_PATH), "utf8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not rewrite a malformed baseline while unrelated source debt grows", () => {
    const root = createTrackedRepo("src/lib/original.ts", 800);
    try {
      writeLines(root, "src/lib/unrelated-growth.ts", 850);
      git(root, ["add", "--", "src/lib/unrelated-growth.ts"]);
      const malformed = readFileSync(path.join(root, BASELINE_PATH), "utf8").replace(
        /^# File-size budget baseline.*$/m,
        "# corrupted header that is not the reviewed contract",
      );
      writeFileSync(path.join(root, BASELINE_PATH), malformed, "utf8");

      const refused = captureRun(root, ["--update"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("refusing baseline update");
      expect(refused.stderr).toContain("not byte-identical");
      expect(refused.stderr).toContain("No baseline bytes were written");
      expect(refused.stdout).not.toContain("Intentional baseline update");
      expect(readFileSync(path.join(root, BASELINE_PATH), "utf8")).toBe(malformed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a pure rename before update, then moves the ledger record with unchanged debt", () => {
    const root = createTrackedRepo("src/lib/original.ts", 800);
    try {
      git(root, ["mv", "src/lib/original.ts", "src/lib/renamed.ts"]);

      const refused = captureRun(root, []);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("src/lib/original.ts");
      expect(refused.stderr).toContain("src/lib/renamed.ts");
      expect(refused.stderr).toContain("REGRESSION");
      expect(refused.stderr).toContain("STALE BASELINE");

      const accepted = captureRun(root, ["--update"]);
      expect(accepted.code).toBe(0);
      expect(accepted.stdout).toContain("Intentional baseline update");
      expect(accepted.stdout).toContain("(unchanged)");
      expect(accepted.stdout).toContain("PRE-UPDATE REGRESSIONS ACCEPTED (1)");
      expect(accepted.stdout).toContain("src/lib/renamed.ts");

      const ledger = readFileSync(path.join(root, BASELINE_PATH), "utf8");
      expect(ledger).not.toContain("src/lib/original.ts 800 domain-module");
      expect(ledger).toContain("src/lib/renamed.ts 800 domain-module");
      const ledgerDiff = git(root, ["diff", "--", BASELINE_PATH]);
      expect(ledgerDiff).toContain("-src/lib/original.ts 800 domain-module");
      expect(ledgerDiff).toContain("+src/lib/renamed.ts 800 domain-module");
      expect(captureRun(root, []).code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses rename-and-grow before update, then exposes the positive debt delta and ledger change", () => {
    const root = createTrackedRepo("src/lib/original.ts", 800);
    try {
      git(root, ["mv", "src/lib/original.ts", "src/lib/renamed.ts"]);
      writeLines(root, "src/lib/renamed.ts", 850);

      const refused = captureRun(root, []);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("src/lib/renamed.ts");
      expect(refused.stderr).toContain("850 LOC, over by 150");
      expect(refused.stderr).toContain("src/lib/original.ts");

      const accepted = captureRun(root, ["--update"]);
      expect(accepted.code).toBe(0);
      expect(accepted.stdout).toContain("Intentional baseline update");
      expect(accepted.stdout).toContain("+50 vs the previous baseline");
      expect(accepted.stdout).toContain("PRE-UPDATE REGRESSIONS ACCEPTED (1)");
      expect(accepted.stdout).toContain("src/lib/renamed.ts");
      expect(accepted.stdout).toContain("The aggregate accepted debt also increased");

      const ledgerDiff = git(root, ["diff", "--", BASELINE_PATH]);
      expect(ledgerDiff).toContain("-src/lib/original.ts 800 domain-module");
      expect(ledgerDiff).toContain("+src/lib/renamed.ts 850 domain-module");
      expect(captureRun(root, []).code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still names rename-and-grow when a larger unrelated shrink makes aggregate debt fall", () => {
    const root = createTrackedRepo("src/lib/original.ts", 800);
    try {
      writeLines(root, "src/lib/shrinking.ts", 900);
      const initialBaseline = serializeBaseline(
        baselineEntriesFor([
          { file: "src/lib/original.ts", lines: 800 },
          { file: "src/lib/shrinking.ts", lines: 900 },
        ]),
      );
      writeFileSync(path.join(root, BASELINE_PATH), initialBaseline, "utf8");
      git(root, ["add", "--", "src/lib/shrinking.ts", BASELINE_PATH]);

      git(root, ["mv", "src/lib/original.ts", "src/lib/renamed.ts"]);
      writeLines(root, "src/lib/renamed.ts", 850);
      writeLines(root, "src/lib/shrinking.ts", 800);

      const refused = captureRun(root, []);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("src/lib/renamed.ts");
      expect(refused.stderr).toContain("src/lib/shrinking.ts");

      const accepted = captureRun(root, ["--update"]);
      expect(accepted.code).toBe(0);
      expect(accepted.stdout).toContain("-50 vs the previous baseline");
      expect(accepted.stdout).toContain("PRE-UPDATE REGRESSIONS ACCEPTED (1)");
      expect(accepted.stdout).toContain("src/lib/renamed.ts");
      expect(accepted.stdout).toContain("850 LOC, over by 150");
      expect(accepted.stdout).toContain(
        "An aggregate debt decrease does not cancel a regression above",
      );
      expect(accepted.stdout).not.toContain("The aggregate accepted debt also increased");

      const ledgerDiff = git(root, ["diff", "--", BASELINE_PATH]);
      expect(ledgerDiff).toContain("-src/lib/original.ts 800 domain-module");
      expect(ledgerDiff).toContain("+src/lib/renamed.ts 850 domain-module");
      expect(ledgerDiff).toContain("-src/lib/shrinking.ts 900 domain-module");
      expect(ledgerDiff).toContain("+src/lib/shrinking.ts 800 domain-module");
      expect(captureRun(root, []).code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the committed baseline in this repository", () => {
  it("describes the current tree exactly", () => {
    const scan = scanRepository(REPO_ROOT);
    const committed = readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const result = evaluateRatchet(scan.productionStats, committed, scan.unclassified);
    const summary = result.findings
      .map((finding) => `${finding.severity} ${finding.kind} ${finding.file}: ${finding.problem}`)
      .join("\n");
    expect(summary).toBe("");
    expect(result.scannedFiles).toBeGreaterThan(1000);
    expect(result.oversizedFiles).toBeGreaterThan(0);
  });

  it("is tracked by git and is the only place the accepted debt is recorded", () => {
    const tracked = execFileSync("git", ["ls-files", "--error-unmatch", BASELINE_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(tracked.trim()).toBe(BASELINE_PATH);
  });

  it("covers files in every budget category, so no category is silently unenforced", () => {
    const scan = scanRepository(REPO_ROOT);
    const slugs = new Set(baselineEntriesFor(scan.productionStats).map((entry) => entry.slug));
    expect([...slugs].sort()).toEqual(["domain-module", "route-handler", "route-page-shell"]);
  });

  it("classifies every tracked file under src/, leaving no scope hole", () => {
    const scan = scanRepository(REPO_ROOT);
    expect(scan.gitError).toBeNull();
    expect(scan.unclassified).toEqual([]);
    expect(scan.trackedFiles.filter((file) => file.startsWith("src/")).length).toBeGreaterThan(
      3000,
    );
  });

  it("reports a git failure instead of throwing out of the scan", () => {
    const scan = scanRepository(path.join(REPO_ROOT, "no-such-directory-2687"));
    expect(scan.gitError).not.toBeNull();
    expect(scan.productionStats).toEqual([]);
  });
});
