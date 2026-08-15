/**
 * File-size budget ratchet (#2687).
 *
 * One place that knows what the documented size budgets are, which files they
 * apply to, and how the committed baseline is serialised. Both the advisory
 * report (`scripts/quality-report.ts`) and the blocking CI gate
 * (`scripts/ci/check-file-size-budget.ts`) import from here, so the number the
 * report prints and the number the gate enforces cannot drift apart.
 *
 * Scope, stated once so nothing ever needs a per-issue exemption: the policy
 * covers tracked source under `src/` only, excluding tests, in any of the
 * extensions in `SOURCE_EXTENSIONS`, and a tracked `src/` file carrying an
 * extension the classifier does not recognise fails the check rather than
 * dropping quietly out of scope. Everything
 * outside `src/` — `scripts/`, `prisma/`, `e2e/`, `load/`, `measurement/` — is
 * outside the file-size policy by definition. That is what makes a temporary
 * measurement tree (#2663) a non-event for this gate: it is not in scope when
 * it is added and it is not in scope when it is deleted, so there is nothing to
 * regenerate and nothing to hide.
 *
 * Uses `git ls-files` and `fs` only — no network, no build, no database.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Budgets, from `docs/MAINTENANCE.md`. */
export const PRODUCTION_LIMIT = 700;
export const ROUTE_HANDLER_LIMIT = 250;
export const ROUTE_PAGE_LIMIT = 500;

/** Repo-relative path of the committed baseline. */
export const BASELINE_PATH = "scripts/quality/file-size-baseline.txt";

/** Command names quoted in every failure message and in the baseline header. */
export const CHECK_COMMAND = "npm run quality:budget";
export const UPDATE_COMMAND = "npm run quality:budget:update";

export type BudgetCategory = "domain module" | "route handler" | "route page shell";
export type BudgetSlug = "domain-module" | "route-handler" | "route-page-shell";

export type Budget = {
  category: BudgetCategory;
  slug: BudgetSlug;
  limit: number;
};

const BUDGETS: Record<BudgetSlug, Budget> = {
  "domain-module": {
    category: "domain module",
    slug: "domain-module",
    limit: PRODUCTION_LIMIT,
  },
  "route-handler": {
    category: "route handler",
    slug: "route-handler",
    limit: ROUTE_HANDLER_LIMIT,
  },
  "route-page-shell": {
    category: "route page shell",
    slug: "route-page-shell",
    limit: ROUTE_PAGE_LIMIT,
  },
};

const BUDGET_SLUGS = Object.keys(BUDGETS) as BudgetSlug[];

export type FileStat = { file: string; lines: number };
export type OversizedFileStat = FileStat & Budget & { overBy: number };

/**
 * Every executable-source extension the budgets apply to.
 *
 * Keyed on `ts|tsx` alone, this classifier had a hole wide enough to drive the
 * whole gate through: `git mv src/lib/audit.ts src/lib/audit.js` took a
 * baselined 745-line file out of scope entirely, and the tool then reported the
 * disappearance as a 45-line *reduction* in accepted debt — one deleted
 * baseline line, which is exactly what `docs/MAINTENANCE.md` teaches reviewers
 * to read as progress. The file could then grow 500 lines with the gate green.
 * It was reachable, not theoretical: Next's default `pageExtensions` is
 * `['tsx','ts','jsx','js']` and `next.config.ts` overrides nothing, so
 * `route.js` and `page.jsx` are served normally; `tsconfig.json` sets
 * `allowJs: true` and its `include` names `.mts` explicitly; and every custom
 * lint rule block is scoped to `.ts`/`.tsx` under `src`, so a `.js` file there
 * was policed by nothing at all — not the ratchet, not the lint rules, not tsc.
 *
 * Widening this set is zero churn today — tracked `src/` is 2500 `.ts`, 874
 * `.tsx`, 2 `.css`, 1 `.md`, 1 `.json` — but the set is still a list, and a
 * list rots. `findUnclassifiedFiles` is what stops it rotting: any tracked
 * `src/` file whose extension appears in neither this set nor
 * `NON_SOURCE_EXTENSIONS` fails the gate rather than slipping silently out of
 * scope.
 */
