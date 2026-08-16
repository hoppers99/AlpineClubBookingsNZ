#!/usr/bin/env node
/**
 * Documentation inventory and inbound-link map (issue #2692, MEP-D1).
 *
 * Acceptance criterion 1 of #2692 requires the current documentation tree and
 * its inbound links to be recorded BEFORE any page is moved, so that a tidy
 * folder split cannot silently strand a page. This script produces that record.
 *
 *   node measurement/docs-inventory-2692/build-inventory.mjs
 *
 * It writes `inventory.tsv` next to itself. Re-running it after a restructure
 * regenerates the map, which is the cheapest way to prove nothing was orphaned.
 *
 * Columns
 *   path          tracked Markdown file
 *   audience      assigned primary audience (see AUDIENCE_OF_FLAT / DIR_AUDIENCE)
 *   depth         BFS distance from the nearest reachability root, -1 = orphan
 *   via           the page the BFS reached it through
 *   md_in         how many tracked Markdown files link to it
 *   code_in       how many tracked non-Markdown files (src/tests/workflows/config)
 *                 mention its path — these break silently on a rename
 *   index_in      how many of its inbound links come from an index/hub page
 *   bytes         file size
 *
 * `code_in` and `index_in` are the two columns that decide whether a page can be
 * relocated cheaply: a page with code references costs a code change to move,
 * and a page with `index_in = 0` is reachable only through prose cross-links and
 * is exactly the kind of page a restructure loses.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");
process.chdir(ROOT);

/** The reachability roots the CI index check walks from (kept in sync by hand). */
const REACHABILITY_ROOTS = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "docs/README.md",
];

/** A page that lists other pages. Reaching a doc only from a non-index page is a smell. */
const isIndexPage = (file) =>
  /(^|\/)README\.md$/.test(file) ||
  [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTRIBUTING.md",
    "docs/COVERAGE_MATRIX.md",
    "docs/DOMAIN_INVARIANTS.md",
  ].includes(file);

/**
 * Primary audience for the root entry points and the flat `docs/*.md` reference
 * layer, assigned by hand. Everything else is assigned by directory below.
 */
const AUDIENCE_OF_FLAT = {
  "README.md": "router",
  "AGENTS.md": "agent",
  "CLAUDE.md": "agent",
  "CONTRIBUTING.md": "contributor",
  "REVIEW.md": "contributor",
  "CODE_OF_CONDUCT.md": "contributor",
  "CONFIGURATION.md": "adopter",
  "DEPLOYMENT.md": "adopter",
  "CHANGELOG.md": "adopter",
  "NOTICE.md": "adopter",
  "SECURITY.md": "adopter",
  "SUPPORT.md": "member",
  "docs/README.md": "router",
  "docs/ARCHITECTURE.md": "contributor",
  "docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md": "operator",
  "docs/AUTHORITATIVE_FEES.md": "operator",
  "docs/BLUE_GREEN_MIGRATION_POLICY.md": "contributor",
  "docs/CANCELLATIONS.md": "operator",
  "docs/CAPACITY_MODEL.md": "contributor",
  "docs/CONCURRENCY_AND_LOCKING.md": "contributor",
  "docs/COVERAGE_MATRIX.md": "contributor",
  "docs/DOMAIN_INVARIANTS.md": "contributor",
  "docs/E2E_PLAYWRIGHT.md": "contributor",
  "docs/END_TO_END_TEST_MATRIX.md": "contributor",
  "docs/IMPLEMENTATION_GUIDE.md": "adopter",
  "docs/INDUCTION_BASELINE_RUNBOOK.md": "operator",
  "docs/LOAD_TESTING.md": "contributor",
  "docs/MAINTENANCE.md": "operator",
  "docs/ONGOING_DEVELOPMENT_WORKFLOW.md": "adopter",
  "docs/PRODUCTION_UPGRADE_RUNBOOK.md": "operator",
  "docs/PUBLIC_PAGE_CONTENT_TOKENS.md": "operator",
  "docs/SECURITY-ATTACK-SURFACE.md": "contributor",
  "docs/SECURITY.md": "contributor",
  "docs/STAGING_ACCESSIBILITY.md": "contributor",
  "docs/STATE_MACHINES.md": "contributor",
  "docs/STYLE_GUIDE.md": "contributor",
  "docs/TESTING.md": "contributor",
  "docs/TOKEN_HASHING.md": "contributor",
  "docs/UPGRADING.md": "adopter",
  "docs/UX_FLOW_MAP.md": "contributor",
  "docs/XERO_MEMBER_GROUPING_RUNBOOK.md": "operator",
};

