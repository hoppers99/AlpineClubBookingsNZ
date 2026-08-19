import { describe, expect, it, vi } from "vitest";

import {
  ageInDays,
  buildReport,
  classifyOwnership,
  extractIssueNumber,
  groupEntries,
  parseArguments,
  parseDockerOutput,
  parseDockerTimestamp,
  renderReport,
  RESERVED_PROJECTS,
} from "./stale-containers.mjs";

/**
 * Unit coverage for the stale-container reporter (#2794).
 *
 * Both real boundaries are injected, so nothing here talks to Docker or to
 * GitHub and no test can remove anything: `buildReport` takes `listContainers`
 * and `resolveIssueState` as parameters and the CLI is the only thing that ever
 * supplies the live versions.
 *
 * The fixtures are the containers measured on the development host on
 * 19 Aug 2026, because the failure this tool exists to catch is exactly that
 * shape: a three-container Compose stack plus five standalone Postgres
 * containers, all from issues closed a week or more earlier.
 *
 * `now` is passed explicitly everywhere. The suite runs with the clock frozen at
 * 2026-07-01 (`docs/TESTING.md`), and an age assertion that read the real clock
 * would be a stopwatch — the thing that convention forbids.
 */

const NOW = Date.parse("2026-08-19T00:00:00.000Z");

function container(overrides = {}) {
  return {
    name: "pg-2376",
    state: "exited",
    status: "Exited (255) 6 days ago",
    image: "postgres:16-alpine",
    createdAt: "2026-08-09 08:16:05 +1200 NZST",
    project: "",
    issueLabel: "",
    sharedLabel: "",
    ...overrides,
  };
}

/** Resolver that answers from a table and throws for anything not in it. */
function resolverFor(states) {
  return vi.fn(async (number) => {
    if (!(number in states)) throw new Error(`could not resolve issue ${number}`);
    return { number, state: states[number], title: `issue ${number}` };
  });
}

describe("extractIssueNumber", () => {
  it("reads the canonical issue<n> token", () => {
    expect(extractIssueNumber("pg-issue2595")).toEqual({ issue: 2595, reason: null });
    expect(extractIssueNumber("tacbookings-issue2595-app-1")).toEqual({
      issue: 2595,
      reason: null,
    });
  });

  it("lets the canonical token win over an unrelated digit run in the same name", () => {
    // Without this, adopting the convention would make a name LESS resolvable
    // than the legacy shape it replaced.
    expect(extractIssueNumber("pg-issue2595-shard-4096")).toEqual({ issue: 2595, reason: null });
  });

  it("reads the legacy bare-numeric and glued shapes measured on the host", () => {
    expect(extractIssueNumber("pg-2376").issue).toBe(2376);
    expect(extractIssueNumber("drift-2597").issue).toBe(2597);
    expect(extractIssueNumber("pg-race-2595-resume").issue).toBe(2595);
    expect(extractIssueNumber("pg-2623-fence").issue).toBe(2623);
    expect(extractIssueNumber("tacbookings-e2e2595").issue).toBe(2595);
  });

  it("refuses a name with no issue number in it", () => {
    expect(extractIssueNumber("my-scratch-db")).toEqual({ issue: null, reason: "no-issue-in-name" });
    expect(extractIssueNumber("")).toEqual({ issue: null, reason: "no-issue-in-name" });
    expect(extractIssueNumber(undefined)).toEqual({ issue: null, reason: "no-issue-in-name" });
  });

  it("never reads a Compose container number or a short digit run as an issue", () => {
    // `-1` is the Compose container-number suffix on EVERY Compose container,
    // and `postgres16` is an image-shaped fragment. Either being matched would
    // make this tool claim ownership of most of the host.
    expect(extractIssueNumber("someproject-app-1").issue).toBeNull();
    expect(extractIssueNumber("postgres16").issue).toBeNull();
    expect(extractIssueNumber("db-99").issue).toBeNull();
  });

  it("refuses an ambiguous name rather than guessing an owner", () => {
    expect(extractIssueNumber("pg-2595-2597")).toEqual({ issue: null, reason: "ambiguous" });
    expect(extractIssueNumber("pg-issue2595-issue2597")).toEqual({
      issue: null,
      reason: "ambiguous",
    });
  });
});

