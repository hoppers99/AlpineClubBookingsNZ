import { describe, expect, it } from "vitest";
import {
  assertDatabaseTargetConfirmation,
  buildBlockedInductionBaselineResult,
  formatInductionBaselineOutput,
  formatInductionBaselineReport,
  INDUCTION_BASELINE_JSON_BEGIN,
  INDUCTION_BASELINE_JSON_END,
  InductionBaselineCliError,
  parseInductionBaselineArgs,
  parseSafeDatabaseTarget,
  safeInductionBaselineJson,
} from "@/lib/induction-baseline-cli";
import type { InductionBaselineReport } from "@/lib/induction-baseline";

const REQUIRED_ARGS = [
  "--actor-member-id",
  "admin-1",
  "--baseline-date",
  "2024-06-30",
  "--provenance-note",
  "Committee minute 2024-07",
];

const REPORT: InductionBaselineReport = {
  mode: "dry-run",
  clubName: "Example Alpine Club",
  actorMemberId: "admin-1",
  baselineDate: "2024-06-30",
  provenance: "Trusted legacy induction baseline: Committee minute 2024-07",
  template: {
    id: "template-1",
    name: "Club induction",
    version: "legacy-v1",
  },
  configuredAgeTiers: [
    { tier: "CHILD", label: "Child" },
    { tier: "ADULT", label: "Adult" },
  ],
  tierCounts: [
    {
      tier: "CHILD",
      label: "Child",
      eligiblePopulation: 1,
      toCreate: 1,
      alreadyCompleted: 0,
      openWorkflow: 0,
    },
    {
      tier: "ADULT",
      label: "Adult",
      eligiblePopulation: 1,
      toCreate: 0,
      alreadyCompleted: 1,
      openWorkflow: 0,
    },
  ],
  counts: {
    eligiblePopulation: 2,
    toCreate: 1,
    alreadyCompleted: 1,
    openWorkflow: 0,
    notApplicable: 1,
  },
  toCreate: [
    { memberId: "child-1", ageTier: "CHILD", existingInductions: [] },
  ],
  alreadyCompleted: [
    {
      memberId: "adult-1",
      ageTier: "ADULT",
      existingInductions: [
        { id: "induction-1", kind: "RE_INDUCTION", status: "COMPLETED" },
      ],
    },
  ],
  openWorkflows: [],
  notApplicable: [
    { memberId: "org-1", ageTier: "NOT_APPLICABLE" },
  ],
  appliedCount: 0,
};

