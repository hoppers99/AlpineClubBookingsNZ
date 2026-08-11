/**
 * The executor's SERVER-OWNED arm (AID-6A, #2375).
 *
 * A second evidence source is only safe if it is a second SOURCE and not a second
 * PATH. Every assertion here is about that: the gates that govern a SELECT-only read
 * still govern this one, in the same order, with the same audit row — and the one
 * gate it skips (the SELECT-only credential) is skipped because it does not apply,
 * which is also what makes readiness answerable when that credential is broken.
 *
 * The registry is stubbed rather than exercised through a real entry, so a gate can
 * be observed in isolation: the real entries are covered in `packs/__tests__`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

import { recordDiagnosticsToolAudit } from "../audit";
import { authorizeDiagnosticsToolCall } from "../authorize";
import { getDiagnosticsDatabase, runDiagnosticsReadOnlyQuery } from "../database";
import type { DiagnosticsToolEntry, DiagnosticsToolRawRow } from "../define";
import { createEmptyDiagnosticsConsentLedger } from "../consent";
import { invokeDiagnosticsTool } from "../invoke";
import { findDiagnosticsTool } from "../registry";
import { createDiagnosticsToolSession } from "../session";
import { DIAGNOSTICS_TOOL_BOUNDS, type DiagnosticsToolRow } from "../types";

vi.mock("../authorize", () => ({ authorizeDiagnosticsToolCall: vi.fn() }));
vi.mock("../database", () => ({
  getDiagnosticsDatabase: vi.fn(),
  runDiagnosticsReadOnlyQuery: vi.fn(),
}));
vi.mock("../audit", () => ({ recordDiagnosticsToolAudit: vi.fn() }));
vi.mock("../registry", () => ({ findDiagnosticsTool: vi.fn() }));
vi.mock("@/lib/observability-bridge", () => ({ reportAiError: vi.fn() }));

const authorizeMock = vi.mocked(authorizeDiagnosticsToolCall);
const auditMock = vi.mocked(recordDiagnosticsToolAudit);
const findToolMock = vi.mocked(findDiagnosticsTool);
const getDatabaseMock = vi.mocked(getDiagnosticsDatabase);
const runQueryMock = vi.mocked(runDiagnosticsReadOnlyQuery);

const FULL_MATRIX = Object.fromEntries(
  ADMIN_PERMISSION_AREAS.map((area) => [area.key, "view"]),
) as AdminPermissionMatrix;

const TOOL_ID = "diagnostics.server_owned_fixture";
const OBSERVED_AT = new Date("2026-08-03T09:00:00.000Z");

function serverOwnedEntry(options: {
  read: () => Promise<readonly DiagnosticsToolRawRow[]>;
  project?: (row: DiagnosticsToolRawRow) => DiagnosticsToolRow;
  rowLimit?: number;
  byteLimit?: number;
}): DiagnosticsToolEntry {
  return {
    id: TOOL_ID,
    source: "server_owned",
    label: "Server-owned fixture",
    description: "A registry entry that exists only to exercise the gates.",
    requiredAreas: ["support"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parseArgs: () => ({
      ok: true,
      source: "server_owned",
      args: {},
      read: options.read,
    }),
    project:
      options.project ??
      ((row) => ({ state: String(row.state ?? ""), count: Number(row.count ?? 0) })),
    rowLimit: options.rowLimit ?? 5,
    byteLimit: options.byteLimit ?? DIAGNOSTICS_TOOL_BOUNDS.maxResultBytes,
    surfacesPersonalData: false,
  };
}

function invoke() {
  const session = createDiagnosticsToolSession();
  session.beginRound();
  return invokeDiagnosticsTool({
    toolId: TOOL_ID,
    args: {},
    actingMemberId: "member-1",
    session,
    invocationChannel: "model_tool_use",
    consent: createEmptyDiagnosticsConsentLedger(),
    observedAt: OBSERVED_AT,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  authorizeMock.mockResolvedValue({ ok: true, matrix: FULL_MATRIX });
  auditMock.mockResolvedValue(undefined);
});

describe("server-owned evidence: the gates that still apply (#2375)", () => {
  it("returns projected rows and an audit row, and never touches the SELECT-only pool", async () => {
    findToolMock.mockReturnValue(
      serverOwnedEntry({
        read: async () => [
          { state: "ready", count: 1, secret: "sk-ant-api03-LEAK" },
        ],
      }),
    );

    const result = await invoke();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The projection is the boundary, exactly as it is for a SQL read: a field the
    // entry did not name cannot survive, whatever the source returned.
    expect(result.rows).toEqual([{ state: "ready", count: 1 }]);
    expect(JSON.stringify(result.rows)).not.toContain("sk-ant");
    expect(result.observedAt).toBe(OBSERVED_AT.toISOString());

    // The credential gate is not merely passed — it is never consulted, because it
    // does not govern this source. That is what keeps readiness answerable when the
    // diagnostics credential is itself the blocker.
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(runQueryMock).not.toHaveBeenCalled();

    // And the approved-metadata audit row is written BEFORE the evidence is returned.
    expect(auditMock).toHaveBeenCalledTimes(1);
    const audited = auditMock.mock.calls[0][0];
    expect(audited.audit.toolId).toBe(TOOL_ID);
    expect(audited.audit.authOutcome).toBe("allowed");
    expect(audited.audit.failureReason).toBeNull();
    expect(audited.audit.rowCount).toBe(1);
    // Metadata only: nothing from the row reaches the durable record except through
    // the non-reversible hashes.
    const serialisedAudit = JSON.stringify(audited);
    expect(serialisedAudit).not.toContain("sk-ant");
    expect(serialisedAudit).not.toContain("ready");
  });

  it("AUTHORIZES first, so a denied caller's source is never read", async () => {
    const read = vi.fn(async () => [{ state: "ready", count: 1 }]);
    findToolMock.mockReturnValue(serverOwnedEntry({ read }));
    authorizeMock.mockResolvedValue({
      ok: false,
      reason: "permission_denied",
      missingAreas: ["support"],
    });

    const result = await invoke();

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("permission_denied");
    expect(result.missingAreas).toEqual(["support"]);
    // The point: a first-party calculation is cheap to call and easy to call by
    // accident. It must not run for a caller who was refused.
    expect(read).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][0].audit.authOutcome).toBe("denied");
  });

  it("reports a REFUSING source as evidence_unavailable, with no rows", async () => {
    findToolMock.mockReturnValue(
      serverOwnedEntry({
        read: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.5:5432 for tac@example.org");
        },
      }),
    );

    const result = await invoke();

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("evidence_unavailable");
    // The operator sentence is fixed server-owned copy. The driver's message can quote
    // a value, so none of it travels — not into the result, not into the audit row.
    expect(result.message).not.toContain("ECONNREFUSED");
    expect(result.message).not.toContain("example.org");
    expect(JSON.stringify(result.audit)).not.toContain("ECONNREFUSED");
    expect(auditMock.mock.calls[0][0].audit.failureReason).toBe(
      "evidence_unavailable",
    );
    // Audited as what it was: an ALLOWED call that then failed, not a permission block.
    expect(auditMock.mock.calls[0][0].audit.authOutcome).toBe("allowed");
  });

  it("reports a source that throws SYNCHRONOUSLY the same way", async () => {
    findToolMock.mockReturnValue(
      serverOwnedEntry({
        read: (() => {
          throw new Error("thrown before a promise existed");
        }) as unknown as () => Promise<readonly DiagnosticsToolRawRow[]>,
      }),
    );
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("evidence_unavailable");
    }
  });

  it("gives up on a source that never answers, rather than hanging the request", async () => {
    vi.useFakeTimers();
    findToolMock.mockReturnValue(
      serverOwnedEntry({
        read: () => new Promise(() => {}),
      }),
    );

    const pending = invoke();
    await vi.advanceTimersByTimeAsync(
      DIAGNOSTICS_TOOL_BOUNDS.serverEvidenceTimeoutMs + 1_000,
    );
    const result = await pending;

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("evidence_unavailable");
    }
    vi.useRealTimers();
  });

  it("does not let a LATE rejection escape as an unhandled rejection", async () => {
    // `Promise.race` does not cancel the loser. A source that rejects after the
    // deadline would otherwise surface as an unhandled rejection, which on some Node
    // configurations takes the process with it.
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      findToolMock.mockReturnValue(
        serverOwnedEntry({
          read: () =>
            new Promise((_resolve, reject) => {
              setTimeout(
                () => reject(new Error("late")),
                DIAGNOSTICS_TOOL_BOUNDS.serverEvidenceTimeoutMs + 5_000,
              );
            }),
        }),
      );

      const pending = invoke();
      await vi.advanceTimersByTimeAsync(
        DIAGNOSTICS_TOOL_BOUNDS.serverEvidenceTimeoutMs + 1_000,
      );
      const result = await pending;
      expect(result.status).toBe("error");

      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      vi.useRealTimers();
    }
  });

  it("TRUNCATES an over-long source result and says so", async () => {
    findToolMock.mockReturnValue(
      serverOwnedEntry({
        rowLimit: 2,
        read: async () => [
          { state: "a", count: 1 },
          { state: "b", count: 2 },
          { state: "c", count: 3 },
          { state: "d", count: 4 },
        ],
      }),
    );

    const result = await invoke();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The executor slices, exactly as it does for a SQL read — a source cannot make a
    // partial answer look complete by returning more than its entry's ceiling.
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.audit.rowCount).toBe(2);
  });

  it("REFUSES an over-large result rather than trimming it", async () => {
    findToolMock.mockReturnValue(
      serverOwnedEntry({
        byteLimit: 64,
        read: async () => [{ state: "x".repeat(150), count: 1 }],
      }),
    );
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("result_too_large");
  });

  it("discards the evidence when the audit row cannot be written", async () => {
    findToolMock.mockReturnValue(
      serverOwnedEntry({ read: async () => [{ state: "ready", count: 1 }] }),
    );
    auditMock.mockRejectedValueOnce(new Error("audit table unavailable"));
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("audit_unavailable");
  });

  it("refuses a projection that returns something other than a flat scalar", async () => {
    findToolMock.mockReturnValue(
      serverOwnedEntry({
        read: async () => [{ state: "ready" }],
        // A `Date` is the realistic mistake for a server-owned source, whose raw rows
        // come from application objects rather than from the driver.
        project: () =>
          ({ observed: new Date() }) as unknown as DiagnosticsToolRow,
      }),
    );
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("redaction_failed");
  });

  it("refuses when the entry and its binding disagree about the source", async () => {
    // A shape only a bug can produce, and the honest outcome for a bug is a refusal
    // with no rows — never a fall-through to the other arm.
    findToolMock.mockReturnValue({
      ...serverOwnedEntry({ read: async () => [{ state: "ready", count: 1 }] }),
      parseArgs: () => ({
        ok: true,
        source: "select_only_sql",
        args: {},
        params: [],
      }),
    });
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("internal_error");
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it("still consumes a tool call, so a source cannot be probed for free", async () => {
    findToolMock.mockReturnValue(
      serverOwnedEntry({ read: async () => [{ state: "ready", count: 1 }] }),
    );
    const session = createDiagnosticsToolSession();
    session.beginRound();
    for (let call = 0; call < DIAGNOSTICS_TOOL_BOUNDS.maxToolCallsPerRound; call += 1) {
      const result = await invokeDiagnosticsTool({
        toolId: TOOL_ID,
        args: {},
        actingMemberId: "member-1",
        session,
        invocationChannel: "model_tool_use",
        consent: createEmptyDiagnosticsConsentLedger(),
        observedAt: OBSERVED_AT,
      });
      expect(result.status).toBe("ok");
    }
    const exhausted = await invokeDiagnosticsTool({
      toolId: TOOL_ID,
      args: {},
      actingMemberId: "member-1",
      session,
      invocationChannel: "model_tool_use",
      consent: createEmptyDiagnosticsConsentLedger(),
      observedAt: OBSERVED_AT,
    });
    expect(exhausted.status).toBe("error");
    if (exhausted.status === "error") {
      expect(exhausted.reason).toBe("call_budget_exhausted");
    }
  });
});
