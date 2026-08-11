/**
 * The executor's CONSENT gates (AID-7a, #2785; ADR-004 §1; owner decision #2378 Q2).
 *
 * Two gates, sitting between argument parsing and metering, and the assertions here
 * are about four things that are easy to get wrong and impossible to notice:
 *
 *  1. THE GATES REFUSE, and refuse with their own stable reasons rather than being
 *     folded into `permission_denied` — an operator who holds every relevant area
 *     must not be sent to a Full Admin for access they already have.
 *  2. THEY REFUSE BEFORE THE READ, so a refused call costs no database work and
 *     leaks nothing through timing or through a partially built result.
 *  3. THEY ARE NON-VACUOUS. Every refusal below is paired with the invocation that
 *     is ALLOWED, so a gate that refused everything would fail these tests too.
 *  4. THE DURABLE ROW SAYS WHAT HAPPENED. A consented read and a refused one are
 *     distinguishable in the audit metadata, which they were not before.
 *
 * The registry is stubbed so a gate can be observed in isolation with entries whose
 * declarations are exactly what each test is about; `registry.test.ts` pins that the
 * entries which actually ship carry the same declarations, and `invoke.test.ts`
 * exercises a real registry entry end to end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

import { recordDiagnosticsToolAudit } from "../audit";
import { authorizeDiagnosticsToolCall } from "../authorize";
import {
  createDiagnosticsConsentLedger,
  createEmptyDiagnosticsConsentLedger,
  type DiagnosticsConsentLedger,
} from "../consent";
import { getDiagnosticsDatabase, runDiagnosticsReadOnlyQuery } from "../database";
import type { DiagnosticsToolEntry } from "../define";
import { invokeDiagnosticsTool } from "../invoke";
import { findDiagnosticsTool } from "../registry";
import { createDiagnosticsToolSession } from "../session";
import {
  DIAGNOSTICS_TOOL_BOUNDS,
  type DiagnosticsInvocationChannel,
} from "../types";

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

const OBSERVED_AT = new Date("2026-08-03T09:00:00.000Z");
const BOOKING_A = "ckbooking0000000000000001";
const BOOKING_B = "ckbooking0000000000000002";
const MEMBER_M = "ckmember00000000000000001";

const FAKE_POOL = { fake: "pool" } as unknown as Parameters<
  typeof runDiagnosticsReadOnlyQuery
>[1];

/**
 * A SELECT-only entry whose declarations the test chooses. `parseArgs` echoes the
 * caller's object as the accepted arguments, which is what the real definer does
 * after the schema accepts them.
 */
function entry(
  overrides: Partial<DiagnosticsToolEntry> & { id: string },
): DiagnosticsToolEntry {
  return {
    source: "select_only_sql",
    sql: "SELECT true AS ok",
    label: "Consent gate fixture",
    description: "A registry entry that exists only to exercise the consent gates.",
    requiredAreas: ["bookings"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parseArgs: (raw) => ({
      ok: true,
      source: "select_only_sql",
      args: raw,
      params: [],
    }),
    project: (row) => ({
      ownerMemberRef: String(row.owner_member_ref ?? ""),
    }),
    rowLimit: 5,
    byteLimit: DIAGNOSTICS_TOOL_BOUNDS.maxResultBytes,
    surfacesPersonalData: true,
    ...overrides,
  } as DiagnosticsToolEntry;
}

const PER_RECORD = entry({
  id: "diagnostics.per_record_fixture",
  personalDataRecordKind: "booking",
  personalDataRecordArgKey: "bookingId",
  relatedRecordRefs: [{ field: "ownerMemberRef", kind: "member" }],
});

const SEARCH = entry({
  id: "diagnostics.search_fixture",
  operatorOnly: true,
});

const NON_SENSITIVE = entry({
  id: "diagnostics.non_sensitive_fixture",
  surfacesPersonalData: false,
});

function consentTo(records: { kind: "booking" | "member"; id: string }[]) {
  return createDiagnosticsConsentLedger({
    recordConsentGranted: true,
    peopleSearchGranted: false,
    selectedRecords: records,
  });
}

function run(options: {
  tool: DiagnosticsToolEntry;
  args?: unknown;
  consent?: DiagnosticsConsentLedger;
  invocationChannel?: DiagnosticsInvocationChannel;
}) {
  findToolMock.mockReturnValue(options.tool);
  const session = createDiagnosticsToolSession();
  session.beginRound();
  return invokeDiagnosticsTool({
    toolId: options.tool.id,
    args: options.args ?? { bookingId: BOOKING_A },
    actingMemberId: "member-1",
    session,
    invocationChannel: options.invocationChannel ?? "model_tool_use",
    consent: options.consent ?? createEmptyDiagnosticsConsentLedger(),
    observedAt: OBSERVED_AT,
  });
}

function lastAuditMetadata() {
  const call = auditMock.mock.calls.at(-1);
  if (!call) throw new Error("no audit row was written");
  return call[0].audit;
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeMock.mockResolvedValue({ ok: true, matrix: FULL_MATRIX });
  auditMock.mockResolvedValue(undefined);
  getDatabaseMock.mockResolvedValue({
    ok: true,
    pool: FAKE_POOL,
    roleName: "ai_diagnostics_ro",
  });
  runQueryMock.mockResolvedValue({
    ok: true,
    rows: [{ owner_member_ref: MEMBER_M }],
    durationMs: 3,
  });
});