describe("classifyOwnership", () => {
  it("treats every reserved Compose project as shared, whatever the name suggests", () => {
    for (const project of RESERVED_PROJECTS) {
      const result = classifyOwnership(container({ name: `${project}-postgres-1`, project }));
      expect(result.ownership).toBe("shared");
      expect(result.issue).toBeNull();
    }
  });

  it("keeps #2663's measurement stack out of the debris list", () => {
    // The regression that would break the very thing this issue exists to
    // unblock: reporting the measurement stack as removable.
    const result = classifyOwnership(
      container({ name: "tacbookings-measure-postgres-1", project: "tacbookings-measure" }),
    );
    expect(result.ownership).toBe("shared");
  });

  it("honours an explicit shared label on a container whose name carries a number", () => {
    const result = classifyOwnership(
      container({ name: "pg-2595", project: "", sharedLabel: "true" }),
    );
    expect(result.ownership).toBe("shared");
  });

  it("prefers an explicit issue label over the name", () => {
    const result = classifyOwnership(container({ name: "scratch-db", issueLabel: "2794" }));
    expect(result).toMatchObject({ ownership: "agent-lane", issue: 2794 });
  });

  it("reports a malformed issue label as unowned instead of falling back to the name", () => {
    const result = classifyOwnership(container({ name: "pg-2376", issueLabel: "not-a-number" }));
    expect(result.ownership).toBe("unowned");
    expect(result.reason).toContain("not an issue number");
  });

  it("reads the Compose project rather than the per-service container name", () => {
    const result = classifyOwnership(
      container({ name: "tacbookings-e2e2595-app-1", project: "tacbookings-e2e2595" }),
    );
    expect(result).toMatchObject({ ownership: "agent-lane", issue: 2595 });
  });
});

