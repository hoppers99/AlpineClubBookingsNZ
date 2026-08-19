#!/usr/bin/env node
/**
 * Report agent-owned Docker debris: containers whose owning issue is closed.
 *
 *   npm run stale-containers
 *   npm run stale-containers -- --json
 *
 * ## Why this exists (#2794)
 *
 * Agent lanes create disposable Postgres containers and whole local E2E stacks.
 * A healthy idle container produces no symptom at all, so nobody discovers the
 * debris — they discover a host that seems busy. #2663's CPU measurement refuses
 * to run unless the host carries exactly its four approved measurement
 * containers, and it kept failing against containers belonging to work that had
 * been closed for over a week.
 *
 * The owner's decision (11 Aug 2026) was visibility plus lane-owned teardown,
 * explicitly NOT a background garbage collector and explicitly NOT an age-based
 * expiry: a long-running but still-active lane must never lose its database
 * because a timer fired.
 *
 * ## This command never removes anything
 *
 * There is no `--remove`, no `--prune`, no `--force`. It reads `docker ps -a`,
 * reads issue state through the repository's existing `gh` boundary, prints what
 * it found, and exits. The teardown commands it prints are for a human or an
 * orchestrator to run deliberately, against targets they have read.
 *
 * ## The one rule that matters: failure reads "unknown", never "safe to remove"
 *
 * Every path that cannot establish BOTH "this is agent-owned per the naming
 * convention" AND "its owning issue is closed" lands in `unknown`. That covers a
 * name with no issue number in it, a name with two, an issue `gh` could not
 * resolve, and `gh` being absent or logged out entirely. If Docker itself cannot
 * be reached the command exits non-zero rather than printing an empty, clean
 * looking table — silence must never be mistaken for a clean host.
 *
 * ## Naming convention
 *
 * Documented in `docs/agents/CODEX_WORKFLOW.md` -> "Lane-owned Docker
 * infrastructure". Summary of what this file implements:
 *
 *   1. RESERVED projects are shared infrastructure and are never debris,
 *      whatever their name looks like. Checked first, before anything else.
 *   2. An explicit `agent-lane.shared=true` label also means shared.
 *   3. An explicit `agent-lane.issue=<n>` label is authoritative when present.
 *   4. Otherwise the issue number is read out of the Compose project name (for a
 *      Compose-managed container) or the container name (for a standalone one),
 *      by the conservative extraction in `extractIssueNumber` below.
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { fetchIssueState } from "./lib/github-cli.mjs";

/**
 * Compose projects that are shared infrastructure, never per-issue debris.
 *
 * `tacbookings` is the production/local compose project (`docker-compose.yml`),
 * `tacbookings-staging` is the E2E stack's default project
 * (`E2E_COMPOSE_PROJECT` in `scripts/e2e-stack.sh`), and `tacbookings-measure`
 * is #2663's measurement stack — the very stack this tool exists to stop
 * blocking. Reporting any of them as removable debris would be the worst
 * possible failure of this tool, so the check runs before issue extraction and
 * matches the project name exactly rather than by prefix.
 */
export const RESERVED_PROJECTS = new Set([
  "tacbookings",
  "tacbookings-staging",
  "tacbookings-measure",
]);

/** Opt-out label: a deliberately shared stack that happens to carry a number. */
export const SHARED_LABEL = "agent-lane.shared";

/** Opt-in label: the authoritative owning issue, set when the lane creates it. */
export const ISSUE_LABEL = "agent-lane.issue";

/** The Compose label every Compose-managed container carries. */
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/**
 * The canonical going-forward token: `issue<n>` as a whole segment, e.g.
 * `pg-issue2595`, `tacbookings-issue2595-app-1`. Unambiguous by construction —
 * when one of these is present, the legacy heuristics below are not consulted
 * at all.
 */
const CANONICAL_ISSUE_TOKEN = /(?:^|[-_])issue(\d{1,7})(?=$|[-_])/gi;

/**
 * A bare numeric segment: `pg-2376`, `drift-2597`, `pg-race-2595-resume`.
 *
 * The three-digit floor is load-bearing, not tidiness. Compose appends a
 * container number (`-app-1`) and images carry version-shaped fragments; a
 * one-or-two-digit segment read as an issue number would be a false match on
 * essentially every Compose container on the host.
 */
const BARE_NUMERIC_SEGMENT = /^\d{3,7}$/;

/**
 * A glued suffix on an otherwise alphabetic segment: `e2e2595` in
 * `tacbookings-e2e2595`. The segment must END in the digit run and the part
 * before it must end in a letter, so `postgres16` (two digits) and a pure
 * numeric segment are both handled elsewhere.
 */