describe("gate 4b — ADR-004 §1 record consent (#2785)", () => {
  it("refuses a personal-data entry when the operator consented to nothing", async () => {
    const result = await run({ tool: PER_RECORD });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("sensitive_consent_required");
    // No rows, no database work, and the refusal reached the durable log.
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(runQueryMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a record the operator did not include, and allows the one they did", async () => {
    const consent = consentTo([{ kind: "booking", id: BOOKING_A }]);

    const other = await run({
      tool: PER_RECORD,
      args: { bookingId: BOOKING_B },
      consent,
    });
    expect(other.status).toBe("error");
    if (other.status === "error") {
      expect(other.reason).toBe("sensitive_consent_required");
    }

    // The same entry, the same operator, the same permissions — one record apart.
    const included = await run({
      tool: PER_RECORD,
      args: { bookingId: BOOKING_A },
      consent,
    });
    expect(included.status).toBe("ok");
  });

  it("refuses when the tick is off even for a record that was selected", async () => {
    const untickedButSelected = createDiagnosticsConsentLedger({
      recordConsentGranted: false,
      peopleSearchGranted: false,
      selectedRecords: [{ kind: "booking", id: BOOKING_A }],
    });
    const result = await run({ tool: PER_RECORD, consent: untickedButSelected });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("sensitive_consent_required");
    }
  });

  it("refuses when the entry names a record but the arguments carry none", async () => {
    // A declaration that has gone stale, or arguments from a schema that stopped
    // requiring the id: the gate has nothing to check, so it FAILS rather than passes.
    const result = await run({
      tool: PER_RECORD,
      args: { somethingElse: "x" },
      consent: consentTo([{ kind: "booking", id: BOOKING_A }]),
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("sensitive_consent_required");
    }
  });

  it("does not gate an entry that surfaces no personal data", async () => {
    const result = await run({ tool: NON_SENSITIVE });
    expect(result.status).toBe("ok");
    expect(lastAuditMetadata().sensitiveInclusion).toBe("not_applicable");
  });

  it("runs AFTER authorization, so a denied caller is told about the permission", async () => {
    // Order matters for honesty as well as for security: an admin missing
    // `bookings:view` should be told that, not told to include a record.
    authorizeMock.mockResolvedValue({
      ok: false,
      reason: "permission_denied",
      missingAreas: ["bookings"],
    });
    const result = await run({ tool: PER_RECORD });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("permission_denied");
    }
  });
});

