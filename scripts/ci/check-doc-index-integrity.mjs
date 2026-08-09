#!/usr/bin/env node
/**
 * Documentation index integrity: every doc is reachable, every cited invariant
 * id exists (issue #2691).
 *
 * ## Why this exists
 *
 * #2691 split a 7,135-line `docs/DOMAIN_INVARIANTS.md` into per-domain files
 * under `docs/invariants/`, each rule carrying a permanent `INV-<PREFIX>-<NNN>`
 * id, and replaced the nine-document "Read First" list in `AGENTS.md` with a
 * small always-read core plus a routing table. Both halves of that only work
 * while two properties hold, and neither is self-maintaining:
 *
 *  - **Every cited id resolves.** An id is cited from places this repository
 *    cannot rewrite — merged commits, closed issues, lint strings shipped in a
 *    release, test names in a fork. A citation that resolves to nothing is the
 *    exact failure #2691 exists to prevent: a rule written down correctly that
 *    still does not hold, because the pointer to it went stale.
 *  - **Every doc is reachable from an index.** The issue's own watchpoint names
 *    the routing table as the part most likely to rot. A doc nothing links to is
 *    a doc nobody finds, which is how `docs/DOMAIN_INVARIANTS.md` became
 *    unreachable-at-the-moment-of-need in the first place.
 *
 *   npm run docs:indexcheck                       # check, non-zero on any problem
 *   node scripts/ci/check-doc-index-integrity.mjs  # same
 *
 * ## The `INV-` namespace was already occupied
 *
 * This repository writes `INV-…` strings in quantity as **Xero invoice numbers**
 * in test fixtures, and four of them match the invariant citation shape exactly
 * (`INV-IB-001`, `INV-SETTLE-001`, `INV-SETTLE-002`, `INV-SUP-001`). They are
 * carried in {@link RESERVED_INVOICE_PREFIXES} below.
 *
 * An **unrecognised** prefix is a hard failure rather than something the
 * reserved list waves through. That is deliberate and it is the whole reason the
 * `INV-` namespace was safe to adopt: the likelier mistake is a typo'd prefix —
 * `INV-CPA-…` written for `INV-CAP-021` — and a blanket whitelist would make
 * exactly that mistake invisible. Every failure mode here is a noisy error; none
 * of them is a silent mis-resolution.
 *
 * ## Scanning rules
 *
 * Fenced code blocks are skipped for every pattern, so a document may show an
 * example id without the checker treating it as real. Inline backticks are
 * **not** skipped — most real citations in prose are written `` `INV-CAP-021` ``
 * and skipping them would make the check blind to the common case.
 *
 * Anchor-style citations (`…#inv-cap-021`) are deliberately not handled here.
 * `npm run docs:linkcheck` already validates fragments against real headings, and
 * duplicating it would give two places to disagree.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The index every invariant file and every id must be reachable from. */
export const INVARIANT_INDEX = "docs/DOMAIN_INVARIANTS.md";

/** Where invariant definitions live. Nothing outside it may define an id. */
export const INVARIANT_DIR = "docs/invariants/";

/**
 * A DEFINITION is a heading whose entire text is the id. A citation is never a
 * whole heading line, so the two patterns cannot be confused in either
 * direction. Levels 2–4 because an id heading sits exactly one level below its
 * nearest structural heading, and a file with no subsections has one level less.
 */
export const DEFINITION_PATTERN = /^#{2,4} (INV-[A-Z][A-Z0-9]*-\d{3})\s*$/;

/** A CITATION is the id anywhere in a line of any tracked text file. */
export const CITATION_PATTERN = /\bINV-[A-Z][A-Z0-9]*-\d{3}\b/g;

/**
 * An index ROW is the id alone in the first cell of a table row. Matching the
 * row rather than any mention is what lets the index's own prose use a real id
 * as an illustration without counting as a second catalogue entry.
 */
export const INDEX_ROW_PATTERN = /^\|\s*`(INV-[A-Z][A-Z0-9]*-\d{3})`\s*\|/;

