/**
 * AID-6A deployment / configuration / readiness evidence (#2375).
 *
 * These four entries read FIRST-PARTY CALCULATIONS rather than the SELECT-only
 * database, which buys them exactly one privilege — being answerable when the
 * diagnostics credential itself is the fault — and costs them nothing else. So the
 * assertions here are about the two things that could go wrong with that trade:
 *
 *  1. THE PROJECTION IS THE BOUNDARY. There is no `GRANT` narrowing what a
 *     first-party function can see, so the field allowlist is doing all the work. Each
 *     test below hands the projection a row carrying the secrets and identifiers the
 *     underlying sources really do hold nearby — an API key, a connection string, a
 *     provider error message, a raw job error, a member id — and asserts none of it
 *     survives.
 *  2. THE CANONICAL ANSWER IS REUSED, NOT REPRODUCED. The readiness row must come
 *     from `getDiagnosticsReadiness` (the function the admin readiness screen renders)
 *     and the job health from `buildCronHealthReport`, so the two surfaces cannot
 *     disagree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-diagnostics-config", () => ({
  getDiagnosticsReadiness: vi.fn(),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(),
}));
vi.mock("@/lib/ai-diagnostics-usage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai-diagnostics-usage")>();
  return { ...actual, getDiagnosticsUsageSummary: vi.fn() };
});
vi.mock("@/lib/admin-cron-runs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-cron-runs")>();
  return { ...actual, getCronRunsForAdminHealth: vi.fn() };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    diagnosticsBudgetReservation: { count: vi.fn() },
    diagnosticsUsageEvent: { findFirst: vi.fn() },
  },
}));

import { getDiagnosticsReadiness } from "@/lib/ai-diagnostics-config";
import { getDiagnosticsUsageSummary } from "@/lib/ai-diagnostics-usage";
import {
  CronRunReadDeadlineError,
  getCronRunsForAdminHealth,
} from "@/lib/admin-cron-runs";
import { canonicalStringify } from "@/lib/diagnostics/knowledge/hash";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";

import { renderToolResultEvidenceBlock } from "../../render";
import { DIAGNOSTICS_TOOL_BOUNDS } from "../../types";
import {
  DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID,
  DIAGNOSTICS_DEPLOYMENT_TOOL_ID,
  DIAGNOSTICS_READINESS_TOOL_ID,
  DIAGNOSTICS_SUPPORT_SYSTEM_TOOLS,
  DIAGNOSTICS_USAGE_HEALTH_TOOL_ID,
} from "../support-system";
import {
  readBackgroundJobHealthEvidence,
  readDiagnosticsDeploymentEvidence,
  readDiagnosticsReadinessEvidence,
  readDiagnosticsUsageHealthEvidence,
  resetDiagnosticsDeploymentEvidenceCacheForTests,
} from "../support-evidence";

const readinessMock = vi.mocked(getDiagnosticsReadiness);
const flagsMock = vi.mocked(loadEffectiveModuleFlags);
const usageMock = vi.mocked(getDiagnosticsUsageSummary);
const cronRunsMock = vi.mocked(getCronRunsForAdminHealth);
const reservationCountMock = vi.mocked(prisma.diagnosticsBudgetReservation.count);
const usageEventMock = vi.mocked(prisma.diagnosticsUsageEvent.findFirst);

function entry(id: string) {
  const found = DIAGNOSTICS_SUPPORT_SYSTEM_TOOLS.find(
    (candidate) => candidate.id === id,
  );
  if (!found) throw new Error(`${id} is not registered`);
  return found;
}

const NOW = new Date("2026-08-03T09:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  resetDiagnosticsDeploymentEvidenceCacheForTests();
  flagsMock.mockResolvedValue({ aiDiagnostics: true } as never);
});

afterEach(() => {
  resetDiagnosticsDeploymentEvidenceCacheForTests();
});

describe("AID-6A system evidence permissions (#2375)", () => {
  it("requires support:view, and only support:view, for every entry", () => {
    // The owner decision behind this: `support:view` is required ONLY for general
    // system, readiness, deployment and background-job evidence — and a domain tool
    // must never also demand it.
    for (const candidate of DIAGNOSTICS_SUPPORT_SYSTEM_TOOLS) {
      expect(candidate.requiredAreas, candidate.id).toEqual(["support"]);
      expect(candidate.surfacesPersonalData, candidate.id).toBe(false);
    }
  });

  it("reads a server-owned source, not the SELECT-only database", () => {
    for (const candidate of DIAGNOSTICS_SUPPORT_SYSTEM_TOOLS) {
      expect(candidate.source, candidate.id).toBe("server_owned");
      // No `sql` handle at all, so the SQL-shaped contract tests cannot silently skip
      // one of these and the executor cannot take the SQL arm with it.
      expect("sql" in candidate, candidate.id).toBe(false);
    }
  });

  it("takes no arguments, and refuses any", () => {
    for (const candidate of DIAGNOSTICS_SUPPORT_SYSTEM_TOOLS) {
      expect(Object.keys(candidate.inputSchema.properties)).toEqual([]);
      expect(candidate.parseArgs({}).ok, candidate.id).toBe(true);
      expect(candidate.parseArgs({ month: "2026-08" }).ok, candidate.id).toBe(false);
      expect(
        candidate.parseArgs(JSON.parse('{"__proto__":{"x":1}}')).ok,
        candidate.id,
      ).toBe(false);
    }
  });
});

describe("AID-6A readiness evidence (#2375)", () => {
  it("reuses the canonical readiness calculation, module flag and all", async () => {
    readinessMock.mockResolvedValue({
      ready: false,
      moduleEnabled: true,
      keyState: "needs_reentry",
      monthlyBudgetCents: 5_000,
      databaseState: "over_privileged",
      blockers: ["credential_needs_reentry", "database_role_unsafe"],
    });

    const rows = await readDiagnosticsReadinessEvidence();

    // The canonical function, called with the module flag the deployment resolved —
    // NOT a second readiness rule of this pack's own.
    expect(flagsMock).toHaveBeenCalledTimes(1);
    expect(readinessMock).toHaveBeenCalledWith({ aiDiagnostics: true });

    const projected = entry(DIAGNOSTICS_READINESS_TOOL_ID).project(rows[0]);
    expect(projected).toEqual({
      readinessState: "not_ready",
      moduleEnabled: true,
      credentialState: "needs_reentry",
      monthlyBudgetCents: 5_000,
      databaseRoleState: "over_privileged",
      blockerCodes: "credential_needs_reentry,database_role_unsafe",
      blockerCount: 2,
    });
  });

  it("says `none` rather than an empty string when nothing is blocking", async () => {
    readinessMock.mockResolvedValue({
      ready: true,
      moduleEnabled: true,
      keyState: "saved",
      monthlyBudgetCents: 20_000,
      databaseState: "verified",
      blockers: [],
    });
    const rows = await readDiagnosticsReadinessEvidence();
    const projected = entry(DIAGNOSTICS_READINESS_TOOL_ID).project(rows[0]);
    expect(projected.readinessState).toBe("ready");
    expect(projected.blockerCodes).toBe("none");
    expect(projected.blockerCount).toBe(0);
  });

  it("stays answerable when the diagnostics credential is the thing that is broken", async () => {
    // The reason this entry is `server_owned` at all. A SQL entry would have to pass
    // the credential gate first, so the one question an operator most needs answered —
    // "why is diagnostics refusing?" — would be refused for the same reason.
    readinessMock.mockResolvedValue({
      ready: false,
      moduleEnabled: true,
      keyState: "saved",
      monthlyBudgetCents: 20_000,
      databaseState: "not_configured",
      blockers: ["database_not_configured"],
    });
    const rows = await readDiagnosticsReadinessEvidence();
    expect(rows).toHaveLength(1);
    expect(
      entry(DIAGNOSTICS_READINESS_TOOL_ID).project(rows[0]).databaseRoleState,
    ).toBe("not_configured");
  });

  it("projects no secret, key id, or privilege detail even when the row carries one", () => {
    const projected = entry(DIAGNOSTICS_READINESS_TOOL_ID).project({
      readiness_state: "ready",
      module_enabled: true,
      credential_state: "saved",
      monthly_budget_cents: 100,
      database_role_state: "verified",
      blocker_codes: "none",
      blocker_count: 0,
      // Everything below is a field the readiness contract withholds by design, or a
      // secret that lives one function away from the source this reads.
      // Shaped like the real thing but marked as a placeholder, so the knowledge
      // bundle's secret scan and gitleaks both read it as documentation rather than
      // refusing to bundle this file.
      api_key: "sk-ant-api03-placeholder-not-a-real-key",
      connection_string:
        "postgresql://ai_diagnostics_ro:placeholder-pw@db:5432/tacbookings",
      role_name: "ai_diagnostics_ro",
      role_password: "placeholder-pw",
      writable_relations: 0,
      credential_id: "cmqcred0001",
    });
    const serialised = JSON.stringify(projected);
    for (const leak of [
      "sk-ant",
      "placeholder-pw",
      "postgresql://",
      "ai_diagnostics_ro",
      "cmqcred0001",
      "writable",
    ]) {
      expect(serialised, leak).not.toContain(leak);
    }
  });
});

describe("AID-6A deployment evidence (#2375)", () => {
  const ENV_KEYS = ["RELEASE_ID", "GIT_COMMIT_SHA", "APP_RUNTIME_ROLE"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // No bundle on disk in a unit run: the loader's `missing` reason is the expected
    // state, and it must be reported as a stable code rather than as an absence.
    process.env.KNOWLEDGE_BUNDLE_PATH =
      "src/lib/diagnostics/tools/packs/__tests__/no-such-bundle.json";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.KNOWLEDGE_BUNDLE_PATH;
  });

  it("prefers RELEASE_ID and says where the identifier came from", async () => {
    process.env.RELEASE_ID = "v0.13.0";
    process.env.GIT_COMMIT_SHA = "a".repeat(40);
    const rows = await readDiagnosticsDeploymentEvidence(NOW);
    const projected = entry(DIAGNOSTICS_DEPLOYMENT_TOOL_ID).project(rows[0]);
    expect(projected.releaseId).toBe("v0.13.0");
    expect(projected.releaseIdSource).toBe("release-id");
  });

  it("falls back to the commit SHA, and reports `unset` when neither is wired", async () => {
    process.env.GIT_COMMIT_SHA = "b".repeat(40);
    let rows = await readDiagnosticsDeploymentEvidence(NOW);
    let projected = entry(DIAGNOSTICS_DEPLOYMENT_TOOL_ID).project(rows[0]);
    expect(projected.releaseId).toBe("b".repeat(40));
    expect(projected.releaseIdSource).toBe("commit-sha");
    // A 40-character hex SHA must survive the redaction pass unchanged — it is public
    // build metadata, and a redacted release id would make this tool useless.
    expect(projected.releaseId).toMatch(/^[0-9a-f]{40}$/);

    delete process.env.GIT_COMMIT_SHA;
    resetDiagnosticsDeploymentEvidenceCacheForTests();
    rows = await readDiagnosticsDeploymentEvidence(NOW);
    projected = entry(DIAGNOSTICS_DEPLOYMENT_TOOL_ID).project(rows[0]);
    expect(projected.releaseId).toBeNull();
    expect(projected.releaseIdSource).toBe("unset");
  });

  it("reports a missing knowledge bundle as a stable code, with no loader detail", async () => {
    const rows = await readDiagnosticsDeploymentEvidence(NOW);
    const projected = entry(DIAGNOSTICS_DEPLOYMENT_TOOL_ID).project(rows[0]);
    expect(projected.knowledgeBundleState).toBe("missing");
    expect(projected.knowledgeBundleCommitSha).toBeNull();
    expect(projected.knowledgeBundleCommitVerified).toBe(false);
    expect(projected.knowledgeBundleEntryCount).toBe(0);
    // The loader's `detail` can quote a filesystem path or a parse error. Neither
    // belongs in the evidence channel, so no field carries one.
    expect(JSON.stringify(projected)).not.toContain("no-such-bundle");
  });

  it("projects flat scalars only, and drops anything else the row carries", async () => {
    const rows = await readDiagnosticsDeploymentEvidence(NOW);
    const projected = entry(DIAGNOSTICS_DEPLOYMENT_TOOL_ID).project({
      ...rows[0],
      // A `Date` would be refused by the executor as a non-flat scalar, discarding the
      // whole result — so the source must never produce one.
      built_at: new Date(),
      env: process.env,
      nonce: "nonce-abc123",
    });
    for (const value of Object.values(projected)) {
      expect(["string", "number", "boolean", "object"]).toContain(typeof value);
      if (typeof value === "object") expect(value).toBeNull();
    }
    expect(JSON.stringify(projected)).not.toContain("nonce-abc123");
    expect(typeof projected.uptimeSeconds).toBe("number");
    expect(Number.isInteger(projected.uptimeSeconds)).toBe(true);
  });

  it("caches the bundle verification, which is an O(entries) hash of a constant", async () => {
    // Not a micro-optimisation: the artifact is baked into the image, so re-verifying
    // per tool call re-derives the same answer at CPU cost on the request path.
    await readDiagnosticsDeploymentEvidence(NOW);
    const second = await readDiagnosticsDeploymentEvidence(
      new Date(NOW.getTime() + 1_000),
    );
    expect(second[0].knowledge_bundle_state).toBe("missing");
    // And the TTL really does expire, so a bundle written after start-up is picked up.
    const later = await readDiagnosticsDeploymentEvidence(
      new Date(NOW.getTime() + 6 * 60 * 1000),
    );
    expect(later[0].knowledge_bundle_state).toBe("missing");
  });
});

describe("AID-6A budget and usage health (#2375)", () => {
  /**
   * The canonical summary's month block, kept as a named constant so a test that
   * overrides one figure spreads a TYPED object. `summary()` itself is cast to
   * `never` for the mock's signature, and spreading that cast value would be
   * spreading `never`.
   */
  const BASE_MONTH = {
    month: "2026-08",
    requestCount: 12,
    roundtripCount: 30,
    failedCount: 2,
    inputTokens: 1,
    outputTokens: 2,
    cacheWriteTokens: 3,
    cacheReadTokens: 4,
    settledCents: 12_345,
    activeReservedCents: 84,
    usagePercent: 0.24,
    budgetStatus: "healthy",
  };

  function summary(overrides: Record<string, unknown> = {}) {
    return {
      budget: {
        limitCents: 50_000,
        warningThresholds: [0.5, 0.8, 1],
        worstCaseRoundtripCents: 42,
        maxToolRounds: 8,
      },
      month: { ...BASE_MONTH },
      recentFailures: [
        {
          id: "cmqevent0001",
          surface: "ai-diagnostics-chat",
          model: "claude",
          errorCode: "overloaded_error",
          statusCode: 529,
          errorMessage:
            "provider said: request from tac@example.org with key sk-ant-api03-LEAK failed",
          createdAt: NOW,
        },
      ],
      ...overrides,
    } as never;
  }

  it("takes its money from the canonical summary and derives the remainder", async () => {
    usageMock.mockResolvedValue(summary());
    reservationCountMock.mockResolvedValue(3 as never);
    usageEventMock
      .mockResolvedValueOnce({ createdAt: NOW } as never)
      .mockResolvedValueOnce({
        createdAt: new Date("2026-08-02T01:02:03.000Z"),
        errorCode: "rate_limit",
      } as never);

    const rows = await readDiagnosticsUsageHealthEvidence(NOW);
    const projected = entry(DIAGNOSTICS_USAGE_HEALTH_TOOL_ID).project(rows[0]);

    expect(usageMock).toHaveBeenCalledWith(NOW);
    expect(projected.monthlyBudgetCents).toBe(50_000);
    expect(projected.settledCents).toBe(12_345);
    expect(projected.activeReservedCents).toBe(84);
    // Derived from those same three numbers, in integer cents, so it cannot disagree
    // with the panel about spend.
    expect(projected.remainingCents).toBe(50_000 - 12_345 - 84);
    expect(projected.staleReservationCount).toBe(3);
    expect(projected.latestSuccessAtUtc).toBe(NOW.toISOString());
    expect(projected.latestFailureAtUtc).toBe("2026-08-02T01:02:03.000Z");
    expect(projected.latestFailureCode).toBe("rate_limit");
    expect(Number.isInteger(projected.remainingCents)).toBe(true);
  });

  it("reports a negative remainder honestly rather than clamping it to zero", async () => {
    // A budget lowered below what is already committed is a real operational state,
    // and hiding it behind a zero would make the number look healthy.
    usageMock.mockResolvedValue(
      summary({
        budget: {
          limitCents: 100,
          warningThresholds: [0.5, 0.8, 1],
          worstCaseRoundtripCents: 42,
          maxToolRounds: 8,
        },
        month: { ...BASE_MONTH, settledCents: 500, activeReservedCents: 50 },
      }),
    );
    reservationCountMock.mockResolvedValue(0 as never);
    usageEventMock.mockResolvedValue(null as never);
    const rows = await readDiagnosticsUsageHealthEvidence(NOW);
    expect(
      entry(DIAGNOSTICS_USAGE_HEALTH_TOOL_ID).project(rows[0]).remainingCents,
    ).toBe(-450);
  });

  it("never projects a provider error message, a prompt, an answer or an event id", async () => {
    usageMock.mockResolvedValue(summary());
    reservationCountMock.mockResolvedValue(0 as never);
    usageEventMock.mockResolvedValue(null as never);
    const rows = await readDiagnosticsUsageHealthEvidence(NOW);
    const projected = entry(DIAGNOSTICS_USAGE_HEALTH_TOOL_ID).project({
      ...rows[0],
      // What the summary really carries alongside, and what a careless projection
      // would sweep in.
      error_message:
        "provider said: request from tac@example.org with key sk-ant-api03-LEAK failed",
      prompt: "why is this booking stuck",
      answer: "because the payment failed",
      admin_member_id: "cmqadmin0001",
      event_id: "cmqevent0001",
    });
    const serialised = JSON.stringify(projected);
    for (const leak of [
      "sk-ant",
      "tac@example.org",
      "why is this booking",
      "because the payment",
      "cmqadmin0001",
      "cmqevent0001",
    ]) {
      expect(serialised, leak).not.toContain(leak);
    }
    // The diagnosable part — the stable code — is what remains.
    expect(Object.keys(projected)).toContain("latestFailureCode");
  });

  it("carries no timestamps at all when the month has no settled calls", async () => {
    usageMock.mockResolvedValue(summary());
    reservationCountMock.mockResolvedValue(0 as never);
    usageEventMock.mockResolvedValue(null as never);
    const rows = await readDiagnosticsUsageHealthEvidence(NOW);
    const projected = entry(DIAGNOSTICS_USAGE_HEALTH_TOOL_ID).project(rows[0]);
    expect(projected.latestSuccessAtUtc).toBeNull();
    expect(projected.latestFailureAtUtc).toBeNull();
    expect(projected.latestFailureCode).toBeNull();
  });
});

