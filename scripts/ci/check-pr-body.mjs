#!/usr/bin/env node
/**
 * Run the two PR-body gates against a LOCAL file, before the PR exists.
 *
 *   npm run pr:check -- path/to/body.md
 *   npm run pr:check -- path/to/body.md --base origin/main
 *
 * `verify` enforces two gates that read the PR body rather than the code: the
 * concurrency declaration and the changelog fragment. Both fetch the live body
 * from GitHub, so before this script the only way to test a body was to open or
 * edit a PR and wait ~15 minutes for the answer — one field per attempt, because
 * each gate stops at its first failure. That loop cost four CI cycles on #2634
 * and #2640 for what turned out to be wrapped lines.
 *
 * This runs the SAME exported validators the CI gates use, offline, in about a
 * second. It is deliberately not a reimplementation: if these ever disagree with
 * CI, that is a bug in this file.
 *
 * Changed files default to the diff against the merge-base with origin/main,
 * which is what both gates key their "is this sensitive / code-bearing?"
 * decisions on.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { validateConcurrencyDeclaration } from "./check-pr-concurrency-declaration.mjs";
import { validateChangelogFragment } from "./check-pr-changelog-fragment.mjs";
import { gitDiffChangedFiles, parseNameStatus } from "./pr-body.mjs";

function parseArgs(argv) {
  const args = { file: null, base: "origin/main" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") {
      args.base = argv[++i];
    } else if (!args.file) {
      args.file = argv[i];
    }
  }
  return args;
}

/**
 * The diff, as `[{ status, path }]` records.
 *
 * This MUST go through the same `gitDiffChangedFiles` / `parseNameStatus` pair
 * the CI gates use, for two reasons that both fail OPEN when it does not:
 *
 *  - `validateChangelogFragment` reads `change.path` off each element. Handing
 *    it bare `--name-only` strings makes every path `undefined`, so
 *    `isCodeBearing` sees nothing, the gate returns `not-code-bearing`, and it
 *    reports PASS for any body at all — including one with no fragment and no
 *    `changelog: none` marker. That is what this script did until #2664's
 *    review caught it, which means every local PASS on that gate was hollow
 *    while the CI gate went on failing the same PRs for real.
 *  - `gitDiffChangedFiles` pins `core.quotePath=false`. Without it git escapes
 *    non-ASCII paths, which anchor patterns like `^src/` and `^prisma/` then
 *    fail to match — so a sensitive file stops being seen and a bare `N/A`
 *    declaration is accepted.
 *
 * Status is also what distinguishes an ADDED fragment from the deletions a
 * release-compile PR makes, so `--name-status` is required, not a nicety.
 */
function changesAgainst(base) {
  try {
    const mergeBase = execFileSync("git", ["merge-base", "HEAD", base], {
      encoding: "utf8",
    }).trim();
    return parseNameStatus(
      gitDiffChangedFiles(mergeBase, "HEAD", { nameStatus: true }),
    );
  } catch {
    console.warn(
      `! Could not diff against ${base}; checking the body shape only.\n` +
        "  The sensitive-path and code-bearing rules are NOT exercised.",
    );
    return [];
  }
}

const { file, base } = parseArgs(process.argv.slice(2));

if (!file) {
  console.error(
    "Usage: npm run pr:check -- <body-file> [--base origin/main]\n\n" +
      "Checks a PR body against the same validators the `verify` job runs, before\n" +
      "you open or edit the PR. Write the body to a file, check it, then pass that\n" +
      "same file to `gh pr create --body-file`.",
  );
  process.exit(2);
}

let body;
try {
  body = readFileSync(file, "utf8");
} catch (error) {
  console.error(`Could not read ${file}: ${error.message}`);
  process.exit(2);
}

const changes = changesAgainst(base);
// The concurrency gate keys on paths alone; the changelog gate needs the status
// as well. `parseNameStatus` expands a rename into its delete + add pair, so the
// path list is deduped before the concurrency gate counts or matches it.
const changedFiles = [...new Set(changes.map((change) => change.path))];
const failures = [];

for (const [label, run] of [
  ["Concurrency declaration", () => validateConcurrencyDeclaration(body, changedFiles)],
  ["Changelog fragment", () => validateChangelogFragment(body, changes)],
]) {
  try {
    run();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    // Report BOTH gates rather than stopping at the first. Each CI run only
    // ever tells you about one failure, which is what makes the remote loop so
    // slow; there is no reason to reproduce that here.
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL  ${label}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.map((f) => `- ${f}`).join("\n\n")}`);
  console.error(
    `\nChecked against ${changedFiles.length} changed file(s) vs ${base}.`,
  );
  process.exit(1);
}

console.log(
  `\nPR body passes both gates (${changedFiles.length} changed file(s) vs ${base}).`,
);