/**
 * Prefixes that belong to Xero invoice-number fixtures, not to invariants, and
 * are therefore permanently unavailable as invariant prefixes.
 *
 * The first three collide with the citation shape today. The rest are near
 * misses in the same fixture family (`INV-SUB-2026-001`, `INV-XERO-9`, …) that
 * would collide the day someone wrote one with three trailing digits; reserving
 * them now costs nothing and stops a future invariant prefix from being chosen
 * where a fixture could plausibly land on it.
 */
export const RESERVED_INVOICE_PREFIXES = new Set([
  "IB",
  "SETTLE",
  "SUP",
  "SUB",
  "XERO",
  "FAM",
  "LEGACY",
  "PM",
  "JOR",
  "REB",
]);

/**
 * Files that quote MALFORMED ids on purpose, in prose rather than in a fence,
 * and are therefore exempt from the shape guard only — never from citation
 * resolution.
 *
 * `SCHEME.md` is the id scheme itself: it argues for three digits by
 * showing the two-digit form the issue body illustrated, and justifies the shape
 * guard by showing the two near-misses it catches. Those sentences are about the
 * malformed forms, so fencing them would be a worse document. The
 * post-acceptance name is listed alongside so the planned rename cannot silently
 * drop the exemption.
 */
export const SHAPE_GUARD_EXEMPT_FILES = new Set([
  "docs/invariants/SCHEME.md",
  "docs/invariants/SCHEME.md",
]);

/**
 * Files exempt from the CITATION scan.
 *
 * Exactly one, and it is this check's own test: its fixtures have to contain
 * unresolvable ids and unrecognised prefixes, because that is what they assert
 * the checker rejects. Nothing else may be added here — an exemption is the one
 * way to make a citation invisible, which is the failure this file exists to
 * prevent.
 */
export const CITATION_EXEMPT_FILES = new Set([
  "scripts/ci/check-doc-index-integrity.test.mjs",
]);

/** Tracked text files scanned for citations. */
export const SCANNED_EXTENSIONS = new Set([
  ".md",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sql",
  ".yml",
  ".yaml",
  ".json",
]);

/**
 * The repository's front doors, for the reachability walk.
 *
 * `docs/README.md` is the documentation hub named by the house rule ("every doc
 * must be reachable from a hub"); the other four are the entry points a reader
 * or an agent actually starts from, and each links into `docs/` directly.
 */
export const REACHABILITY_ROOTS = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "docs/README.md",
];

/**
 * Markdown under `docs/` that is deliberately not linked from anywhere.
 *
 * Empty, and it should stay that way: an unreachable doc is the problem, not a
 * category of doc. Link the file from its nearest hub instead of listing it
 * here.
 */
export const UNREACHABLE_ALLOWLIST = new Set([]);

// Inline links/images: ![alt](target) and [text](target).
const INLINE_LINK = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g;
// Reference definitions at line start: [label]: target
const REF_DEF = /^\s*\[[^\]]+\]:\s*(\S+)/;

/**
 * Split a file into the lines a pattern may match, dropping fenced code blocks.
 *
 * Returns `{ number, text }` pairs so a problem can name the line it is on.
 */
export function scannableLines(text) {
  const out = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) out.push({ number: index + 1, text: line });
  });
  return out;
}

/** The prefix half of an id: `INV-CAP-021` -> `CAP`. */
export function prefixOf(id) {
  return id.split("-")[1];
}

