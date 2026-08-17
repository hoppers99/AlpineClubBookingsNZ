#!/usr/bin/env -S npx tsx
/**
 * File-size budget ratchet — the blocking half (#2687).
 *
 * `npm run quality:budget`        verify the tree against the committed baseline
 * `npm run quality:budget:update` intentionally accept the tree as the new,
 *                                 review-visible baseline
 *
 * The rule, in one sentence: current size debt may stay, but new debt and debt
 * growth may not appear silently. A file that is not in the baseline may not go
 * over its documented budget, and a file that is in the baseline may not exceed
 * the number recorded there. Shrinking is always allowed; regeneration records
 * the lower ceiling.
 *
 * Exits 1 on any finding, including a missing, stale or malformed baseline —
 * an enforcement tool that cannot trust its own input must fail loudly rather
 * than report a clean run it has not earned.
 *
 * Reads `git ls-files` and the working tree only: no network, no build, no
 * database, no provider.
 *
 * Update mode is the owner-approved escape, not another verification mode. It
 * deliberately writes the tree even when verification found new or growing
 * debt, because an exceptional increase has to be possible. It refuses an
 * unusable starting comparison (missing, malformed or untracked baseline,
 * empty scan, or unclassified source), because rewriting that state would
 * erase the findings the update is meant to expose. The resulting
 * added/removed/changed ledger records, every pre-update regression listed
 * separately, and the aggregate debt delta printed below are the evidence a
 * reviewer accepts. A shrink elsewhere never cancels a grown record's warning.
 * CI never runs update mode.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BASELINE_PATH,
  CHECK_COMMAND,
  UPDATE_COMMAND,
  evaluateRatchet,
  scanRepository,
  type RatchetFinding,
  type RatchetSeverity,
} from "../lib/file-size-budget";

const SEVERITY_HEADINGS: Record<RatchetSeverity, string> = {
  unusable: "UNUSABLE — the comparison cannot be trusted",
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

function renderAcceptedRegressions(findings: readonly RatchetFinding[]): string[] {
  const regressions = findings.filter((finding) => finding.severity === "regression");
  if (regressions.length === 0) return [];

  const lines = [
    `  PRE-UPDATE REGRESSIONS ACCEPTED (${regressions.length}) — review each record independently:`,
  ];
  for (const finding of regressions) {
    lines.push(`    ${finding.file ?? BASELINE_PATH}`);
    lines.push(`      problem:  ${finding.problem}`);
    if (finding.budget) lines.push(`      budget:   ${finding.budget}`);
    if (finding.baseline) lines.push(`      baseline: ${finding.baseline}`);
    if (finding.current) lines.push(`      current:  ${finding.current}`);
  }
  lines.push(
    "  An aggregate debt decrease does not cancel a regression above. Explain every accepted increase in the PR body.",
  );
  return lines;
}

export function run(root: string, argv: readonly string[]): number {
  const update = argv.includes("--update");
  const scan = scanRepository(root);

  // Run outside a checkout this used to die with an unhandled `fatal: not a git
  // repository` stack trace. Fail-closed either way, but a crash and a finding
  // should not be told apart only by whoever is reading the log carefully.
  if (scan.gitError !== null) {
    process.stderr.write(
      "File-size budget: could not list tracked files, so nothing was checked.\n" +
        `  ${scan.gitError.split("\n")[0]}\n` +
        "  Run this from the repository root inside a git checkout.\n",
    );
    return 1;
  }

  const before = readBaseline(root);
  const result = evaluateRatchet(scan.productionStats, before, scan.unclassified);

  // A working-tree-only ledger is no comparison at all in CI. Treat tracking
  // as part of baseline usability in both modes; otherwise `--update` can turn
  // an unreviewed local file into the source of truth without ever comparing
  // against the committed ledger.
  const findings =
    before !== null && !scan.trackedFiles.includes(BASELINE_PATH)
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
              "CI checks out tracked files only, so this baseline cannot be the trusted comparison",
            action: `restore the tracked ${BASELINE_PATH} from git before updating it`,
          },
        ]
      : result.findings;

  if (update) {
    const unusable = findings.filter((finding) => finding.severity === "unusable");
    if (unusable.length > 0) {
      process.stderr.write(
        `File-size budget: refusing baseline update because the previous baseline or scan is unusable (${unusable.length} finding(s)).\n` +
          "An intentional update may accept visible regressions or stale records only after a trusted comparison.\n" +
          renderReport(unusable) +
          "\nNo baseline bytes were written.\n",
      );
      return 1;
    }
    writeBaseline(root, result.regenerated);
    const delta =
      result.baselineOverage === null
        ? null
        : result.currentOverage - result.baselineOverage;
    const acceptedRegressions = renderAcceptedRegressions(result.findings);
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
        "  Intentional baseline update: review the ledger diff; this is not a verification pass.",
        ...acceptedRegressions,
        acceptedRegressions.length > 0 && delta !== null && delta > 0
          ? "  The aggregate accepted debt also increased; the net total is context, not a substitute for the per-record review above."
          : "",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n") + "\n",
    );
    return 0;
  }

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