describe("buildReport", () => {
  it("classifies a closed-issue container as stale and offers its teardown", async () => {
    const report = await buildReport({
      listContainers: async () => [container({ name: "pg-2376" })],
      resolveIssueState: resolverFor({ 2376: "CLOSED" }),
      now: NOW,
    });

    expect(report.dockerAvailable).toBe(true);
    expect(report.entries[0]).toMatchObject({
      name: "pg-2376",
      issue: 2376,
      issueState: "CLOSED",
      classification: "stale",
      reviewAsStale: true,
    });
    expect(report.groups).toEqual([
      { kind: "container", key: "pg-2376", issue: 2376, members: ["pg-2376"], teardown: "docker rm -f pg-2376" },
    ]);
  });

  it("classifies an open-issue container as active and never offers it", async () => {
    const report = await buildReport({
      listContainers: async () => [container({ name: "pg-2794" })],
      resolveIssueState: resolverFor({ 2794: "OPEN" }),
      now: NOW,
    });

    expect(report.entries[0]).toMatchObject({ classification: "active", reviewAsStale: false });
    expect(report.groups).toEqual([]);
  });

  it("classifies a malformed / non-issue name as unknown, not removable", async () => {
    const resolveIssueState = vi.fn();
    const report = await buildReport({
      listContainers: async () => [
        container({ name: "my-scratch-db" }),
        container({ name: "pg-2595-2597" }),
      ],
      resolveIssueState,
      now: NOW,
    });

    expect(report.entries.map((entry) => entry.classification)).toEqual(["unknown", "unknown"]);
    expect(report.entries.every((entry) => entry.reviewAsStale === false)).toBe(true);
    expect(report.entries[1].note).toContain("more than one issue number");
    // Ownership failed, so GitHub was never asked — no lookup, no false answer.
    expect(resolveIssueState).not.toHaveBeenCalled();
    expect(report.groups).toEqual([]);
  });

  it('reports "unknown" — never "safe to remove" — when GitHub status cannot be resolved', async () => {
    const report = await buildReport({
      listContainers: async () => [container({ name: "pg-2376" })],
      resolveIssueState: vi.fn(async () => {
        throw new Error(
          "GitHub CLI is not authenticated for this repository. Run `gh auth login`",
        );
      }),
      now: NOW,
    });

    expect(report.entries[0]).toMatchObject({
      issue: 2376,
      issueState: "UNKNOWN",
      classification: "unknown",
      reviewAsStale: false,
    });
    expect(report.entries[0].note).toContain("could not resolve #2376");
    expect(report.groups).toEqual([]);
    expect(renderReport(report)).not.toContain("belong to closed issues");
  });

  it("treats an unrecognised GitHub state as unknown rather than as not-closed", async () => {
    const report = await buildReport({
      listContainers: async () => [container({ name: "pg-2376" })],
      resolveIssueState: async () => ({ state: "MERGED" }),
      now: NOW,
    });

    expect(report.entries[0].classification).toBe("unknown");
    expect(report.entries[0].reviewAsStale).toBe(false);
  });

  it("reports Docker being unavailable as unknown, and says so in the rendered output", async () => {
    const report = await buildReport({
      listContainers: async () => {
        throw new Error("`docker` is not on PATH, so no container could be enumerated.");
      },
      resolveIssueState: vi.fn(),
      now: NOW,
    });

    expect(report.dockerAvailable).toBe(false);
    expect(report.entries).toEqual([]);
    const rendered = renderReport(report);
    expect(rendered).toContain("UNKNOWN");
    expect(rendered).toContain("This is not a clean result");
    // The precise regression to guard: an empty enumeration reading as clean.
    expect(rendered).not.toContain("No closed-issue debris found");
  });

  it("looks each distinct issue up once across a whole Compose stack", async () => {
    const resolveIssueState = resolverFor({ 2595: "CLOSED" });
    const report = await buildReport({
      listContainers: async () => [
        container({ name: "tacbookings-e2e2595-app-1", project: "tacbookings-e2e2595" }),
        container({ name: "tacbookings-e2e2595-postgres-1", project: "tacbookings-e2e2595" }),
        container({ name: "tacbookings-e2e2595-mailpit-1", project: "tacbookings-e2e2595" }),
      ],
      resolveIssueState,
      now: NOW,
    });

    expect(resolveIssueState).toHaveBeenCalledTimes(1);
    expect(report.groups).toEqual([
      {
        kind: "compose-project",
        key: "tacbookings-e2e2595",
        issue: 2595,
        members: [
          "tacbookings-e2e2595-app-1",
          "tacbookings-e2e2595-postgres-1",
          "tacbookings-e2e2595-mailpit-1",
        ],
        teardown: "docker compose -p tacbookings-e2e2595 down -v --remove-orphans",
      },
    ]);
  });

  it("reproduces the 19 Aug 2026 host measurement", async () => {
    const report = await buildReport({
      listContainers: async () => [
        container({ name: "pg-2376", createdAt: "2026-08-09 08:16:05 +1200 NZST" }),
        container({ name: "pg-race-2656" }),
        container({ name: "tacbookings-e2e2595-app-1", project: "tacbookings-e2e2595", state: "running" }),
        container({ name: "pg-2623-fence" }),
        container({ name: "pg-race-2595-resume" }),
        container({ name: "pg-race-2595" }),
        container({ name: "tacbookings-e2e2595-mailpit-1", project: "tacbookings-e2e2595", state: "running" }),
        container({ name: "tacbookings-e2e2595-postgres-1", project: "tacbookings-e2e2595", state: "running" }),
        container({ name: "drift-2597" }),
        // Present as a control: the measurement stack must survive the report.
        container({ name: "tacbookings-measure-postgres-1", project: "tacbookings-measure" }),
      ],
      resolveIssueState: resolverFor({
        2376: "CLOSED",
        2595: "CLOSED",
        2597: "CLOSED",
        2623: "CLOSED",
        2656: "CLOSED",
      }),
      now: NOW,
    });

    expect(report.entries.filter((entry) => entry.classification === "stale")).toHaveLength(9);
    expect(report.entries.filter((entry) => entry.classification === "shared")).toHaveLength(1);
    expect(report.entries.filter((entry) => entry.classification === "unknown")).toHaveLength(0);
    expect(report.groups.map((group) => group.key).sort()).toEqual([
      "drift-2597",
      "pg-2376",
      "pg-2623-fence",
      "pg-race-2595",
      "pg-race-2595-resume",
      "pg-race-2656",
      "tacbookings-e2e2595",
    ]);
  });
});