/** Relative Markdown links a file makes, resolved to repo-relative paths. */
export function markdownLinkTargets(fromPath, text) {
  const dir = path.posix.dirname(fromPath);
  const targets = [];
  for (const { text: line } of scannableLines(text)) {
    // Inline-code spans are stripped here (a link shown as code is not a link),
    // which is the opposite of the citation scan and deliberately so.
    const scannable = line.replace(/`[^`]*`/g, " ");
    const raw = [];
    for (const match of scannable.matchAll(INLINE_LINK)) raw.push(match[1]);
    const refMatch = scannable.match(REF_DEF);
    if (refMatch) raw.push(refMatch[1]);

    for (let target of raw) {
      if (target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      target = target.replace(/^</, "").replace(/>$/, "").split("#")[0].split("?")[0];
      if (!target) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        /* malformed encoding: leave as written, it simply will not resolve */
      }
      if (!target.toLowerCase().endsWith(".md")) continue;
      targets.push(path.posix.normalize(path.posix.join(dir, target)));
    }
  }
  return targets;
}

/**
 * Definitions, keyed by id, each with every place it was defined.
 *
 * Only files under {@link INVARIANT_DIR} may define an id.
 */
export function collectDefinitions(files) {
  const definitions = new Map();
  for (const [rel, text] of files) {
    if (!rel.startsWith(INVARIANT_DIR) || !rel.endsWith(".md")) continue;
    for (const { number, text: line } of scannableLines(text)) {
      const match = line.match(DEFINITION_PATTERN);
      if (match) {
        if (!definitions.has(match[1])) definitions.set(match[1], []);
        definitions.get(match[1]).push(`${rel}:${number}`);
      }
    }
  }
  return definitions;
}

/** Every citation in every scanned file, with where it was written. */
export function collectCitations(files) {
  const citations = [];
  for (const [rel, text] of files) {
    if (CITATION_EXEMPT_FILES.has(rel)) continue;
    for (const { number, text: line } of scannableLines(text)) {
      for (const match of line.matchAll(CITATION_PATTERN)) {
        citations.push({ id: match[0], at: `${rel}:${number}` });
      }
    }
  }
  return citations;
}

/**
 * Assertions 1–4 of the scheme: no duplicate definition, every citation under a
 * declared prefix resolves, every unrecognised prefix is either reserved or a
 * failure, and every near-miss under a declared prefix has exactly three digits.
 */
export function auditInvariantIds(files) {
  const problems = [];
  const definitions = collectDefinitions(files);

  for (const [id, places] of definitions) {
    if (places.length > 1) {
      problems.push(
        `${id} is defined ${places.length} times (${places.join(", ")}). An id names ` +
          "exactly one rule and is never reused. Two lanes that independently took " +
          "the next free number is the usual cause: whichever lands second renumbers " +
          "its own definition — free, because nothing has cited it yet — and updates " +
          `its row in ${INVARIANT_INDEX}.`,
      );
    }
  }

  const declaredPrefixes = new Set([...definitions.keys()].map(prefixOf));
  const unresolved = new Map();
  const unrecognised = new Map();

  for (const { id, at } of collectCitations(files)) {
    const prefix = prefixOf(id);
    if (declaredPrefixes.has(prefix)) {
      if (!definitions.has(id)) {
        if (!unresolved.has(id)) unresolved.set(id, []);
        unresolved.get(id).push(at);
      }
    } else if (!RESERVED_INVOICE_PREFIXES.has(prefix)) {
      if (!unrecognised.has(prefix)) unrecognised.set(prefix, []);
      unrecognised.get(prefix).push(`${id} at ${at}`);
    }
  }

  for (const [id, places] of unresolved) {
    problems.push(
      `${id} is cited at ${places.join(", ")} but no file under ${INVARIANT_DIR} ` +
        "defines it. Either the id is mistyped, or the rule it named was deleted — " +
        "which the scheme forbids: a superseded rule keeps its heading and gains a " +
        "`Superseded by` line, a retired one keeps its heading and gains a reason, so " +
        "an old citation always lands on an explanation rather than on nothing.",
    );
  }

  for (const [prefix, places] of unrecognised) {
    problems.push(
      `INV-${prefix}-… is not a declared invariant prefix and is not on the reserved ` +
        `Xero invoice-number list (${places.join(", ")}). If it is a typo for a real ` +
        `prefix, fix it. If it is a new invariant area, define its ids under ` +
        `${INVARIANT_DIR} and list them in ${INVARIANT_INDEX}. If it is genuinely an ` +
        "invoice number, add its prefix to RESERVED_INVOICE_PREFIXES in this script " +
        "with a note saying so.",
    );
  }

  // Shape guard, built from the prefixes the definitions actually declared: a
  // near-miss under a REAL prefix slips past the strict citation pattern and
  // resolves to nothing while being reported as nothing. Scoped to declared
  // prefixes rather than to `INV-` generally, because a generic shape guard
  // flags every Xero invoice fixture in the test suite.
  if (declaredPrefixes.size > 0) {
    const shapeGuard = new RegExp(
      `\\bINV-(?:${[...declaredPrefixes].sort().join("|")})-[0-9]+\\b`,
      "g",
    );
    for (const [rel, text] of files) {
      if (SHAPE_GUARD_EXEMPT_FILES.has(rel) || CITATION_EXEMPT_FILES.has(rel)) continue;
      for (const { number, text: line } of scannableLines(text)) {
        for (const match of line.matchAll(shapeGuard)) {
          const digits = match[0].slice(match[0].lastIndexOf("-") + 1);
          if (digits.length !== 3) {
            problems.push(
              `${match[0]} at ${rel}:${number} uses ${digits.length} digit(s). Invariant ` +
                "numbers are exactly three, zero-padded, so a citation cannot be " +
                "ambiguous between `-21` and `-021`. Write it the way the definition " +
                "heading does.",
            );
          }
        }
      }
    }
  }

  return problems;
}

/**
 * Assertion 5: every file under {@link INVARIANT_DIR} is linked from the index.
 *
 * Stricter than general reachability on purpose — reaching an invariant file
 * through some other document is not good enough, because the index is what a
 * reader is told to open first and it is authoritative for id -> file.
 */
export function auditInvariantFilesLinkedFromIndex(files) {
  const indexText = files.get(INVARIANT_INDEX);
  if (indexText === undefined) {
    return [
      `${INVARIANT_INDEX} is missing. It is the root of the invariants tree: every ` +
        "domain file is linked from it and every id is catalogued in it.",
    ];
  }

  const linked = new Set(markdownLinkTargets(INVARIANT_INDEX, indexText));
  const problems = [];
  for (const rel of [...files.keys()].sort()) {
    if (!rel.startsWith(INVARIANT_DIR) || !rel.endsWith(".md")) continue;
    if (!linked.has(rel)) {
      problems.push(
        `${rel} is not linked from ${INVARIANT_INDEX}. Every invariant file is reached ` +
          "through the index, so a file it does not name is a file nobody opens — and " +
          "its rules are exactly as unreachable as they were before the split.",
      );
    }
  }
  return problems;
}

/**
 * Assertion 6: every defined id has exactly one catalogue row in the index, and
 * every catalogue row names a defined id.
 *
 * This is what stops the index rotting, which is the part the issue's own
 * watchpoint predicts will rot first.
 */
export function auditIndexRows(files) {
  const indexText = files.get(INVARIANT_INDEX);
  if (indexText === undefined) return []; // already reported above

  const rows = new Map();
  for (const { number, text: line } of scannableLines(indexText)) {
    const match = line.match(INDEX_ROW_PATTERN);
    if (match) {
      if (!rows.has(match[1])) rows.set(match[1], []);
      rows.get(match[1]).push(`${INVARIANT_INDEX}:${number}`);
    }
  }

  const definitions = collectDefinitions(files);
  const problems = [];

  for (const [id, places] of [...definitions].sort()) {
    const listed = rows.get(id);
    if (!listed) {
      problems.push(
        `${id} is defined at ${places[0]} but has no row in ${INVARIANT_INDEX}. The ` +
          "index is the only part anyone reads in full, so a rule missing from it can " +
          "only be found by someone who already knew it was there. Add a row, in file " +
          "order, with a description of twelve words or fewer.",
      );
    } else if (listed.length > 1) {
      problems.push(
        `${id} has ${listed.length} rows in ${INVARIANT_INDEX} (${listed.join(", ")}). ` +
          "One id, one row: two rows drift apart and a reader believes whichever they " +
          "found first.",
      );
    }
  }

  for (const [id, places] of [...rows].sort()) {
    if (!definitions.has(id)) {
      problems.push(
        `${INVARIANT_INDEX} lists ${id} (${places.join(", ")}) but nothing under ` +
          `${INVARIANT_DIR} defines it. Either the definition was lost in a move, or ` +
          "the row is a leftover from a rule that was renamed.",
      );
    }
  }

  return problems;
}

/**
 * Every Markdown file under `docs/` is reachable from a front door by following
 * relative Markdown links.
 *
 * Scope is Markdown, because a doc is a page a reader reads: the assets beside
 * them (`docs/images/**`, the lobby-display HTML mockups, the Codex profile
 * TOMLs) are referenced from their own pages and are covered by
 * `npm run docs:linkcheck` instead.
 */
export function auditDocReachability(files) {
  const markdown = new Set(
    [...files.keys()].filter((rel) => rel.toLowerCase().endsWith(".md")),
  );

  const seen = new Set();
  const queue = [];
  for (const root of REACHABILITY_ROOTS) {
    if (markdown.has(root) && !seen.has(root)) {
      seen.add(root);
      queue.push(root);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    for (const target of markdownLinkTargets(current, files.get(current))) {
      if (markdown.has(target) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }

  const problems = [];
  for (const rel of [...markdown].sort()) {
    if (!rel.startsWith("docs/")) continue;
    if (seen.has(rel) || UNREACHABLE_ALLOWLIST.has(rel)) continue;
    problems.push(
      `${rel} is not reachable from any of ${REACHABILITY_ROOTS.join(", ")} by ` +
        "following relative Markdown links. Link it from its nearest hub — the feature " +
        "README beside it, or docs/README.md — so somebody can find it without already " +
        "knowing the path.",
    );
  }
  return problems;
}

/**
 * The whole check, over an in-memory map of repo-relative path -> file text.
 *
 * Pure, so the rules are testable without a repository. Returns a list of
 * plain-English problems; an empty list is a pass.
 */
export function auditDocs(files) {
  return [
    ...auditInvariantIds(files),
    ...auditInvariantFilesLinkedFromIndex(files),
    ...auditIndexRows(files),
    ...auditDocReachability(files),
  ];
}

/** Read every tracked file this check scans, keyed by repo-relative path. */
export function loadTrackedFiles(repoRoot) {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean);

  const files = new Map();
  for (const entry of listed) {
    const rel = entry.replace(/\\/g, "/");
    if (!SCANNED_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    const absolute = path.join(repoRoot, rel);
    // A tracked-but-deleted path in a dirty working tree is not this check's
    // business; git status reports it and reading it would throw here.
    if (!fs.existsSync(absolute)) continue;
    files.set(rel, fs.readFileSync(absolute, "utf8"));
  }
  return files;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const repoRoot = path.resolve(path.join(import.meta.dirname, "..", ".."));
  try {
    const files = loadTrackedFiles(repoRoot);
    const definitions = collectDefinitions(files);
    const problems = auditDocs(files);

    if (problems.length > 0) {
      console.error(
        `Documentation index integrity failed (#2691) — ${problems.length} problem(s):\n`,
      );
      for (const problem of problems) console.error(`  - ${problem}\n`);
      process.exitCode = 1;
    } else {
      const prefixes = new Set([...definitions.keys()].map(prefixOf));
      console.log(
        `Doc index check passed: ${definitions.size} invariant id(s) across ` +
          `${prefixes.size} prefix(es), every citation resolves, every id is indexed, ` +
          `and every docs/ page is reachable. Scanned ${files.size} tracked file(s).`,
      );
    }
  } catch (error) {
    console.error(`Documentation index integrity check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