const SOURCE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
] as const;

/**
 * Non-source file kinds that legitimately live under `src/`. Deliberately
 * short: anything not listed here and not a source extension fails the scope
 * audit, which forces a decision instead of a silent exemption. `.mdx` is
 * absent on purpose — it can carry components, so it should be classified
 * consciously if one ever lands.
 */
const NON_SOURCE_EXTENSIONS = new Set([
  "avif",
  "css",
  "csv",
  "gif",
  "html",
  "ico",
  "jpeg",
  "jpg",
  "json",
  "md",
  "otf",
  "png",
  "scss",
  "sql",
  "svg",
  "ttf",
  "txt",
  "webp",
  "woff",
  "woff2",
  "yaml",
  "yml",
]);

const EXT = SOURCE_EXTENSIONS.join("|");
const SOURCE_FILE_PATTERN = new RegExp(`\\.(${EXT})$`);
const TEST_FILE_PATTERN = new RegExp(`\\.(test|spec)\\.(${EXT})$`);
// `(.*\/)?` rather than `.*\/`: the latter required at least one directory
// after `src/app/`, so a root-level `src/app/route.ts` silently inherited the
// 700-LOC domain-module budget instead of 250.
const ROUTE_HANDLER_PATTERN = new RegExp(`^src\\/app\\/(.*\\/)?route\\.(${EXT})$`);
const ROUTE_PAGE_PATTERN = new RegExp(`^src\\/app\\/(.*\\/)?page\\.(${EXT})$`);

function extensionOf(file: string): string | null {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return base.slice(dot + 1).toLowerCase();
}

export function isProductionFile(file: string): boolean {
  if (!file.startsWith("src/")) return false;
  if (!SOURCE_FILE_PATTERN.test(file)) return false;
  if (file.includes("/__tests__/")) return false;
  if (TEST_FILE_PATTERN.test(file)) return false;
  return true;
}

export function isTestFile(file: string): boolean {
  if (!file.startsWith("src/")) return false;
  if (!SOURCE_FILE_PATTERN.test(file)) return false;
  return file.includes("/__tests__/") || TEST_FILE_PATTERN.test(file);
}

export function isRouteHandler(file: string): boolean {
  return ROUTE_HANDLER_PATTERN.test(file);
}

export function isRoutePage(file: string): boolean {
  return ROUTE_PAGE_PATTERN.test(file);
}

/**
 * Why the baseline format cannot hold this path, or null when it can.
 *
 * Shared by the parser and the scope audit so the read side and the write side
 * agree. Spaces are fine — `parseBaseline` takes the path greedily — but a tab
 * or a newline cannot round-trip through a line-based format at all, so such a
 * path is reported rather than written out as a record nothing can read back.
 */
export function pathProblem(file: string): string | null {
  // Backslash first: a Windows-style path should be told to use forward
  // slashes, not that it is outside src/ — which it also is, less usefully.
  if (file.includes("\\")) return "path must use forward slashes";
  if (!file.startsWith("src/")) {
    return "path must be a repo-relative path under src/";
  }
  if (/[\t\r\n]/.test(file)) {
    return "path contains a tab or newline, which a line-based baseline cannot represent";
  }
  if (file.endsWith("/")) return "path must name a file, not a directory";
  if (file.includes("//") || file.split("/").includes("..")) {
    return "path must be normalised";
  }
  return null;
}

/**
 * Tracked `src/` files the classifier does not recognise — neither source it
 * budgets nor a declared non-source kind — plus any whose path the baseline
 * format cannot represent. Both are scope holes, and a scope hole in a gate
 * reads exactly like a clean pass.
 */