/** Primary audience by path prefix, longest prefix wins. */
const DIR_AUDIENCE = [
  ["docs/adopters/", "adopter"],
  ["docs/contributors/", "contributor"],
  ["docs/user-guide/", "member"],
  ["docs/guides/", "operator"],
  ["docs/agents/", "agent"],
  ["docs/invariants/", "contributor"],
  ["docs/releases/", "adopter"],
  ["docs/images/", "contributor"],
  ["docs/ai-diagnostics/", "contributor"],
  ["docs/ai-diagnostics/deployment.md", "operator"],
  ["docs/diagnostics/", "contributor"],
  ["docs/finance-dashboard/", "contributor"],
  ["docs/lobby-display/", "contributor"],
  ["docs/lobby-display/operating.md", "operator"],
  ["docs/multi-lodge/", "contributor"],
  ["docs/config-transfer/", "contributor"],
  ["docs/exclusive-booking/", "contributor"],
  ["docs/member-photos/", "contributor"],
  ["docs/xero/", "contributor"],
];

function audienceOf(file) {
  if (AUDIENCE_OF_FLAT[file]) return AUDIENCE_OF_FLAT[file];
  let best = "";
  let label = "unassigned";
  for (const [prefix, value] of DIR_AUDIENCE) {
    if (file.startsWith(prefix) && prefix.length > best.length) {
      best = prefix;
      label = value;
    }
  }
  return label;
}

const tracked = execSync("git ls-files", { encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const markdown = tracked.filter((file) => file.endsWith(".md"));
const markdownSet = new Set(markdown);

/** Relative Markdown links out of `file`, resolved to repository-relative paths. */
function linksOf(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const found = new Set();
  const inline = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = inline.exec(text))) {
    let target = match[1];
    if (/^(https?:|mailto:|tel:|#)/.test(target)) continue;
    target = target.split("#")[0];
    if (!target) continue;
    found.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), target)));
  }
  // A bare `docs/THING.md` in backticks is how much of this repository cites a
  // page, and it is a real inbound reference even though it is not a link.
  const backticked = /`([A-Za-z0-9_./-]+\.md)`/g;
  while ((match = backticked.exec(text))) {
    const bare = match[1];
    const relative = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), bare),
    );
    for (const candidate of [bare, relative]) {
      if (markdownSet.has(candidate)) found.add(candidate);
    }
  }
  return [...found];
}

const depth = new Map();
const via = new Map();
const queue = [];
for (const root of REACHABILITY_ROOTS) {
  depth.set(root, 0);
  queue.push(root);
}
while (queue.length) {
  const current = queue.shift();
  for (const link of linksOf(current)) {
    if (!markdownSet.has(link) || depth.has(link)) continue;
    depth.set(link, depth.get(current) + 1);
    via.set(link, current);
    queue.push(link);
  }
}

const inbound = new Map();
for (const file of markdown) {
  for (const link of linksOf(file)) {
    if (!markdownSet.has(link)) continue;
    if (!inbound.has(link)) inbound.set(link, new Set());
    inbound.get(link).add(file);
  }
}

const codeFiles = tracked.filter((file) =>
  /\.(ts|tsx|js|mjs|cjs|json|jsonc|yml|yaml|sh|sql|prisma|tsv|txt)$/.test(file),
);
const codeInbound = new Map();
for (const file of codeFiles) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!text.includes(".md")) continue;
  for (const doc of markdown) {
    if (text.includes(doc)) {
      if (!codeInbound.has(doc)) codeInbound.set(doc, new Set());
      codeInbound.get(doc).add(file);
    }
  }
}

const rows = markdown
  .filter((file) => file.startsWith("docs/") || !file.includes("/"))
  .sort()
  .map((file) => {
    const inboundFiles = inbound.get(file) ?? new Set();
    return [
      file,
      audienceOf(file),
      depth.has(file) ? depth.get(file) : -1,
      via.get(file) ?? "(root)",
      inboundFiles.size,
      codeInbound.get(file)?.size ?? 0,
      [...inboundFiles].filter(isIndexPage).length,
      fs.statSync(file).size,
    ].join("\t");
  });

const header = [
  "path",
  "audience",
  "depth",
  "via",
  "md_in",
  "code_in",
  "index_in",
  "bytes",
].join("\t");
fs.writeFileSync(
  path.join(HERE, "inventory.tsv"),
  `${header}\n${rows.join("\n")}\n`,
  "utf8",
);

const docPages = markdown.filter((file) => file.startsWith("docs/"));
const orphans = docPages.filter((file) => !depth.has(file));
const indexOrphans = docPages.filter(
  (file) => ![...(inbound.get(file) ?? [])].some(isIndexPage),
);
console.log(`tracked Markdown files: ${markdown.length}`);
console.log(`pages under docs/: ${docPages.length}`);
console.log(`unreachable from a root: ${orphans.length}`);
for (const file of orphans) console.log(`  orphan: ${file}`);
console.log(`reachable but not listed on any index page: ${indexOrphans.length}`);
for (const file of indexOrphans) console.log(`  index-orphan: ${file}`);
