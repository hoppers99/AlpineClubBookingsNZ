#!/usr/bin/env node
/**
 * Release-time changelog compiler (issue #2452).
 *
 * Every branch used to write its entry straight into the top of
 * `## Unreleased` in `CHANGELOG.md`, so concurrent lanes conflicted on that one
 * file daily (AGENTS.md §5, "Housekeeping that bites parallel lanes"). Each PR
 * now drops a self-contained fragment into `changelog.d/` instead — one new
 * file per PR, which git merges without a conflict — and this script folds the
 * collected fragments into a real release section when a release is cut.
 *
 *   node scripts/release/compile-changelog.mjs 0.14.0                # date = today (NZ)
 *   node scripts/release/compile-changelog.mjs 0.14.0 2026-08-04     # explicit date
 *   node scripts/release/compile-changelog.mjs 0.14.0 --dry-run      # print, change nothing
 *
 * What it does, in order:
 *   1. Reads every `changelog.d/*.md` fragment except the reserved
 *      `README.md` / `.gitkeep`, in a deterministic filename order.
 *   2. Folds any entries still written directly under a legacy `## Unreleased`
 *      heading into the same new release section (transition support — several
 *      PRs opened before the fragment convention still carry direct entries).
 *   3. Inserts `## <version> - <date>` above the existing releases, leaving the
 *      `## Unreleased` heading and its pointer note in place but empty.
 *   4. Deletes the fragments it consumed and prints exactly what it did.
 *
 * It never rewrites historical sections: everything from the next `## ` heading
 * down is copied through byte-for-byte.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.join(import.meta.dirname, "..", ".."));

/** Directory holding one Markdown fragment per merged PR. */
export const FRAGMENTS_DIRNAME = "changelog.d";

/**
 * Files in `changelog.d/` that are part of the convention rather than entries.
 * Compared case-insensitively so `readme.md` is never compiled into a release.
 */
const RESERVED_FRAGMENT_NAMES = new Set(["readme.md", ".gitkeep"]);

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A top-level release heading, e.g. `## 0.13.2 - 2026-07-23`. */
const VERSION_HEADING = /^## \d+\.\d+\.\d+/;
const UNRELEASED_HEADING = /^## Unreleased[ \t]*$/;
const ANY_HEADING = /^## /;
/** A top-level changelog entry bullet. Continuation paragraphs are indented. */
const ENTRY_BULLET = /^- /;

/**
 * Deterministic fragment order: ascending, comparing runs of digits
 * numerically so `999-x.md` sorts before `2448-x.md` rather than after it
 * (plain lexicographic order would put a three-digit PR number last forever).
 * Ties fall back to a plain codepoint compare so the order never depends on
 * locale or on the order the filesystem happened to list the directory in.
 */