export function findUnclassifiedFiles(
  trackedFiles: readonly string[],
): Array<{ file: string; reason: string }> {
  const out: Array<{ file: string; reason: string }> = [];
  for (const file of trackedFiles) {
    if (!file.startsWith("src/")) continue;
    const extension = extensionOf(file);
    if (extension === null) {
      out.push({
        file,
        reason: "no file extension, so the classifier cannot tell source from asset",
      });
      continue;
    }
    if (SOURCE_FILE_PATTERN.test(file)) {
      const problem = pathProblem(file);
      if (problem) out.push({ file, reason: problem });
      continue;
    }
    if (NON_SOURCE_EXTENSIONS.has(extension)) continue;
    out.push({
      file,
      reason: `unrecognised extension .${extension} — it is in no budget, so nothing measures it`,
    });
  }
  return out.sort((a, b) => compare(a.file, b.file));
}

/**
 * Which budget applies to a path. Derived from the path every time and never
 * read back from the baseline: a recorded category is verified against this,
 * so hand-editing one to a laxer budget is a malformed baseline, not a
 * shortcut.
 */
export function budgetForFile(file: string): Budget {
  if (isRouteHandler(file)) return BUDGETS["route-handler"];
  if (isRoutePage(file)) return BUDGETS["route-page-shell"];
  return BUDGETS["domain-module"];
}

export function describeBudget(budget: Budget): string {
  return `${budget.category}, <= ${budget.limit} LOC`;
}

/**
 * Physical lines in a file. Counts `\n` bytes, so a CRLF working tree on
 * Windows and an LF one on Linux CI agree (#2399 taught this repository what
 * happens when they do not).
 */
export function countLines(root: string, file: string): number {
  let buf: Buffer;
  try {
    buf = readFileSync(path.join(root, file));
  } catch {
    return 0;
  }
  if (buf.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) count += 1;
  }
  if (buf[buf.length - 1] !== 0x0a) count += 1;
  return count;
}

/** Tracked files, NUL-separated so a path needing quoting cannot be misread. */
function listTrackedFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function existsInTree(root: string, file: string): boolean {
  try {
    statSync(path.join(root, file));
    return true;
  } catch {
    return false;
  }
}

export type RepositoryScan = {
  trackedFiles: string[];
  productionStats: FileStat[];
  unclassified: Array<{ file: string; reason: string }>;
  /** Why `git ls-files` could not be run, or null when it ran. */
  gitError: string | null;
};

/**
 * One `git ls-files` call, everything derived from it.
 *
 * A failed git invocation is caught rather than thrown: run outside a checkout,
 * this used to die with an unhandled `fatal: not a git repository` stack trace.
 * That was still fail-closed, but "gate crashed" and "gate found a problem"
 * should not look different to whoever reads the log.
 */
export function scanRepository(root: string): RepositoryScan {
  let trackedFiles: string[];
  try {
    trackedFiles = listTrackedFiles(root);
  } catch (error) {
    return {
      trackedFiles: [],
      productionStats: [],
      unclassified: [],
      gitError: error instanceof Error ? error.message.trim() : String(error),
    };
  }
  const productionStats = trackedFiles
    .filter(isProductionFile)
    .filter((file) => existsInTree(root, file))
    .map((file) => ({ file, lines: countLines(root, file) }))
    .sort(byPath);
  return {
    trackedFiles,
    productionStats,
    unclassified: findUnclassifiedFiles(trackedFiles),
    gitError: null,
  };
}

