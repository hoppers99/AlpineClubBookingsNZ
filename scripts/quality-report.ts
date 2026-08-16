#!/usr/bin/env -S npx tsx
/**
 * Maintainability quality report.
 *
 * Scans tracked production and test files for size and suppression hotspots,
 * then prints a markdown summary. Uses `git ls-files` and `fs` only — no
 * external services, no network, no production build.
 *
 * Budgets, classification and the committed baseline all come from
 * `scripts/lib/file-size-budget.ts`, which is the same module the blocking gate
 * uses. That is deliberate: this report and `npm run quality:budget` must never
 * be able to disagree about which files are over budget (#2687).
 *
 * Exit status is always 0: this is the warn-and-inform half. The half that
 * fails CI is `scripts/ci/check-file-size-budget.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BASELINE_PATH,
  CHECK_COMMAND,
  PRODUCTION_LIMIT,
  ROUTE_HANDLER_LIMIT,
  ROUTE_PAGE_LIMIT,
  budgetForFile,
  evaluateRatchet,
  isProductionFile,
  isRatchetExcludedTestFile,
  isRouteHandler,
  isRoutePage,
  countLines,
  scanRepository,
  type FileStat,
  type OversizedFileStat,
  type RatchetFinding,
} from "./lib/file-size-budget";

const ROOT = process.cwd();

const TOP_N = 10;

function topBy<T>(items: T[], score: (item: T) => number, n: number): T[] {
  return [...items].sort((a, b) => score(b) - score(a)).slice(0, n);
}

type Suppression = {
  file: string;
  line: number;
  snippet: string;
  kind: string;
};

const ANY_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "as any", pattern: /\bas\s+any\b/ },
  { kind: ": any", pattern: /:\s*any\b/ },
  { kind: "<any>", pattern: /<\s*any\s*>/ },
  { kind: "@ts-ignore", pattern: /@ts-ignore\b/ },
  { kind: "@ts-expect-error", pattern: /@ts-expect-error\b/ },
  { kind: "@ts-nocheck", pattern: /@ts-nocheck\b/ },
];

function scanSuppressions(file: string): {
  any: Suppression[];
  eslintDisable: Suppression[];
} {
  const any: Suppression[] = [];
  const eslintDisable: Suppression[] = [];
  let body: string;
  try {
    body = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return { any, eslintDisable };
  }
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const { kind, pattern } of ANY_PATTERNS) {
      if (pattern.test(line)) {
        any.push({
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 160),
          kind,
        });
      }
    }
    if (/eslint-disable\b/.test(line)) {
      eslintDisable.push({
        file,
        line: i + 1,
        snippet: line.trim().slice(0, 160),
        kind: "eslint-disable",
      });
    }
  }
  return { any, eslintDisable };
}

function renderTable(rows: string[][], headers: string[]): string {
  if (rows.length === 0) return "_No entries._";
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const pad = (cell: string, w: number) => cell.padEnd(w);
  const lines = [
    `| ${headers.map((h, i) => pad(h, widths[i])).join(" | ")} |`,
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(
      (row) => `| ${row.map((c, i) => pad(c ?? "", widths[i])).join(" | ")} |`,
    ),
  ];
  return lines.join("\n");
}

function renderFlaggedTable(
  stats: FileStat[],
  limit: number,
  budgetName: string,
): string {
  const rows = stats.map((s) => [
    s.file,
    String(s.lines),
    s.lines > limit ? "yes" : "no",
  ]);
  return [
    `Budget: <= ${limit} LOC (${budgetName})`,
    "",
    renderTable(rows, ["File", "LOC", "Over budget"]),
  ].join("\n");
}

function renderBudgetedProductionTable(stats: FileStat[]): string {
  const rows = stats.map((s) => {
    const budget = budgetForFile(s.file);
    return [
      s.file,
      String(s.lines),
      budget.category,
      String(budget.limit),
      s.lines > budget.limit ? "yes" : "no",
    ];
  });
  return [
    `Budgets: route handlers <= ${ROUTE_HANDLER_LIMIT} LOC; page shells <= ${ROUTE_PAGE_LIMIT} LOC; new domain modules <= ${PRODUCTION_LIMIT} LOC.`,
    "",
    renderTable(rows, ["File", "LOC", "Budget", "Limit", "Over budget"]),
  ].join("\n");
}

function renderOversizedTable(stats: OversizedFileStat[]): string {
  return renderTable(
    stats.map((s) => [
      s.file,
      String(s.lines),
      s.category,
      String(s.limit),
      String(s.overBy),
    ]),
    ["File", "LOC", "Budget", "Limit", "Over by"],
  );
}

function renderRatchetTable(findings: readonly RatchetFinding[]): string {
  return renderTable(
    findings.map((finding) => [
      finding.file ?? BASELINE_PATH,
      finding.severity,
      finding.budget ?? "-",
      finding.baseline ?? "-",
      finding.current ?? "-",
      finding.problem,
    ]),
    ["File", "Severity", "Budget", "Baseline", "Current", "Problem"],
  );
}

function readBaseline(): string | null {
  try {
    return readFileSync(path.join(ROOT, BASELINE_PATH), "utf8").replace(
      /\r\n/g,
      "\n",
    );
  } catch {
    return null;
  }
}

export function main() {
  const scan = scanRepository(ROOT);
  const files = scan.trackedFiles;
  const productionStats = scan.productionStats;
  const testStats: FileStat[] = files
    .filter(isRatchetExcludedTestFile)
    .map((file) => ({ file, lines: countLines(ROOT, file) }));
  const routeHandlerStats: FileStat[] = productionStats.filter((s) =>
    isRouteHandler(s.file),
  );
  const routePageStats: FileStat[] = productionStats.filter((s) =>
    isRoutePage(s.file),
  );

  const allAny: Suppression[] = [];
  const allEslintDisable: Suppression[] = [];
  let testAnyCount = 0;

  for (const file of files) {
    if (!isProductionFile(file) && !isRatchetExcludedTestFile(file)) continue;
    const { any, eslintDisable } = scanSuppressions(file);
    if (isProductionFile(file)) {
      allAny.push(...any);
      allEslintDisable.push(...eslintDisable);
    } else {
      testAnyCount += any.filter((a) => a.kind === "as any").length;
    }
  }

  const totalProdLoc = productionStats.reduce((sum, s) => sum + s.lines, 0);
  const totalTestLoc = testStats.reduce((sum, s) => sum + s.lines, 0);
  const overBudgetModules = productionStats.filter(
    (s) =>
      s.lines > PRODUCTION_LIMIT &&
      !isRouteHandler(s.file) &&
      !isRoutePage(s.file),
  );
  const overBudgetHandlers = routeHandlerStats.filter(
    (s) => s.lines > ROUTE_HANDLER_LIMIT,
  );
  const overBudgetPages = routePageStats.filter(
    (s) => s.lines > ROUTE_PAGE_LIMIT,
  );
  const ratchet = evaluateRatchet(
    productionStats,
    readBaseline(),
    scan.unclassified,
  );
  const regressions = ratchet.findings.filter(
    (finding) => finding.severity === "regression",
  );

  const lines: string[] = [];
  lines.push("# Quality report");
  lines.push("");
  lines.push(
    `_Generated from \`git ls-files\` — no external services, no network._`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    renderTable(
      [
        ["Production files (src/)", String(productionStats.length)],
        ["Production LOC (src/)", String(totalProdLoc)],
        ["Test files (src/ and scripts/)", String(testStats.length)],
        ["Test LOC (src/ and scripts/)", String(totalTestLoc)],
        ["Route handlers", String(routeHandlerStats.length)],
        ["App Router pages", String(routePageStats.length)],
        ["Production `any` / type suppressions", String(allAny.length)],
        ["Production `eslint-disable` lines", String(allEslintDisable.length)],
        ["Test `as any` occurrences", String(testAnyCount)],
        [
          `Modules over ${PRODUCTION_LIMIT} LOC budget`,
          String(overBudgetModules.length),
        ],
        [
          `Route handlers over ${ROUTE_HANDLER_LIMIT} LOC budget`,
          String(overBudgetHandlers.length),
        ],
        [
          `Pages over ${ROUTE_PAGE_LIMIT} LOC budget`,
          String(overBudgetPages.length),
        ],
        ["Files over budget (all categories)", String(ratchet.oversizedFiles)],
        [
          "Accepted size debt (LOC over budget)",
          String(ratchet.currentOverage),
        ],
        ["Ratchet findings", String(ratchet.findings.length)],
        ["…of which regressions", String(regressions.length)],
      ],
      ["Metric", "Value"],
    ),
  );
  lines.push("");

  lines.push("## File-size budget ratchet");
  lines.push("");
  lines.push(
    `_Compared against the committed baseline \`${BASELINE_PATH}\`. This report never fails; ` +
      `\`${CHECK_COMMAND}\` runs the same comparison and does._`,
  );
  lines.push("");
  lines.push(renderRatchetTable(ratchet.findings));
  lines.push("");

  lines.push("## Largest production files");
  lines.push("");
  lines.push(
    renderBudgetedProductionTable(
      topBy(productionStats, (s) => s.lines, TOP_N),
    ),
  );
  lines.push("");

  lines.push("## Largest oversized files");
  lines.push("");
  lines.push(
    renderOversizedTable(
      topBy(
        productionStats
          .map((stat) => {
            const budget = budgetForFile(stat.file);
            return { ...stat, ...budget, overBy: stat.lines - budget.limit };
          })
          .filter((stat) => stat.overBy > 0),
        (s) => s.overBy,
        TOP_N,
      ),
    ),
  );
  lines.push("");

  lines.push("## Largest route handlers");
  lines.push("");
  lines.push(
    renderFlaggedTable(
      topBy(routeHandlerStats, (s) => s.lines, TOP_N),
      ROUTE_HANDLER_LIMIT,
      "route handler",
    ),
  );
  lines.push("");

  lines.push("## Largest App Router pages");
  lines.push("");
  lines.push(
    renderFlaggedTable(
      topBy(routePageStats, (s) => s.lines, TOP_N),
      ROUTE_PAGE_LIMIT,
      "route page shell",
    ),
  );
  lines.push("");

  lines.push("## Largest test files");
  lines.push("");
  lines.push(
    renderTable(
      topBy(testStats, (s) => s.lines, TOP_N).map((s) => [
        s.file,
        String(s.lines),
      ]),
      ["File", "LOC"],
    ),
  );
  lines.push("");

  lines.push("## Production `any` / type suppression hotspots");
  lines.push("");
  const anyByFile = new Map<string, number>();
  for (const item of allAny) {
    anyByFile.set(item.file, (anyByFile.get(item.file) ?? 0) + 1);
  }
  const anyTopFiles = [...anyByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N);
  lines.push(
    renderTable(
      anyTopFiles.map(([file, count]) => [file, String(count)]),
      ["File", "Suppressions"],
    ),
  );
  lines.push("");

  lines.push("## Production `eslint-disable` hotspots");
  lines.push("");
  const eslintByFile = new Map<string, number>();
  for (const item of allEslintDisable) {
    eslintByFile.set(item.file, (eslintByFile.get(item.file) ?? 0) + 1);
  }
  const eslintTopFiles = [...eslintByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N);
  lines.push(
    renderTable(
      eslintTopFiles.map(([file, count]) => [file, String(count)]),
      ["File", "Disables"],
    ),
  );
  lines.push("");

  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- The documented budgets are the long-term target. What CI enforces is the ratchet: a file not in the baseline may not go over budget, and a file in it may not exceed its recorded ceiling.",
  );
  lines.push(
    "- New production code should not add `any` or `eslint-disable` without a local justification comment.",
  );
  lines.push(
    "- For oversized files, prefer extracting cohesive helpers into `src/lib` modules before adding new functionality.",
  );
  lines.push(
    `- Shrinking an oversized file lowers its ceiling: regenerate with \`npm run quality:budget:update\` so the lower number is what the next change is measured against.`,
  );

  process.stdout.write(lines.join("\n") + "\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