describe("gate 4a — the invocation channel and the people-search tick (#2785)", () => {
  it("refuses a search the MODEL asked for when the operator did not tick", async () => {
    const result = await run({ tool: SEARCH, invocationChannel: "model_tool_use" });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("operator_action_required");
    expect(runQueryMock).not.toHaveBeenCalled();
  });

  it("allows the same search once the operator ticks people-search", async () => {
    // The owner's Q2 decision, made enforceable: the tick is what moves this call
    // from refused to allowed, and nothing else about the request changes.
    const ticked = createDiagnosticsConsentLedger({
      recordConsentGranted: false,
      peopleSearchGranted: true,
      selectedRecords: [],
    });
    const result = await run({
      tool: SEARCH,
      consent: ticked,
      invocationChannel: "model_tool_use",
    });
    expect(result.status).toBe("ok");
    expect(lastAuditMetadata().peopleSearchTick).toBe("granted");
  });

  it("allows the operator's OWN record-picker action without any tick", async () => {
    const result = await run({
      tool: SEARCH,
      invocationChannel: "operator_action",
      consent: createEmptyDiagnosticsConsentLedger(),
    });
    expect(result.status).toBe("ok");
    expect(lastAuditMetadata().invocationChannel).toBe("operator_action");
  });

  it("does not use the search tick as record consent, or the other way round", async () => {
    // Two independent decisions. A ticked search must not unlock per-record reads,
    // and included records must not unlock searching.
    const searchOnly = createDiagnosticsConsentLedger({
      recordConsentGranted: false,
      peopleSearchGranted: true,
      selectedRecords: [{ kind: "booking", id: BOOKING_A }],
    });
    const perRecord = await run({ tool: PER_RECORD, consent: searchOnly });
    expect(perRecord.status).toBe("error");
    if (perRecord.status === "error") {
      expect(perRecord.reason).toBe("sensitive_consent_required");
    }

    const recordsOnly = consentTo([{ kind: "booking", id: BOOKING_A }]);
    const search = await run({ tool: SEARCH, consent: recordsOnly });
    expect(search.status).toBe("error");
    if (search.status === "error") {
      expect(search.reason).toBe("operator_action_required");
    }
  });

  it("does not gate a NON-search entry on the channel", async () => {
    // The channel gate is about search, not about the model. An ordinary consented
    // read is exactly as available to the model as it is to the operator.
    const result = await run({
      tool: PER_RECORD,
      consent: consentTo([{ kind: "booking", id: BOOKING_A }]),
      invocationChannel: "model_tool_use",
    });
    expect(result.status).toBe("ok");
  });
});

describe("the investigation widens only through a successful, audited call (#2785)", () => {
  it("absorbs the declared related ref, and the derived record is then readable", async () => {
    // The flagship flow, through the executor rather than the ledger's own unit test:
    // booking A was selected, the projected owner is absorbed, and a second entry
    // keyed on that member is then allowed under the same consent.
    const consent = consentTo([{ kind: "booking", id: BOOKING_A }]);
    const first = await run({ tool: PER_RECORD, consent });
    expect(first.status).toBe("ok");
    expect(consent.has("member", MEMBER_M)).toBe(true);
    expect(consent.originOf("member", MEMBER_M)).toBe("derived");

    const memberTool = entry({
      id: "diagnostics.member_fixture",
      requiredAreas: ["membership"],
      personalDataRecordKind: "member",
      personalDataRecordArgKey: "memberId",
    });
    const second = await run({
      tool: memberTool,
      args: { memberId: MEMBER_M },
      consent,
    });
    expect(second.status).toBe("ok");
  });

  it("does NOT absorb from a call that was refused", async () => {
    // The refusal happens before the read, so there are no rows to absorb from — but
    // the property is asserted directly, because "no rows" and "did not absorb" are
    // different claims and only one of them is the rule.
    const consent = consentTo([{ kind: "booking", id: BOOKING_A }]);
    const refused = await run({
      tool: PER_RECORD,
      args: { bookingId: BOOKING_B },
      consent,
    });
    expect(refused.status).toBe("error");
    expect(consent.has("member", MEMBER_M)).toBe(false);
  });

  it("does NOT absorb when the audit row could not be written", async () => {
    // Evidence is discarded on an unauditable read, and consent must not widen on the
    // strength of a read the durable log has no record of.
    const consent = consentTo([{ kind: "booking", id: BOOKING_A }]);
    auditMock.mockRejectedValueOnce(new Error("audit down"));
    const result = await run({ tool: PER_RECORD, consent });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("audit_unavailable");
    }
    expect(consent.has("member", MEMBER_M)).toBe(false);
  });

  it("survives a ledger that throws, without turning an audited success into an error", async () => {
    // The absorption runs after the audit row is written. A throw there must not make
    // the caller's result disagree with the durable log about what happened.
    const consent = consentTo([{ kind: "booking", id: BOOKING_A }]);
    vi.spyOn(consent, "absorbRelatedRecordRefs").mockImplementation(() => {
      throw new Error("ledger exploded");
    });
    const result = await run({ tool: PER_RECORD, consent });
    expect(result.status).toBe("ok");
  });
});