const GLUED_NUMERIC_SUFFIX = /^(?:[a-z0-9]*[a-z])(\d{3,7})$/i;

/**
 * Pull the owning issue number out of an agent-owned name.
 *
 * Returns `{ issue }` only when exactly one distinct candidate is found.
 * Anything else returns a reason, and every reason routes to `unknown`:
 *
 *   - `no-issue-in-name` — nothing issue-shaped is present. A container the
 *     convention does not cover is somebody else's, not debris.
 *   - `ambiguous` — two or more different numbers. `pg-2595-2597` could be owned
 *     by either, and guessing is exactly the false-deletion risk this refuses.
 */
export function extractIssueNumber(name) {
  const text = String(name ?? "");
  if (!text) return { issue: null, reason: "no-issue-in-name" };

  const canonical = new Set();
  for (const match of text.matchAll(CANONICAL_ISSUE_TOKEN)) {
    canonical.add(Number(match[1]));
  }
  // The canonical token wins outright. A name that declares `issue2595` has said
  // what it means, and letting a stray digit run elsewhere in the same name turn
  // that into "ambiguous" would punish the convention we want lanes to adopt.
  if (canonical.size === 1) return { issue: [...canonical][0], reason: null };
  if (canonical.size > 1) return { issue: null, reason: "ambiguous" };

  const legacy = new Set();
  for (const segment of text.split(/[-_]/)) {
    if (BARE_NUMERIC_SEGMENT.test(segment)) {
      legacy.add(Number(segment));
      continue;
    }
    const glued = GLUED_NUMERIC_SUFFIX.exec(segment);
    if (glued) legacy.add(Number(glued[1]));
  }

  if (legacy.size === 1) return { issue: [...legacy][0], reason: null };
  if (legacy.size > 1) return { issue: null, reason: "ambiguous" };
  return { issue: null, reason: "no-issue-in-name" };
}

/**
 * Decide what a container IS, before any issue state is known.
 *
 * Split out from state resolution so the ownership question and the open/closed
 * question fail independently: GitHub being unreachable must not turn a shared
 * stack into an unknown one, and it must not turn anything into debris.
 */
export function classifyOwnership(container) {
  const project = container.project || null;

  if (project && RESERVED_PROJECTS.has(project)) {
    return { ownership: "shared", issue: null, reason: `reserved Compose project ${project}` };
  }
  if (String(container.sharedLabel ?? "").toLowerCase() === "true") {
    return { ownership: "shared", issue: null, reason: `${SHARED_LABEL}=true` };
  }

  const labelled = String(container.issueLabel ?? "").trim();
  if (labelled) {
    if (/^\d{1,7}$/.test(labelled)) {
      return { ownership: "agent-lane", issue: Number(labelled), reason: `${ISSUE_LABEL} label` };
    }
    // A malformed label is worse than no label: something set it deliberately
    // and got it wrong, so say so instead of quietly falling back to the name.
    return {
      ownership: "unowned",
      issue: null,
      reason: `${ISSUE_LABEL} label is not an issue number: ${labelled}`,
    };
  }

  // Prefer the Compose project name. Every container in the project shares one
  // owner, so reading the project answers once for the whole stack and cannot
  // be confused by a per-service name.
  const source = project ?? container.name;
  const { issue, reason } = extractIssueNumber(source);
  if (issue === null) {
    return {
      ownership: "unowned",
      issue: null,
      reason: reason === "ambiguous"
        ? `more than one issue number in "${source}"`
        : `no issue number in "${source}"`,
    };
  }
  return { ownership: "agent-lane", issue, reason: `issue number read from "${source}"` };
}

/**
 * Docker's `CreatedAt` timestamp, e.g. `2026-08-09 08:16:05 +1200 NZST`.
 *
 * Parsed explicitly rather than handed to `Date.parse`, which returns NaN for
 * exactly this string: the space separator, the colon-less offset and the
 * trailing zone abbreviation are all outside the format the spec requires an
 * engine to accept. The first version of this file used `Date.parse` and its
 * own unit test caught it — every age would have rendered as "-" on a real host.
 *
 * A timestamp with no zone at all returns null. Docker always emits one, and
 * guessing a zone would silently shift the age by up to a day.
 */
const DOCKER_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})/;

export function parseDockerTimestamp(value) {
  const match = DOCKER_TIMESTAMP.exec(String(value ?? "").trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const milliseconds = fraction ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes =
      (zone[0] === "-" ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }

  return (
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      milliseconds,
    ) -
    offsetMinutes * 60_000
  );
}