export function findOversizedProductionFiles(stats: FileStat[]): OversizedFileStat[] {
  return stats
    .map((stat) => {
      const budget = budgetForFile(stat.file);
      return { ...stat, ...budget, overBy: stat.lines - budget.limit };
    })
    .filter((stat) => stat.overBy > 0)
    .sort((a, b) => b.overBy - a.overBy || b.lines - a.lines || compare(a.file, b.file));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byPath(a: { file: string }, b: { file: string }): number {
  return compare(a.file, b.file);
}

// --------------------------------------------------------------------------
// Baseline serialisation
// --------------------------------------------------------------------------

export type BaselineEntry = { file: string; lines: number; slug: BudgetSlug };

export type BaselineProblem = { line: number; text: string; message: string };

export type ParsedBaseline = {
  entries: BaselineEntry[];
  problems: BaselineProblem[];
};

/**
 * The header is fixed text. It carries no counts, no totals and no timestamp,
 * because anything that changes on every regeneration is a line that every
 * concurrent branch edits — which is precisely the conflict the issue asks this
 * format to avoid. Totals are printed by the tool instead.
 */
const BASELINE_HEADER = [
  "# File-size budget baseline (#2687). Generated - do not hand-edit.",
  "#",
  "# Every tracked production source file that is currently OVER its documented",
  "# size budget, with the line count that is now its ceiling. This is a debt",
  "# ledger, not a second budget: the budgets in docs/MAINTENANCE.md stay the",
  "# target and this file is expected to shrink.",
  "#",
  "#   route-handler     src/app/**/route.ts(x)     <= 250 LOC",
  "#   route-page-shell  src/app/**/page.tsx        <= 500 LOC",
  "#   domain-module     every other src/**/*.ts(x) <= 700 LOC",
  "#",
  "# Scope is tracked source under src/ only, tests excluded, in any of",
  "# .ts .tsx .mts .cts .js .jsx .mjs .cjs. Everything outside src/ - scripts/,",
  "# prisma/, e2e/, load/, measurement/ - is outside this policy by definition",
  "# and never appears here. A tracked src/ file carrying any other extension",
  "# fails the check rather than dropping quietly out of scope.",
  "#",
  "# The ratchet: a file that is not listed may not go over budget, and a file",
  "# that is listed may not exceed the number recorded below. Shrinking is",
  "# always allowed; regeneration records the lower ceiling.",
  "#",
  `#   ${CHECK_COMMAND}          verify (also a step in CI's \`verify\` job)`,
  `#   ${UPDATE_COMMAND}   intentionally accept the working tree as the new baseline`,
  "#",
  "# Regenerate; never hand-edit, and after a rebase regenerate against the",
  "# rebased tree rather than merging counts by hand. A deliberate increase is",
  "# allowed but must land as an added, removed or changed record here, with",
  "# the reason in the PR body. Update is the reviewed escape, not a verification",
  "# pass, and there is no exceptions list that bypasses this file.",
  "# Update reports every pre-update regression separately. The aggregate debt",
  "# delta never lets an unrelated shrink conceal a grown record.",
  "#",
  "# Format: one record per line, sorted by path.",
  "#   <path> <loc> <budget-category>",
];

export function serializeBaseline(entries: readonly BaselineEntry[]): string {
  const sorted = [...entries].sort(byPath);
  const lines = sorted.map((entry) => `${entry.file} ${entry.lines} ${entry.slug}`);
  return [...BASELINE_HEADER, ...lines].join("\n") + "\n";
}

export function baselineEntriesFor(stats: FileStat[]): BaselineEntry[] {
  return findOversizedProductionFiles(stats)
    .map((stat) => ({ file: stat.file, lines: stat.lines, slug: stat.slug }))
    .sort(byPath);
}

/**
 * `<path> <loc> <category>` with the path taken greedily.
 *
 * A plain `split(" ")` demanding exactly three fields could not read back a
 * record the generator itself had written: `src/lib/zz probe.ts` serialises to
 * four fields, so the file went permanently red with "expected 3 fields" and an
 * action — regenerate — that reproduces the identical line, blaming the author
 * for something they did not do. No tracked path has a space today; that made
 * it a latent trap rather than a safe assumption.
 */
const RECORD_PATTERN = /^(.+) (\S+) (\S+)$/;
const LOC_PATTERN = /^[1-9][0-9]*$/;

/**
 * Structural parse. Everything checkable without touching the tree is checked
 * here — field count, path shape, integer LOC, known category, no duplicates,
 * and the sort order that makes the file deterministic. Tree-aware checks (does
 * the file exist, does the recorded category match the path, is the recorded
 * number actually over budget) happen in `evaluateRatchet`.
 */
export function parseBaseline(text: string): ParsedBaseline {
  const entries: BaselineEntry[] = [];
  const problems: BaselineProblem[] = [];
  const seen = new Map<string, number>();
  let previous: string | null = null;

  const rawLines = text.split("\n");
  // A trailing newline yields one empty final element; that is the expected
  // shape, so drop exactly one.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  rawLines.forEach((raw, index) => {
    const lineNumber = index + 1;
    if (raw.startsWith("#")) return;
    if (raw.trim() === "") {
      problems.push({
        line: lineNumber,
        text: raw,
        message: "blank line (the generated file has none)",
      });
      return;
    }
    if (raw !== raw.trim()) {
      problems.push({
        line: lineNumber,
        text: raw,
        message: "leading or trailing whitespace",
      });
      return;
    }
    const match = RECORD_PATTERN.exec(raw);
    if (!match) {
      problems.push({
        line: lineNumber,
        text: raw,
        message: "expected `<path> <loc> <budget-category>` separated by single spaces",
      });
      return;
    }
    const [, file, loc, slug] = match as unknown as [string, string, string, string];
    const problem = pathProblem(file);
    if (problem) {
      problems.push({ line: lineNumber, text: raw, message: problem });
      return;
    }
    if (!LOC_PATTERN.test(loc)) {
      problems.push({
        line: lineNumber,
        text: raw,
        message: `line count must be a positive integer, found ${JSON.stringify(loc)}`,
      });
      return;
    }
    if (!BUDGET_SLUGS.includes(slug as BudgetSlug)) {
      problems.push({
        line: lineNumber,
        text: raw,
        message: `unknown budget category ${JSON.stringify(slug)} (expected one of ${BUDGET_SLUGS.join(", ")})`,
      });
      return;
    }
    const duplicate = seen.get(file);
    if (duplicate !== undefined) {
      problems.push({
        line: lineNumber,
        text: raw,
        message: `duplicate entry for ${file} (already on line ${duplicate})`,
      });
      return;
    }
    if (previous !== null && compare(previous, file) >= 0) {
      problems.push({
        line: lineNumber,
        text: raw,
        message: `out of order: ${file} must sort after ${previous}`,
      });
      return;
    }
    seen.set(file, lineNumber);
    previous = file;
    entries.push({ file, lines: Number(loc), slug: slug as BudgetSlug });
  });

  return { entries, problems };
}