export function compareFragmentNames(a, b) {
  const chunksA = a.match(/\d+|\D+/g) ?? [];
  const chunksB = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(chunksA.length, chunksB.length); i += 1) {
    const left = chunksA[i];
    const right = chunksB[i];
    const bothNumeric = /^\d/.test(left) && /^\d/.test(right);
    if (bothNumeric) {
      if (Number(left) !== Number(right)) {
        return Number(left) - Number(right);
      }
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  if (chunksA.length !== chunksB.length) {
    return chunksA.length - chunksB.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Read every compilable fragment from `dir`, in `compareFragmentNames` order. */
export function readFragments(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".md") &&
        !RESERVED_FRAGMENT_NAMES.has(entry.name.toLowerCase()),
    )
    .map((entry) => entry.name)
    .sort(compareFragmentNames)
    .map((name) => ({
      name,
      // Fragments are pinned to LF by .gitattributes, but a file created by a
      // Windows editor before it is committed can still arrive as CRLF; the
      // compiled CHANGELOG.md must stay LF-only.
      body: fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n"),
    }));
}

function stripBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

/**
 * Pure composer: returns the new CHANGELOG.md text plus whether any legacy
 * `## Unreleased` entries were folded in. `fragments` is an ordered list of
 * `{ name, body }`; `changelog` is the current file text.
 */
export function composeChangelog({ changelog, version, date, fragments }) {
  const lines = changelog.split("\n");
  const unreleasedIndex = lines.findIndex((line) => UNRELEASED_HEADING.test(line));

  let head;
  let preamble = [];
  let legacy = [];
  let tail;

  if (unreleasedIndex >= 0) {
    const nextHeadingOffset = lines
      .slice(unreleasedIndex + 1)
      .findIndex((line) => ANY_HEADING.test(line));
    const sectionEnd =
      nextHeadingOffset >= 0 ? unreleasedIndex + 1 + nextHeadingOffset : lines.length;
    const section = lines.slice(unreleasedIndex + 1, sectionEnd);
    // Everything from the first top-level bullet onwards is an entry (including
    // its indented continuation paragraphs); anything above it is the pointer
    // note that must survive the compile.
    const firstBullet = section.findIndex((line) => ENTRY_BULLET.test(line));
    head = lines.slice(0, unreleasedIndex + 1);
    preamble = stripBlankEdges(firstBullet >= 0 ? section.slice(0, firstBullet) : section);
    legacy = firstBullet >= 0 ? stripBlankEdges(section.slice(firstBullet)) : [];
    tail = lines.slice(sectionEnd);
  } else {
    // No `## Unreleased` heading at all: insert directly above the newest
    // release section (or, failing that, at the end of the file).
    const firstVersionIndex = lines.findIndex((line) => ANY_HEADING.test(line));
    const splitAt = firstVersionIndex >= 0 ? firstVersionIndex : lines.length;
    head = stripBlankEdges(lines.slice(0, splitAt));
    tail = lines.slice(splitAt);
  }

  const entryLines = [...legacy];
  for (const fragment of fragments) {
    entryLines.push(...stripBlankEdges(fragment.body.split("\n")));
  }

  const out = [...head];
  if (preamble.length > 0) {
    out.push("", ...preamble);
  }
  out.push("", `## ${version} - ${date}`, "", ...entryLines);
  if (stripBlankEdges(tail).length > 0) {
    out.push("", ...stripBlankEdges(tail), "");
  } else {
    out.push("");
  }

  return { changelog: out.join("\n"), foldedLegacyEntries: legacy.length > 0 };
}

/** Today's date in the club's timezone, as `YYYY-MM-DD`. */
export function todayInNewZealand(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Compile `changelog.d/` into a new release section in CHANGELOG.md.
 * Returns a summary; throws on bad input or an already-released version.
 */
export function compileChangelog({
  repoRoot = REPO_ROOT,
  version,
  date = todayInNewZealand(),
  dryRun = false,
  log = console.log,
} = {}) {
  if (!VERSION_PATTERN.test(String(version ?? ""))) {
    throw new Error(`Version must look like 0.14.0, got: ${version ?? "(missing)"}`);
  }
  if (!DATE_PATTERN.test(date)) {
    throw new Error(`Date must be YYYY-MM-DD, got: ${date}`);
  }

  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  const fragmentsDir = path.join(repoRoot, FRAGMENTS_DIRNAME);
  const changelog = fs.readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n");

  if (changelog.split("\n").some((line) => line.startsWith(`## ${version} `))) {
    throw new Error(`CHANGELOG.md already has a "## ${version}" section — nothing to compile.`);
  }

  const fragments = readFragments(fragmentsDir);
  const composed = composeChangelog({ changelog, version, date, fragments });

  if (fragments.length === 0 && !composed.foldedLegacyEntries) {
    log(
      `Nothing to compile: ${FRAGMENTS_DIRNAME}/ holds no fragments and "## Unreleased" has no ` +
        "entries. CHANGELOG.md was left unchanged.",
    );
    return { written: false, version, date, fragments: [], foldedLegacyEntries: false };
  }

  const names = fragments.map((fragment) => fragment.name);
  if (dryRun) {
    log(`[dry run] Would add "## ${version} - ${date}" to CHANGELOG.md with:`);
    if (composed.foldedLegacyEntries) {
      log('  - the entries currently written directly under "## Unreleased"');
    }
    for (const name of names) {
      log(`  - ${FRAGMENTS_DIRNAME}/${name} (would be deleted)`);
    }
    log("[dry run] No files were changed.");
    return { written: false, version, date, fragments: names, ...composed };
  }

  fs.writeFileSync(changelogPath, composed.changelog);
  for (const name of names) {
    fs.rmSync(path.join(fragmentsDir, name));
  }

  log(`Added "## ${version} - ${date}" to CHANGELOG.md.`);
  if (composed.foldedLegacyEntries) {
    log('  Folded in the entries that were written directly under "## Unreleased".');
  }
  log(
    names.length > 0
      ? `  Compiled and deleted ${names.length} fragment(s): ${names.join(", ")}`
      : "  No fragments were present.",
  );
  return { written: true, version, date, fragments: names, ...composed };
}

/** Parse argv into `{ version, date, dryRun }`. Exported for tests. */
export function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const [version, date] = positional;
  return { version, date, dryRun };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const { version, date, dryRun } = parseArgs(process.argv.slice(2));
    compileChangelog({ version, date: date ?? todayInNewZealand(), dryRun });
  } catch (error) {
    console.error(`compile-changelog failed: ${error.message}`);
    console.error("Usage: node scripts/release/compile-changelog.mjs <version> [YYYY-MM-DD] [--dry-run]");
    process.exitCode = 1;
  }
}