/**
 * Container age in whole days, from an explicit `now`.
 *
 * `now` is a parameter rather than a `Date.now()` call inside so the unit suite
 * — which runs with the clock frozen at 2026-07-01 (`docs/TESTING.md`) — can
 * assert real numbers without fighting the freeze or opting out of it.
 *
 * Age is reported, never acted on: the owner ruled out age-based expiry, so a
 * long-lived container belonging to an open issue stays "active" no matter how
 * large this number gets.
 */
export function ageInDays(createdAt, now) {
  const created = parseDockerTimestamp(createdAt);
  if (created === null) return null;
  const elapsed = now - created;
  if (elapsed < 0) return null;
  return Math.floor(elapsed / 86_400_000);
}

/**
 * Build the whole report from two injected boundaries.
 *
 * `listContainers()` returns the parsed `docker ps -a` rows or throws;
 * `resolveIssueState(n)` returns `{ state }` or throws. Both are injected so the
 * unit suite can exercise every failure branch — Docker down, `gh` logged out, a
 * single issue that 404s — with no live Docker and no destructive operation
 * anywhere near a test run.
 */
export async function buildReport({ listContainers, resolveIssueState, now = Date.now() }) {
  let containers;
  try {
    containers = await listContainers();
  } catch (error) {
    return {
      dockerAvailable: false,
      dockerError: error?.message ?? String(error),
      entries: [],
      groups: [],
    };
  }

  const owned = containers.map((container) => ({
    container,
    ...classifyOwnership(container),
  }));

  // Resolve each distinct issue once. A stack contributes three containers and
  // one lookup, and a `gh` outage produces one recorded reason rather than N.
  const issueStates = new Map();
  for (const { issue } of owned) {
    if (issue === null || issueStates.has(issue)) continue;
    try {
      const resolved = await resolveIssueState(issue);
      const state = String(resolved?.state ?? "").toUpperCase();
      issueStates.set(
        issue,
        state === "OPEN" || state === "CLOSED"
          ? { state, title: resolved?.title ?? "" }
          : { state: "UNKNOWN", error: `GitHub reported an unrecognised state: ${resolved?.state}` },
      );
    } catch (error) {
      issueStates.set(issue, { state: "UNKNOWN", error: error?.message ?? String(error) });
    }
  }

  const entries = owned.map(({ container, ownership, issue, reason }) => {
    const resolved = issue === null ? null : issueStates.get(issue);
    const issueState = resolved?.state ?? null;

    let classification;
    let note;
    if (ownership === "shared") {
      classification = "shared";
      note = reason;
    } else if (ownership === "unowned") {
      classification = "unknown";
      note = reason;
    } else if (issueState === "CLOSED") {
      classification = "stale";
      note = `#${issue} is closed`;
    } else if (issueState === "OPEN") {
      classification = "active";
      note = `#${issue} is open`;
    } else {
      // The honesty branch. `gh` could not answer, so the answer is "I do not
      // know", and an unknown container is never offered for removal.
      classification = "unknown";
      note = `could not resolve #${issue}: ${resolved?.error ?? "no state returned"}`;
    }

    return {
      name: container.name,
      project: container.project || null,
      image: container.image ?? "",
      state: container.state ?? "",
      status: container.status ?? "",
      createdAt: container.createdAt ?? "",
      ageDays: ageInDays(container.createdAt, now),
      issue,
      issueState,
      classification,
      note,
      reviewAsStale: classification === "stale",
    };
  });

  return { dockerAvailable: true, dockerError: null, entries, groups: groupEntries(entries) };
}

/**
 * Group the stale entries into the units a human actually tears down: a whole
 * Compose project, or a standalone container. Printing `docker rm -f x` three
 * times for one stack invites someone to remove the containers and leave the
 * project's network and volumes behind, which is most of what was consuming disk.
 */
export function groupEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.reviewAsStale) continue;
    const key = entry.project ?? `container:${entry.name}`;
    if (!groups.has(key)) {
      groups.set(key, {
        kind: entry.project ? "compose-project" : "container",
        key: entry.project ?? entry.name,
        issue: entry.issue,
        members: [],
      });
    }
    groups.get(key).members.push(entry.name);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    teardown:
      group.kind === "compose-project"
        ? `docker compose -p ${group.key} down -v --remove-orphans`
        : `docker rm -f ${group.key}`,
  }));
}

const COLUMNS = [
  ["CONTAINER", (entry) => entry.name],
  ["PROJECT", (entry) => entry.project ?? "-"],
  ["ISSUE", (entry) => (entry.issue === null ? "-" : `#${entry.issue}`)],
  ["ISSUE STATE", (entry) => entry.issueState ?? "unknown"],
  ["CONTAINER STATE", (entry) => entry.state || "-"],
  ["AGE", (entry) => (entry.ageDays === null ? "-" : `${entry.ageDays}d`)],
  ["REVIEW AS STALE", (entry) => (entry.reviewAsStale ? "yes" : "no")],
];