// --------------------------------------------------------------------------
// Comparison
// --------------------------------------------------------------------------

export type RatchetSeverity = "regression" | "stale" | "unusable";

export type RatchetFindingKind =
  | "missing-baseline"
  | "malformed-baseline"
  | "empty-scan"
  | "new-over-budget"
  | "grown-beyond-baseline"
  | "shrunk-below-baseline"
  | "no-longer-over-budget"
  | "unclassified-source-file";

export type RatchetFinding = {
  severity: RatchetSeverity;
  kind: RatchetFindingKind;
  file: string | null;
  budget: string | null;
  baseline: string | null;
  current: string | null;
  problem: string;
  action: string;
};

export type RatchetResult = {
  findings: RatchetFinding[];
  /** The baseline this tree would produce; what `--update` writes. */
  regenerated: string;
  /** Sum of (LOC - budget) over every over-budget file in the tree. */
  currentOverage: number;
  /** The same sum over the committed baseline, or null when it is unusable. */
  baselineOverage: number | null;
  scannedFiles: number;
  oversizedFiles: number;
};

const SPLIT_ACTION =
  "split or reduce it below its budget; if the increase is genuinely necessary, " +
  `run \`${UPDATE_COMMAND}\` and say in the PR body why splitting is worse here`;

const REGENERATE_ACTION = `run \`${UPDATE_COMMAND}\` and commit the changed baseline`;

/**
 * Compare the tree against the committed baseline.
 *
 * The contract is exact equality: the committed baseline must be byte-identical
 * to the one this tree produces. That is deliberately stricter than "nothing
 * got worse". A baseline that is merely *not worse* drifts upward-compatible
 * with reality — a file could shrink to 100 lines, keep a 900-line ceiling, and
 * grow back to 900 with nothing to show for it. Exact equality is also what
 * makes the file honest: it cannot silently omit an over-budget file, which is
 * the failure mode of the nine-entry allow-list this replaces.
 *
 * `baselineText` is `null` when the file is absent.
 */
