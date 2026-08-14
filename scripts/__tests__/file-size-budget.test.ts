import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BASELINE_PATH,
  PRODUCTION_LIMIT,
  ROUTE_HANDLER_LIMIT,
  ROUTE_PAGE_LIMIT,
  baselineEntriesFor,
  budgetForFile,
  collectProductionStats,
  evaluateRatchet,
  findOversizedProductionFiles,
  parseBaseline,
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

  it("rejects every hand-edit shape that would make the file unreliable", () => {
    const cases: Array<[string, RegExp]> = [
      ["src/lib/a.ts 800", /expected 3 space-separated fields/],
      ["src/lib/a.ts 800 domain-module extra", /expected 3 space-separated fields/],
      ["src/lib/a.ts eight-hundred domain-module", /positive integer/],
      ["src/lib/a.ts 0 domain-module", /positive integer/],
      ["src/lib/a.ts -5 domain-module", /positive integer/],
      ["src/lib/a.ts 800 tiny-module", /unknown budget category/],
      ["scripts/a.ts 800 domain-module", /repo-relative src\/ path/],
      ["src\\lib\\a.ts 800 domain-module", /repo-relative src\/ path/],
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

describe("the committed baseline in this repository", () => {
  it("describes the current tree exactly", () => {
    const stats = collectProductionStats(REPO_ROOT);
    const committed = readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const result = evaluateRatchet(stats, committed);
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
    const stats = collectProductionStats(REPO_ROOT);
    const slugs = new Set(baselineEntriesFor(stats).map((entry) => entry.slug));
    expect([...slugs].sort()).toEqual(["domain-module", "route-handler", "route-page-shell"]);
  });
});