/** Render the human report. Pure, so the suite asserts on the real output. */
export function renderReport(report) {
  if (!report.dockerAvailable) {
    return [
      "Stale-container report: UNKNOWN — Docker could not be queried.",
      `  ${report.dockerError}`,
      "",
      "Nothing is being claimed about this host. This is not a clean result:",
      "no container could be enumerated, so no container could be cleared.",
    ].join("\n");
  }

  const lines = [];
  if (report.entries.length === 0) {
    lines.push("Stale-container report: no containers on this host.");
    return lines.join("\n");
  }

  const rows = [COLUMNS.map(([heading]) => heading)];
  const ordered = [...report.entries].sort((a, b) => {
    const rank = { stale: 0, unknown: 1, active: 2, shared: 3 };
    return rank[a.classification] - rank[b.classification] || a.name.localeCompare(b.name);
  });
  for (const entry of ordered) rows.push(COLUMNS.map(([, read]) => read(entry)));

  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  for (const row of rows) {
    lines.push(row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd());
  }

  const stale = report.entries.filter((entry) => entry.classification === "stale");
  const unknown = report.entries.filter((entry) => entry.classification === "unknown");

  lines.push("");
  if (stale.length === 0) {
    lines.push("No closed-issue debris found.");
  } else {
    lines.push(
      `${stale.length} container(s) belong to closed issues. Nothing has been removed — ` +
        "read each target, confirm no open lane is using it, then run its teardown deliberately:",
    );
    for (const group of report.groups) {
      lines.push(`  #${group.issue}  ${group.members.join(", ")}`);
      lines.push(`         ${group.teardown}`);
    }
  }

  if (unknown.length > 0) {
    lines.push("");
    lines.push(
      `${unknown.length} container(s) could not be classified. These are NOT removal ` +
        "candidates — an unresolved container is unknown, not stale:",
    );
    for (const entry of unknown) lines.push(`  ${entry.name} — ${entry.note}`);
  }

  return lines.join("\n");
}

/**
 * The Docker boundary.
 *
 * One `docker ps -a` call with per-label template lookups. Deliberately NOT
 * `{{.Labels}}`: that renders every label into one comma-joined string, and
 * `com.docker.compose.depends_on` legitimately contains commas, so splitting it
 * misattributes values. Tabs cannot appear in any of these fields, so a
 * tab-delimited line is unambiguous.
 */
const DOCKER_FORMAT = [
  "{{.Names}}",
  "{{.State}}",
  "{{.Status}}",
  "{{.Image}}",
  "{{.CreatedAt}}",
  `{{.Label "${COMPOSE_PROJECT_LABEL}"}}`,
  `{{.Label "${ISSUE_LABEL}"}}`,
  `{{.Label "${SHARED_LABEL}"}}`,
].join("\t");

export function parseDockerOutput(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [name, state, status, image, createdAt, project, issueLabel, sharedLabel] =
        line.split("\t");
      return { name, state, status, image, createdAt, project, issueLabel, sharedLabel };
    });
}

function listContainersFromDocker() {
  try {
    const stdout = execFileSync("docker", ["ps", "-a", "--no-trunc", "--format", DOCKER_FORMAT], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseDockerOutput(stdout);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("`docker` is not on PATH, so no container could be enumerated.");
    }
    const stderr = String(error?.stderr ?? "").trim();
    throw new Error(
      stderr
        ? `\`docker ps -a\` failed (is the Docker daemon running?):\n${stderr}`
        : `\`docker ps -a\` failed: ${error?.message ?? error}`,
    );
  }
}

export function parseArguments(argv) {
  // A literal `--` is skipped so one documented command works in every shell.
  // PowerShell eats npm's separator, which is why other scripts here are
  // invoked as `npm run x -- -- --flag`; tolerating the token means nobody has
  // to remember which shell needs how many.
  const args = argv.filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    throw new Error(
      `Unrecognised argument(s): ${unknown.join(" ")}. This command reports and takes ` +
        "only --json. It has no removal mode, deliberately (#2794).",
    );
  }
  return { json: args.includes("--json") };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const { json } = parseArguments(process.argv.slice(2));
    const report = await buildReport({
      listContainers: listContainersFromDocker,
      resolveIssueState: fetchIssueState,
    });
    console.log(json ? JSON.stringify(report, null, 2) : renderReport(report));
    // A report that could not be produced must not exit 0: #2663's preflight and
    // any orchestrator reading this would otherwise read "clean host".
    if (!report.dockerAvailable) process.exitCode = 1;
  } catch (error) {
    console.error(`stale-containers failed: ${error.message}`);
    process.exitCode = 1;
  }
}