describe("the durable row records the consent decision (#2785)", () => {
  it("distinguishes a granted read from a refused one", async () => {
    const consent = consentTo([{ kind: "booking", id: BOOKING_A }]);
    await run({ tool: PER_RECORD, consent });
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "granted",
      consentRecordKind: "booking",
      consentRecordOrigin: "operator_selected",
      invocationChannel: "model_tool_use",
      peopleSearchTick: "withheld",
    });

    await run({ tool: PER_RECORD, args: { bookingId: BOOKING_B }, consent });
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "refused",
      consentRecordKind: "booking",
      consentRecordOrigin: null,
    });
  });

  it("records a DERIVED record as derived", async () => {
    const consent = consentTo([{ kind: "booking", id: BOOKING_A }]);
    await run({ tool: PER_RECORD, consent });
    const memberTool = entry({
      id: "diagnostics.member_fixture",
      requiredAreas: ["membership"],
      personalDataRecordKind: "member",
      personalDataRecordArgKey: "memberId",
    });
    await run({ tool: memberTool, args: { memberId: MEMBER_M }, consent });
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "granted",
      consentRecordKind: "member",
      consentRecordOrigin: "derived",
    });
  });

  it("carries NO subject record id", async () => {
    // ADR-004 §4: `argsHash` pins WHICH record non-reversibly; the consent fields say
    // what kind it was and how it got there. The id itself is never durable.
    const consent = consentTo([{ kind: "booking", id: BOOKING_A }]);
    await run({ tool: PER_RECORD, consent });
    const serialized = JSON.stringify(lastAuditMetadata());
    expect(serialized).not.toContain(BOOKING_A);
    expect(serialized).not.toContain(MEMBER_M);
  });

  it("says `not_reached` when the gate never ran, rather than claiming it did", async () => {
    // Refused at authorization, on an entry that IS sensitive: recording
    // `not_applicable` here would assert something nobody established.
    authorizeMock.mockResolvedValue({
      ok: false,
      reason: "permission_denied",
      missingAreas: ["bookings"],
    });
    await run({ tool: PER_RECORD });
    expect(lastAuditMetadata().sensitiveInclusion).toBe("not_reached");

    // And when no entry was identified at all.
    findToolMock.mockReturnValue(undefined);
    const session = createDiagnosticsToolSession();
    session.beginRound();
    await invokeDiagnosticsTool({
      toolId: "diagnostics.no_such_tool",
      args: {},
      actingMemberId: "member-1",
      session,
      invocationChannel: "model_tool_use",
      consent: createEmptyDiagnosticsConsentLedger(),
      observedAt: OBSERVED_AT,
    });
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "not_reached",
      consentRecordKind: null,
      consentRecordOrigin: null,
    });
  });

  it("records the people-search tick on every row, not only on searches", async () => {
    const ticked = createDiagnosticsConsentLedger({
      recordConsentGranted: true,
      peopleSearchGranted: true,
      selectedRecords: [{ kind: "booking", id: BOOKING_A }],
    });
    await run({ tool: NON_SENSITIVE, consent: ticked });
    expect(lastAuditMetadata().peopleSearchTick).toBe("granted");
  });
});
