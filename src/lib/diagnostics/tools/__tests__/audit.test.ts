/**
 * What actually lands in the durable row (#2374, ADR-004 §3/§4).
 *
 * `invoke.test.ts` asserts the audit OBJECT the executor builds. This suite is one
 * layer lower and is the one that matters for ADR-004: it asserts what
 * `createStructuredAuditLog` is called with — the action, the entity, the category,
 * the severity, the outcome, the retention class, and the exhaustive metadata field
 * list. A field added to `DiagnosticsToolAudit` reaches a durable row only by
 * someone editing `auditMetadata`, and this is the test that makes that true rather
 * than merely intended.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "@/lib/audit";

import {
  DIAGNOSTICS_TOOL_AUDIT_ACTION,
  DIAGNOSTICS_TOOL_AUDIT_ENTITY_TYPE,
  recordDiagnosticsToolAudit,
} from "../audit";
import type { DiagnosticsToolAudit } from "../types";

vi.mock("@/lib/audit", () => ({ createStructuredAuditLog: vi.fn() }));

const logMock = vi.mocked(createStructuredAuditLog);

const BASE_AUDIT: DiagnosticsToolAudit = {
  toolId: "diagnostics.substrate_probe",
  areasChecked: ["support"],
  authOutcome: "allowed",
  failureReason: null,
  argsHash: "a".repeat(64),
  resultHash: "b".repeat(64),
  rowCount: 3,
  byteCount: 128,
  durationMs: 7,
  roundIndex: 0,
  observedAt: "2026-08-02T03:04:05.000Z",
  invocationChannel: "model_tool_use",
  sensitiveInclusion: "not_applicable",
  consentRecordKind: null,
  consentRecordOrigin: null,
  peopleSearchTick: "withheld",
  recordConsentTick: "withheld",
};

function record(overrides: Partial<DiagnosticsToolAudit> = {}) {
  return recordDiagnosticsToolAudit({
    actingMemberId: "member-1",
    surface: "ai-diagnostics-chat",
    audit: { ...BASE_AUDIT, ...overrides },
  });
}

function lastEvent() {
  const call = logMock.mock.calls.at(-1);
  if (!call) throw new Error("no audit log event was written");
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  logMock.mockResolvedValue(undefined);
});

describe("diagnostics tool audit row (#2374, ADR-004)", () => {
  it("writes one security-category row under the stable action and entity type", async () => {
    await record();
    expect(logMock).toHaveBeenCalledTimes(1);
    const event = lastEvent();
    expect(event.action).toBe(DIAGNOSTICS_TOOL_AUDIT_ACTION);
    expect(event.action).toBe("ai_diagnostics.tool_invocation");
    expect(event.entity).toEqual({
      type: DIAGNOSTICS_TOOL_AUDIT_ENTITY_TYPE,
      id: "diagnostics.substrate_probe",
    });
    expect(event.category).toBe("security");
    expect(event.actor).toEqual({ memberId: "member-1" });
  });

  it("classifies retention as sensitive_access, not the platform default", async () => {
    // Diagnostics tool use IS sensitive access: an admin reading club data through
    // a new channel. Passing the class explicitly matters — `classifyAuditRetention`
    // would otherwise fall through to `critical` (7 years) for an action whose text
    // contains no view/access/login keyword.
    await record();
    expect(lastEvent().retentionClass).toBe("sensitive_access");
  });

  it("records the APPROVED metadata fields and nothing else", async () => {
    await record();
    const metadata = lastEvent().metadata as Record<string, unknown>;
    // Exhaustive and sorted: a new field on `DiagnosticsToolAudit` cannot reach a
    // durable row without this list being edited deliberately.
    expect(Object.keys(metadata).sort()).toEqual([
      "areasChecked",
      "argsHash",
      "authOutcome",
      "byteCount",
      "consentRecordKind",
      "consentRecordOrigin",
      "durationMs",
      "failureReason",
      "invocationChannel",
      "observedAt",
      "peopleSearchTick",
      "recordConsentTick",
      "resultHash",
      "roundIndex",
      "rowCount",
      "sensitiveInclusion",
      "toolId",
    ]);
    expect(metadata.argsHash).toBe("a".repeat(64));
    expect(metadata.resultHash).toBe("b".repeat(64));
    expect(metadata.rowCount).toBe(3);
    expect(metadata.byteCount).toBe(128);
  });

  it("carries the consent state through to the durable row (#2785)", async () => {
    // Before this, a `surfacesPersonalData` read taken WITH the operator's consent
    // was indistinguishable in the durable log from one taken without it. The
    // fields are hand-copied in `auditMetadata`, so this is what proves they are
    // actually copied rather than merely present on the type.
    await record({
      invocationChannel: "operator_action",
      sensitiveInclusion: "granted",
      consentRecordKind: "booking",
      consentRecordOrigin: "derived",
      peopleSearchTick: "granted",
    });
    expect(lastEvent().metadata).toMatchObject({
      invocationChannel: "operator_action",
      sensitiveInclusion: "granted",
      consentRecordKind: "booking",
      consentRecordOrigin: "derived",
      peopleSearchTick: "granted",
    });

    await record({
      sensitiveInclusion: "refused",
      consentRecordKind: "member",
      consentRecordOrigin: null,
    });
    expect(lastEvent().metadata).toMatchObject({
      sensitiveInclusion: "refused",
      consentRecordOrigin: null,
    });
  });

  it("carries no raw argument, row value, question or answer", async () => {
    // The negative half of ADR-004 §4, asserted against the whole serialized event
    // rather than only the metadata: a summary or an entity id is durable too.
    await record();
    const serialized = JSON.stringify(lastEvent());
    for (const forbidden of [
      "member@example.org",
      "SENTINEL",
      "sk-ant-",
      "password",
      "Bearer ",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("builds a summary from server-owned text only", async () => {
    await record();
    const summary = lastEvent().summary ?? "";
    // The registry key and a fixed enum. Nothing the operator, the model, or a
    // database value supplied can appear here.
    expect(summary).toBe(
      "Diagnostics tool diagnostics.substrate_probe ran on ai-diagnostics-chat",
    );
  });

  it.each([
    ["a success", {}, "info", "success"],
    [
      "a failure that was allowed",
      { failureReason: "query_failed" as const },
      "info",
      "failure",
    ],
    [
      "a denial",
      { authOutcome: "denied" as const, failureReason: "permission_denied" as const },
      "important",
      "blocked",
    ],
    [
      "a FAULT taken before authorization ran (#2785 review)",
      { authOutcome: "denied" as const, failureReason: "internal_error" as const },
      "info",
      "failure",
    ],
  ])(
    "maps %s to the right severity and outcome",
    async (_label, overrides, severity, outcome) => {
      await record(overrides as Partial<DiagnosticsToolAudit>);
      const event = lastEvent();
      expect(event.severity).toBe(severity);
      expect(event.outcome).toBe(outcome);
    },
  );

  it("records a denial as blocked even when it names no failure reason", async () => {
    await record({ authOutcome: "denied", failureReason: null });
    expect(lastEvent().outcome).toBe("blocked");
    expect(lastEvent().severity).toBe("important");
  });

  it("never calls a FAULT a permission incident (#2785 review)", async () => {
    // Every exit taken before the permission check records `authOutcome: "denied"`,
    // because nothing had been allowed yet. For `internal_error` — a caller bug, a
    // collaborator that threw — that used to mean a security-category, 24-month row
    // at `important`/`blocked` describing a block that never happened, and a
    // security-incident view filling up with them. The metadata still says exactly
    // what the row was: the auth outcome and the reason are both there.
    await record({ authOutcome: "denied", failureReason: "internal_error" });
    const event = lastEvent();
    expect(event.outcome).toBe("failure");
    expect(event.severity).toBe("info");
    expect(event.summary).toContain("failed");
    expect(event.metadata).toMatchObject({
      authOutcome: "denied",
      failureReason: "internal_error",
    });
  });

  it("PROPAGATES a write failure rather than swallowing it", async () => {
    // This is what makes `invoke.ts` able to fail closed with `audit_unavailable`.
    // A fire-and-forget or error-swallowing write here would silently allow an
    // unauditable evidence retrieval, which is precisely what ADR-004 prevents.
    logMock.mockRejectedValue(new Error("audit table unavailable"));
    await expect(record()).rejects.toThrow("audit table unavailable");
  });

  it("records a refusal that never entered the loop as roundIndex -1", async () => {
    await record({ roundIndex: -1, authOutcome: "denied", failureReason: "unknown_tool" });
    expect((lastEvent().metadata as Record<string, unknown>).roundIndex).toBe(-1);
  });
});