describe("induction baseline CLI", () => {
  it("defaults to dry-run and does not require destructive confirmations", () => {
    expect(parseInductionBaselineArgs(REQUIRED_ARGS)).toMatchObject({
      apply: false,
      actorMemberId: "admin-1",
      baselineDate: "2024-06-30",
      provenanceNote: "Committee minute 2024-07",
    });
  });

  it("requires every exact confirmation with --apply", () => {
    expect(() =>
      parseInductionBaselineArgs(["--apply", ...REQUIRED_ARGS]),
    ).toThrow("--confirm-club-name is required with --apply.");

    const parsed = parseInductionBaselineArgs([
      "--apply",
      ...REQUIRED_ARGS,
      "--confirm-club-name",
      "Example Alpine Club",
      "--confirm-db-host",
      "db.internal:5432",
      "--confirm-db-name",
      "club_bookings",
    ]);
    expect(parsed).toMatchObject({
      apply: true,
      confirmClubName: "Example Alpine Club",
      confirmDatabaseHost: "db.internal:5432",
      confirmDatabaseName: "club_bookings",
    });
  });

  it("preserves literal shell metacharacters in quoted argument values", () => {
    const provenance =
      'Minute "$HOME" `not-a-command` $(also-data); & | < >';
    const clubName = 'Example "$CLUB" $(literal); Alpine Club';
    const parsed = parseInductionBaselineArgs([
      "--apply",
      "--actor-member-id",
      "admin-1",
      "--baseline-date",
      "2024-06-30",
      "--provenance-note",
      provenance,
      "--confirm-club-name",
      clubName,
      "--confirm-db-host",
      "postgres:5432",
      "--confirm-db-name",
      "tacbookings",
    ]);

    expect(parsed.provenanceNote).toBe(provenance);
    expect(parsed.confirmClubName).toBe(clubName);
  });

  it.each([
    ["--apply", "--apply"],
    ["--dry-run", "--dry-run"],
    ["--apply", "--dry-run"],
    ["--dry-run", "--apply"],
  ])("rejects repeated mode flags %s %s", (first, second) => {
    expect(() =>
      parseInductionBaselineArgs([first, second, ...REQUIRED_ARGS]),
    ).toThrow("mode flag");
  });

  it.each([
    "--actor-member-id",
    "--baseline-date",
    "--provenance-note",
    "--confirm-club-name",
    "--confirm-db-host",
    "--confirm-db-name",
  ])("rejects duplicate %s values", (flag) => {
    expect(() =>
      parseInductionBaselineArgs([flag, "first", flag, "second"]),
    ).toThrow(`${flag} option may be supplied only once`);
  });

  it("never echoes an unknown argument token, URL, username, or credential", () => {
    const secret =
      "postgresql://example-user:example-password@db.internal/private";
    let thrown: unknown;
    try {
      parseInductionBaselineArgs([...REQUIRED_ARGS, secret]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InductionBaselineCliError);
    expect((thrown as Error).message).toBe(
      "Unknown argument. Run with --help to see the supported options.",
    );
    expect((thrown as Error).message).not.toContain(secret);
    expect((thrown as Error).message).not.toContain("example-user");
    expect((thrown as Error).message).not.toContain("example-password");
  });

  it("parses only the safe target fields and never returns credentials or the raw URL", () => {
    const raw =
      "postgresql://example-user:example-password@db.internal:55432/club%5Fbookings?sslmode=require";
    const target = parseSafeDatabaseTarget(raw);
    expect(target).toEqual({
      host: "db.internal:55432",
      databaseName: "club_bookings",
    });
    expect(JSON.stringify(target)).not.toContain("example-user");
    expect(JSON.stringify(target)).not.toContain("example-password");
    expect(JSON.stringify(target)).not.toContain(raw);
  });

  it("requires exact parsed database host and name confirmations on apply", () => {
    const target = {
      host: "db.internal:55432",
      databaseName: "club_bookings",
    };
    expect(() =>
      assertDatabaseTargetConfirmation({
        apply: true,
        target,
        confirmHost: "db.internal",
        confirmDatabaseName: "club_bookings",
      }),
    ).toThrow("Database-host confirmation does not exactly match");
    expect(() =>
      assertDatabaseTargetConfirmation({
        apply: true,
        target,
        confirmHost: "db.internal:55432",
        confirmDatabaseName: "other",
      }),
    ).toThrow("Database-name confirmation does not exactly match");
    expect(() =>
      assertDatabaseTargetConfirmation({
        apply: true,
        target,
        confirmHost: "db.internal:55432",
        confirmDatabaseName: "club_bookings",
      }),
    ).not.toThrow();
  });

  it("formats deterministic categories and safe JSON without credentials", () => {
    const target = {
      host: "db.internal:55432",
      databaseName: "club_bookings",
    };
    const text = formatInductionBaselineReport(REPORT, target);
    expect(text).toContain("CREATE: 1");
    expect(text).toContain("ALREADY_COMPLETED: 1");
    expect(text).toContain("NOT_APPLICABLE (reported only): 1");
    expect(text).toContain("CHILD (Child): population=1 create=1");
    expect(text).toContain("Dry run: no changes written.");

    const json = safeInductionBaselineJson(REPORT, target);
    expect(json).toContain('"host": "db.internal:55432"');
    expect(json).not.toContain("postgresql://");
    expect(json).not.toContain("password");
  });

  it("does not describe a blocked apply as a no-op", () => {
    const blocked: InductionBaselineReport = {
      ...REPORT,
      mode: "apply",
      counts: { ...REPORT.counts, openWorkflow: 1 },
      openWorkflows: [
        {
          memberId: "child-2",
          ageTier: "CHILD",
          existingInductions: [
            {
              id: "induction-open",
              kind: "NEW_MEMBER",
              status: "IN_PROGRESS",
            },
          ],
        },
      ],
    };
    const text = formatInductionBaselineReport(blocked, {
      host: "db.internal:55432",
      databaseName: "club_bookings",
    });
    expect(text).toContain("Apply blocked: no changes written.");
    expect(text).not.toContain("Apply was a no-op");

    const output = formatInductionBaselineOutput(
      blocked,
      {
        host: "db.internal:55432",
        databaseName: "club_bookings",
      },
      true,
    );
    expect(output).toContain(INDUCTION_BASELINE_JSON_BEGIN);
    expect(output).toContain(INDUCTION_BASELINE_JSON_END);
    expect(output).toContain('"mode": "apply"');
    expect(output).toContain('"openWorkflow": 1');
    expect(output).not.toContain("postgresql://");
    expect(output).not.toContain("password");

    const blockedResult = buildBlockedInductionBaselineResult(
      blocked,
      {
        host: "db.internal:55432",
        databaseName: "club_bookings",
      },
      true,
    );
    expect(blockedResult.exitCode).toBe(1);
    expect(blockedResult.output).toBe(output);
  });

  it("rejects invalid database URLs without echoing their secret input", () => {
    const secret = "not-a-url-with-secret-password";
    let thrown: unknown;
    try {
      parseSafeDatabaseTarget(secret);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InductionBaselineCliError);
    expect((thrown as Error).message).not.toContain(secret);
  });
});