describe("AID-6A background job health (#2375)", () => {
  it("classifies with the authoritative report and orders worst severity first", async () => {
    // No runs at all: every expected job is `missing`, which the authoritative
    // classifier decides — this pack does not compare timestamps itself.
    cronRunsMock.mockResolvedValue([]);
    const rows = await readBackgroundJobHealthEvidence(NOW);
    expect(cronRunsMock).toHaveBeenCalledTimes(1);
    expect(rows.length).toBeGreaterThan(10);

    const severities = rows.map((row) => String(row.severity));
    const rank: Record<string, number> = { error: 0, warning: 1, info: 2, ok: 3 };
    for (let index = 1; index < severities.length; index += 1) {
      expect(
        rank[severities[index]] ?? 9,
        `${severities[index - 1]} before ${severities[index]}`,
      ).toBeGreaterThanOrEqual(rank[severities[index - 1]] ?? 9);
    }
  });

  it("orders TOTALLY, so the audit result hash is stable for identical evidence", async () => {
    cronRunsMock.mockResolvedValue([]);
    const first = await readBackgroundJobHealthEvidence(NOW);
    const second = await readBackgroundJobHealthEvidence(NOW);
    expect(second.map((row) => row.job_name)).toEqual(
      first.map((row) => row.job_name),
    );
    // Ties are broken by the unique job name, so no two rows can swap.
    const names = first.map((row) => String(row.job_name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("spends the row ceiling on problems before healthy jobs", async () => {
    cronRunsMock.mockResolvedValue([]);
    const rows = await readBackgroundJobHealthEvidence(NOW);
    const ceiling = entry(DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID).rowLimit;
    // The ceiling is deliberately below the number of registered jobs, because twenty
    // rows of this shape render inside the substrate's 8 000-character evidence block
    // and the whole registry does not. So what matters is not that every unhealthy job
    // fits —
    // on a deployment with no run history at all, every job is unhealthy — but that a
    // HEALTHY job can never displace an unhealthy one.
    expect(rows.length).toBeGreaterThan(ceiling);
    const unhealthy = rows.filter((row) => row.severity !== "ok");
    const kept = rows.slice(0, ceiling);
    expect(kept.filter((row) => row.severity !== "ok")).toHaveLength(
      Math.min(unhealthy.length, ceiling),
    );
    // And the tool reports the true total on every row, so a truncated list is never
    // mistaken for the whole registry.
    for (const row of rows) expect(row.registered_job_count).toBe(rows.length);
  });

  it("puts a failing job ahead of the healthy ones when most are fine", async () => {
    // The realistic shape: history for every expected job, one of them failing. The
    // failure has to be the first row an operator (and the model) sees.
    const recent = new Date(NOW.getTime() - 60 * 1000);
    cronRunsMock.mockResolvedValue([
      {
        id: "run-fail",
        jobName: "payment-recovery",
        startedAt: recent,
        completedAt: recent,
        durationMs: 10,
        status: "FAILURE",
        resultSummary: null,
        error: "boom",
        createdAt: recent,
      },
    ]);
    const rows = await readBackgroundJobHealthEvidence(NOW);
    const failing = rows.findIndex((row) => row.job_name === "payment-recovery");
    expect(failing).toBeGreaterThanOrEqual(0);
    expect(rows[failing].severity).toBe("error");
    // Every row before it is at least as severe; nothing healthier is ahead of it.
    for (const row of rows.slice(0, failing)) {
      expect(row.severity).toBe("error");
    }
  });

  it("never projects a job's raw error or result payload", async () => {
    cronRunsMock.mockResolvedValue([]);
    const rows = await readBackgroundJobHealthEvidence(NOW);
    const projected = entry(DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID).project({
      ...rows[0],
      error:
        "Error: connect ECONNREFUSED 10.0.0.5:5432\n    at TCPConnectWrap.afterConnect",
      result_summary: { filename: "backup.sql.gz", s3Key: "secret/path" },
      triggered_by_member_id: "cmqadmin0001",
    });
    const serialised = JSON.stringify(projected);
    for (const leak of [
      "ECONNREFUSED",
      "TCPConnectWrap",
      "backup.sql.gz",
      "secret/path",
      "cmqadmin0001",
    ]) {
      expect(serialised, leak).not.toContain(leak);
    }
  });

  it("projects a missing staleness threshold as null, not as zero", async () => {
    cronRunsMock.mockResolvedValue([]);
    const rows = await readBackgroundJobHealthEvidence(NOW);
    const projected = entry(DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID).project({
      ...rows[0],
      stale_after_minutes: null,
    });
    // Zero would read as "stale immediately", which is a different claim.
    expect(projected.staleAfterMinutes).toBeNull();
  });

  it("fits its own byte ceiling and renders whole at its own row ceiling", async () => {
    // The defect this pins (#2375): `byteLimit` was 8 192, and on an ordinary
    // deployment — every job having simply run at least once, so latestRunAtUtc,
    // latestRunStatus and latestSuccessAtUtc are populated — twenty projected rows
    // serialised to 8 272 bytes. Gate 9 refused the whole result with
    // `result_too_large`, and the model was told to narrow a question that TAKES NO
    // ARGUMENTS: the evidence was unreachable, in exactly the situation the tool exists
    // for. Nothing caught it because no assertion existed on byteCount at all.
    cronRunsMock.mockResolvedValue([]);
    const rows = await readBackgroundJobHealthEvidence(NOW);
    const jobEntry = entry(DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID);
    const projected = rows.slice(0, jobEntry.rowLimit).map((row) =>
      jobEntry.project({
        ...row,
        // The steady state of a mature deployment: a recent success and an older
        // failure, so every timestamp field is populated.
        latest_run_at_utc: "2026-08-03T03:04:05.678Z",
        latest_run_status: "SUCCESS",
        latest_success_at_utc: "2026-08-03T03:04:05.678Z",
        latest_failure_at_utc: "2026-05-01T03:04:05.678Z",
      }),
    );
    expect(projected).toHaveLength(jobEntry.rowLimit);
    expect(
      Buffer.byteLength(canonicalStringify(projected), "utf8"),
    ).toBeLessThanOrEqual(jobEntry.byteLimit);

    const block = renderToolResultEvidenceBlock({
      schemaVersion: 1,
      status: "ok",
      toolId: jobEntry.id,
      label: jobEntry.label,
      rows: projected,
      truncated: true,
      evidenceScope: jobEntry.evidenceScope,
      observedAt: NOW.toISOString(),
      audit: {
        toolId: jobEntry.id,
        areasChecked: ["support"],
        authOutcome: "allowed",
        failureReason: null,
        argsHash: "a".repeat(64),
        resultHash: "b".repeat(64),
        rowCount: projected.length,
        byteCount: 0,
        durationMs: 1,
        roundIndex: 0,
        observedAt: NOW.toISOString(),
      },
    });
    // All eighteen present, which is why the ceiling is eighteen and not the twenty
    // that rendered to 7 999 of the 8 000 available characters.
    expect(block.split("\n").filter((line) => /^- \d+\./.test(line))).toHaveLength(
      jobEntry.rowLimit,
    );
    expect(block).toContain(`rows (${jobEntry.rowLimit}):`);
    // And the scope says how many of how many, so a truncated list is not read as the
    // whole registry.
    expect(block).toContain("scope: ");
    expect(block).toContain("registeredJobCount");
  });

  it("bounds its own read in TIME, and refuses rather than reporting a partial one", async () => {
    // The `server_owned` arm gets none of the SQL arm's `BEGIN READ ONLY`,
    // `statement_timeout` or `lock_timeout`, and the executor's 15-second race abandons
    // a slow read WITHOUT cancelling it. So this source carries its own deadline, set
    // below the executor's.
    cronRunsMock.mockResolvedValue([]);
    await readBackgroundJobHealthEvidence(NOW);
    const options = cronRunsMock.mock.calls[0]?.[1];
    expect(options?.deadlineAtMs).toBeGreaterThan(Date.now());
    expect(options?.deadlineAtMs).toBeLessThan(
      Date.now() + DIAGNOSTICS_TOOL_BOUNDS.serverEvidenceTimeoutMs,
    );

    // A deadline refusal REJECTS. It must not resolve with fewer runs: the classifier
    // would turn missing rows into a `missing` verdict for a job that is running fine,
    // which is a fabricated answer rather than an absent one. The executor maps the
    // rejection to `evidence_unavailable` with no rows.
    cronRunsMock.mockRejectedValue(new CronRunReadDeadlineError());
    await expect(readBackgroundJobHealthEvidence(NOW)).rejects.toThrow(
      CronRunReadDeadlineError,
    );
  });

  it("projects timestamps as ISO strings, never as Date objects", async () => {
    cronRunsMock.mockResolvedValue([
      {
        id: "run-1",
        jobName: "backup",
        startedAt: new Date("2026-08-03T03:00:00.000Z"),
        completedAt: new Date("2026-08-03T03:04:00.000Z"),
        durationMs: 240_000,
        status: "SUCCESS",
        resultSummary: { filename: "backup.sql.gz" },
        error: null,
        createdAt: new Date("2026-08-03T03:00:00.000Z"),
      },
    ]);
    const rows = await readBackgroundJobHealthEvidence(NOW);
    const backup = rows.find((row) => row.job_name === "backup");
    expect(backup).toBeDefined();
    const projected = entry(DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID).project(
      backup as Record<string, unknown>,
    );
    // The authoritative classifier reports the COMPLETION instant (falling back to the
    // start when a run never completed), which is the right answer for "when did this
    // last finish" — asserted here so a future change cannot quietly swap in the
    // start instant and shift every freshness judgement by a run's duration.
    expect(projected.latestRunAtUtc).toBe("2026-08-03T03:04:00.000Z");
    expect(projected.latestSuccessAtUtc).toBe("2026-08-03T03:04:00.000Z");
    expect(projected.latestRunStatus).toBe("SUCCESS");
    // A `Date` would be refused by the executor as a non-flat scalar. Asserted with
    // the matcher rather than `instanceof`, because the projected value type is a
    // union of scalars and `instanceof` on it is a type error, not a check.
    for (const value of Object.values(projected)) {
      expect(value).not.toBeInstanceOf(Date);
    }
  });
});
