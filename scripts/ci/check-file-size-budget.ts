#!/usr/bin/env -S npx tsx
/**
 * File-size budget ratchet — the blocking half (#2687).
 *
 * `npm run quality:budget`        verify the tree against the committed baseline
 * `npm run quality:budget:update` regenerate the baseline from the tree
 *
 * The rule, in one sentence: current size debt may stay, but new debt and debt
 * growth may not appear silently. A file that is not in the baseline may not go
 * over its documented budget, and a file that is in the baseline may not exceed
 * the number recorded there. Shrinking is always allowed and lowers the ceiling.
 *
 * Exits 1 on any finding, including a missing, stale or malformed baseline —
 * an enforcement tool that cannot trust its own input must fail loudly rather
 * than report a clean run it has not earned.
 *
 * Reads `git ls-files` and the working tree only: no network, no build, no
 * database, no provider.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BASELINE_PATH,
  CHECK_COMMAND,
  UPDATE_COMMAND,
  collectProductionStats,
  evaluateRatchet,
  listTrackedFiles,
  type RatchetFinding,
  type RatchetSeverity,
} from "../lib/file-size-budget";

const SEVERITY_HEADINGS: Record<RatchetSeverity, string> = {
  unusable: "UNUSABLE BASELINE — the comparison cannot be trusted",
  regression: "REGRESSION — new or growing size debt",
  stale: "STALE BASELINE — the tree improved and the ledger did not follow",
};

/** CRLF-tolerant read. Returns null when the baseline is absent. */
export function readBaseline(root: string): string | null {
  try {
    return readFileSync(path.join(root, BASELINE_PATH), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

export function renderFinding(finding: RatchetFinding): string {
  const lines: string[] = [`  ${finding.file ?? BASELINE_PATH}`];
  lines.push(`      problem:  ${finding.problem}`);
  if (finding.budget) lines.push(`      budget:   ${finding.budget}`);
  if (finding.baseline) lines.push(`      baseline: ${finding.baseline}`);
  if (finding.current) lines.push(`      current:  ${finding.current}`);
  lines.push(`      action:   ${finding.action}`);
  return lines.join("\n");
}

export function renderReport(findings: readonly RatchetFinding[]): string {
  const out: string[] = [];
  const order: RatchetSeverity[] = ["unusable", "regression", "stale"];
  for (const severity of order) {
    const group = findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    out.push("");
    out.push(`${SEVERITY_HEADINGS[severity]} (${group.length})`);
    out.push("");
    for (const finding of group) {
      out.push(renderFinding(finding));
      out.push("");
    }
  }
  return out.join("\n");
}

function writeBaseline(root: string, content: string): void {
  const target = path.join(root, BASELINE_PATH);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

export function run(root: string, argv: readonly string[]): number {
  const update = argv.includes("--update");
  const stats = collectProductionStats(root);
  const before = readBaseline(root);
  const result = evaluateRatchet(stats, before);

  if (update) {
    if (result.scannedFiles === 0) {
      process.stderr.write(
        "File-size budget: refusing to write a baseline from an empty scan.\n" +
          "Run this from the repository root inside a git checkout.\n",
      );
      return 1;
    }
    writeBaseline(root, result.regenerated);
    const delta =
      result.baselineOverage === null
        ? null
        : result.currentOverage - result.baselineOverage;
    process.stdout.write(
      [
        `File-size budget: wrote ${BASELINE_PATH}`,
        `  ${result.oversizedFiles} of ${result.scannedFiles} production files are over budget`,
        `  ${result.currentOverage} lines of accepted debt in total` +
          (delta === null
            ? " (no comparable previous baseline)"
            : delta === 0
              ? " (unchanged)"
              : ` (${delta > 0 ? "+" : ""}${delta} vs the previous baseline)`),
        delta !== null && delta > 0
          ? "  This PR ACCEPTS more size debt. Say in the PR body why splitting is worse here."
          : "",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n") + "\n",
    );
    return 0;
  }

  // A baseline that exists locally but is not staged reads as a clean run here
  // and as a missing baseline in CI. Say it locally, where it is cheap to fix.
  const findings =
    before !== null && !listTrackedFiles(root).includes(BASELINE_PATH)
      ? [
          ...result.findings,
          {
            severity: "unusable" as const,
            kind: "missing-baseline" as const,
            file: BASELINE_PATH,
            budget: null,
            baseline: "present in the working tree but not tracked by git",
            current: null,
            problem:
              "CI checks out tracked files only, so it would see no baseline at all and this local pass would not reproduce",
            action: `\`git add ${BASELINE_PATH}\``,
          },
        ]
      : result.findings;

  if (findings.length === 0) {
    process.stdout.write(
      `File-size budget ratchet: OK — ${result.oversizedFiles} of ${result.scannedFiles} ` +
        `production files carry size debt (${result.currentOverage} lines), all at or below ` +
        `their committed ceiling in ${BASELINE_PATH}.\n`,
    );
    return 0;
  }

  process.stderr.write(
    `File-size budget ratchet: FAILED — ${findings.length} finding(s) ` +
      `against ${BASELINE_PATH}.\n` +
      `Scanned ${result.scannedFiles} production files; ${result.oversizedFiles} are over budget.\n`,
  );
  process.stderr.write(renderReport(findings));
  process.stderr.write(
    [
      "",
      "The rule: current size debt may stay, but new debt and debt growth may not",
      "appear silently. See docs/MAINTENANCE.md -> \"File-size budget ratchet\".",
      "",
      `  ${CHECK_COMMAND}          re-run this check`,
      `  ${UPDATE_COMMAND}   regenerate the baseline (then explain any increase in the PR body)`,
      "",
    ].join("\n"),
  );
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exitCode = run(process.cwd(), process.argv.slice(2));
}