describe("parseDockerTimestamp", () => {
  it("reads Docker's own CreatedAt format, which Date.parse cannot", () => {
    // The regression this pins: `Date.parse` returns NaN for this exact string,
    // so the first draft of the reporter rendered every age as "-".
    expect(Number.isNaN(Date.parse("2026-08-09 08:16:05 +1200 NZST"))).toBe(true);
    expect(parseDockerTimestamp("2026-08-09 08:16:05 +1200 NZST")).toBe(
      Date.parse("2026-08-08T20:16:05.000Z"),
    );
  });

  it("applies the offset sign and a colon-separated offset", () => {
    expect(parseDockerTimestamp("2026-08-09 08:16:05 -0500 EST")).toBe(
      Date.parse("2026-08-09T13:16:05.000Z"),
    );
    expect(parseDockerTimestamp("2026-08-09T08:16:05+12:00")).toBe(
      Date.parse("2026-08-08T20:16:05.000Z"),
    );
    expect(parseDockerTimestamp("2026-08-09T08:16:05.250Z")).toBe(
      Date.parse("2026-08-09T08:16:05.250Z"),
    );
  });

  it("returns null rather than guessing when the zone is missing or the value is junk", () => {
    expect(parseDockerTimestamp("2026-08-09 08:16:05")).toBeNull();
    expect(parseDockerTimestamp("not a date")).toBeNull();
    expect(parseDockerTimestamp(undefined)).toBeNull();
  });
});

describe("ageInDays", () => {
  it("computes whole days from the supplied instant", () => {
    expect(ageInDays("2026-08-09 08:16:05 +1200 NZST", NOW)).toBe(10);
  });

  it("returns null for an unparseable or future timestamp instead of a wrong number", () => {
    expect(ageInDays("not a date", NOW)).toBeNull();
    expect(ageInDays("2026-09-01T00:00:00.000Z", NOW)).toBeNull();
  });
});

describe("parseDockerOutput", () => {
  it("splits the tab-delimited format, including a container with no labels", () => {
    const rows = parseDockerOutput(
      "pg-2376\texited\tExited (255) 6 days ago\tpostgres:16-alpine\t2026-08-09 08:16:05 +1200 NZST\t\t\t\n" +
        'tacbookings-e2e2595-app-1\trunning\tUp 6 days (healthy)\ttacbookings-e2e2595-app:local\t2026-08-08 13:00:01 +1200 NZST\ttacbookings-e2e2595\t\t\n',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "pg-2376", project: "", state: "exited" });
    expect(rows[1]).toMatchObject({
      name: "tacbookings-e2e2595-app-1",
      project: "tacbookings-e2e2595",
    });
  });

  it("ignores blank lines rather than emitting an empty container", () => {
    expect(parseDockerOutput("\n\n")).toEqual([]);
  });
});

describe("parseArguments", () => {
  it("accepts nothing and --json", () => {
    expect(parseArguments([])).toEqual({ json: false });
    expect(parseArguments(["--json"])).toEqual({ json: true });
  });

  it("refuses anything that looks like a removal mode", () => {
    // There is no destructive mode, deliberately. A typo must fail loudly rather
    // than be ignored, so nobody believes they asked for one and got it.
    expect(() => parseArguments(["--remove"])).toThrow(/no removal mode/);
    expect(() => parseArguments(["--prune"])).toThrow(/Unrecognised argument/);
  });
});

describe("groupEntries", () => {
  it("groups only review-as-stale entries", () => {
    expect(
      groupEntries([
        { name: "a", project: null, issue: 1, reviewAsStale: false },
        { name: "b", project: null, issue: 2, reviewAsStale: true },
      ]),
    ).toEqual([
      { kind: "container", key: "b", issue: 2, members: ["b"], teardown: "docker rm -f b" },
    ]);
  });
});