export function evaluateRatchet(
  productionStats: FileStat[],
  baselineText: string | null,
  unclassified: ReadonlyArray<{ file: string; reason: string }> = [],
): RatchetResult {
  const oversized = findOversizedProductionFiles(productionStats);
  const regenerated = serializeBaseline(baselineEntriesFor(productionStats));
  const currentOverage = oversized.reduce((sum, stat) => sum + stat.overBy, 0);
  const known = new Set(productionStats.map((stat) => stat.file));

  const base: Omit<RatchetResult, "findings"> = {
    regenerated,
    currentOverage,
    baselineOverage: null,
    scannedFiles: productionStats.length,
    oversizedFiles: oversized.length,
  };

  // Scope holes come first: if a tracked source file is in no budget at all,
  // every count below it is measuring a subset of the repository while
  // presenting itself as measuring the repository.
  const scopeFindings: RatchetFinding[] = unclassified.map((entry) => ({
    severity: "unusable" as const,
    kind: "unclassified-source-file" as const,
    file: entry.file,
    budget: null,
    baseline: null,
    current: null,
    problem: `${entry.reason}; a tracked file under src/ that no budget covers is invisible to this gate`,
    action:
      "classify it in `scripts/lib/file-size-budget.ts` — add the extension to SOURCE_EXTENSIONS if it is executable source, or to NON_SOURCE_EXTENSIONS if it is not — and regenerate the baseline",
  }));

  // A gate that scans nothing reports clean. Say so instead.
  if (productionStats.length === 0) {
    return {
      ...base,
      findings: [
        ...scopeFindings,
        {
          severity: "unusable",
          kind: "empty-scan",
          file: null,
          budget: null,
          baseline: null,
          current: null,
          problem:
            "the scan found no production source files at all, so the comparison proves nothing",
          action:
            "run this from the repository root inside a git checkout; a passing result from an empty scan is not a pass",
        },
      ],
    };
  }

  if (scopeFindings.length > 0) {
    return { ...base, findings: scopeFindings };
  }

  if (baselineText === null) {
    return {
      ...base,
      findings: [
        {
          severity: "unusable",
          kind: "missing-baseline",
          file: BASELINE_PATH,
          budget: null,
          baseline: "absent",
          current: `${oversized.length} file(s) currently over budget`,
          problem: `the committed baseline \`${BASELINE_PATH}\` is missing, so there is nothing to compare against`,
          action:
            `restore the last reviewed ${BASELINE_PATH} from git, then run \`${UPDATE_COMMAND}\` against that trusted comparison`,
        },
      ],
    };
  }

  const parsed = parseBaseline(baselineText);
  const findings: RatchetFinding[] = parsed.problems.map((problem) => ({
    severity: "unusable" as const,
    kind: "malformed-baseline" as const,
    file: BASELINE_PATH,
    budget: null,
    baseline: `line ${problem.line}: ${JSON.stringify(problem.text)}`,
    current: null,
    problem: problem.message,
    action:
      `restore the last reviewed ${BASELINE_PATH} from git, then run \`${UPDATE_COMMAND}\``,
  }));

  // Tree-aware validation of each recorded entry.
  for (const entry of parsed.entries) {
    const budget = budgetForFile(entry.file);
    if (entry.slug !== budget.slug) {
      findings.push({
        severity: "unusable",
        kind: "malformed-baseline",
        file: entry.file,
        budget: describeBudget(budget),
        baseline: `${entry.lines} LOC recorded as ${entry.slug}`,
        current: null,
        problem: `the recorded budget category does not match the one this path implies (${budget.slug})`,
        action:
          `restore the last reviewed ${BASELINE_PATH} from git, then run \`${UPDATE_COMMAND}\``,
      });
      continue;
    }
    if (entry.lines <= budget.limit) {
      findings.push({
        severity: "unusable",
        kind: "malformed-baseline",
        file: entry.file,
        budget: describeBudget(budget),
        baseline: `${entry.lines} LOC`,
        current: null,
        problem:
          "the baseline lists a file that is not over its budget; only over-budget files belong here",
        action:
          `restore the last reviewed ${BASELINE_PATH} from git, then run \`${UPDATE_COMMAND}\``,
      });
    }
  }

  // Validate the ledger's fixed bytes independently of tree drift. Comparing
  // straight to `regenerated` only works when the tree is unchanged: as soon
  // as a source file grows, that comparison differs for a legitimate record
  // reason and a corrupted header can hide behind the regression. Rebuilding
  // from the ledger's own parsed records isolates header/spacing corruption,
  // so update mode can refuse an unusable comparison before accepting growth.
  if (findings.length === 0 && baselineText !== serializeBaseline(parsed.entries)) {
    findings.push({
      severity: "unusable",
      kind: "malformed-baseline",
      file: BASELINE_PATH,
      budget: null,
      baseline: "differs from the generated form outside the records themselves",
      current: null,
      problem:
        "the records parse, but the file is not byte-identical to the generated ledger (header text, spacing, or trailing lines differ)",
      action:
        `restore the last reviewed ${BASELINE_PATH} from git, then run \`${UPDATE_COMMAND}\``,
    });
  }

  if (findings.length > 0) {
    return { ...base, findings };
  }

  const baselineByFile = new Map(parsed.entries.map((entry) => [entry.file, entry]));
  const baselineOverage = parsed.entries.reduce(
    (sum, entry) => sum + (entry.lines - budgetForFile(entry.file).limit),
    0,
  );

  for (const stat of oversized) {
    const recorded = baselineByFile.get(stat.file);
    if (!recorded) {
      findings.push({
        severity: "regression",
        kind: "new-over-budget",
        file: stat.file,
        budget: describeBudget(stat),
        baseline: "not listed (this file was within budget, or is new)",
        current: `${stat.lines} LOC, over by ${stat.overBy}`,
        problem: "a file that was not carrying size debt now exceeds its budget",
        action: SPLIT_ACTION,
      });
      continue;
    }
    if (stat.lines > recorded.lines) {
      findings.push({
        severity: "regression",
        kind: "grown-beyond-baseline",
        file: stat.file,
        budget: describeBudget(stat),
        baseline: `${recorded.lines} LOC`,
        current: `${stat.lines} LOC, over by ${stat.overBy} (+${stat.lines - recorded.lines} since the baseline)`,
        problem: "an already-oversized file grew beyond its committed ceiling",
        action: SPLIT_ACTION,
      });
      continue;
    }
    if (stat.lines < recorded.lines) {
      findings.push({
        severity: "stale",
        kind: "shrunk-below-baseline",
        file: stat.file,
        budget: describeBudget(stat),
        baseline: `${recorded.lines} LOC`,
        current: `${stat.lines} LOC, over by ${stat.overBy} (${recorded.lines - stat.lines} fewer than the baseline)`,
        problem:
          "the committed ceiling sits above the file's actual size — whether the file shrank or the number was raised by hand, it would let that many lines come back unnoticed",
        action: REGENERATE_ACTION,
      });
    }
  }

  const oversizedByFile = new Set(oversized.map((stat) => stat.file));
  for (const entry of parsed.entries) {
    if (oversizedByFile.has(entry.file)) continue;
    const budget = budgetForFile(entry.file);
    const stillTracked = known.has(entry.file);
    findings.push({
      severity: "stale",
      kind: "no-longer-over-budget",
      file: entry.file,
      budget: describeBudget(budget),
      baseline: `${entry.lines} LOC`,
      current: stillTracked
        ? "now within budget"
        : "no longer a tracked production file (deleted, renamed, or moved out of src/)",
      problem: "the baseline carries a ceiling for a file that no longer needs one",
      action: REGENERATE_ACTION,
    });
  }

  findings.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      compare(a.file ?? "", b.file ?? ""),
  );

  return { ...base, findings, baselineOverage };
}

function severityRank(severity: RatchetSeverity): number {
  if (severity === "unusable") return 0;
  if (severity === "regression") return 1;
  return 2;
}
