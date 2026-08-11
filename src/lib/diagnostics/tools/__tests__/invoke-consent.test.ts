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
import {
  createDiagnosticsToolSession,
  DIAGNOSTICS_TOOL_SESSION_LIMITS,
  type DiagnosticsToolSession,
} from "../session";
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
  consentRecordKind: "booking",
  consentRecordArgKey: "bookingId",
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

/**
 * ONE QUESTION IS ONE SESSION, and the ledger binds to it (#2785 review). Every test
 * that runs two invocations under the SAME ledger has to run them under the same
 * session too, exactly as the AID-7 loop will: a ledger presented to a second
 * session is a ledger that outlived its question, and the executor refuses it.
 * `question()` is that pairing, made explicit so a test cannot get it wrong silently.
 */
function question(consent?: DiagnosticsConsentLedger) {
  const session = createDiagnosticsToolSession();
  session.beginRound();
  return { session, consent: consent ?? createEmptyDiagnosticsConsentLedger() };
}

function run(options: {
  tool: DiagnosticsToolEntry;
  args?: unknown;
  consent?: DiagnosticsConsentLedger;
  session?: DiagnosticsToolSession;
  invocationChannel?: DiagnosticsInvocationChannel;
}) {
  findToolMock.mockReturnValue(options.tool);
  let session = options.session;
  if (!session) {
    session = createDiagnosticsToolSession();
    session.beginRound();
  }
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
    const asked = question(consentTo([{ kind: "booking", id: BOOKING_A }]));

    const other = await run({
      ...asked,
      tool: PER_RECORD,
      args: { bookingId: BOOKING_B },
    });
    expect(other.status).toBe("error");
    if (other.status === "error") {
      expect(other.reason).toBe("sensitive_consent_required");
    }

    // The same entry, the same operator, the same permissions — one record apart.
    const included = await run({
      ...asked,
      tool: PER_RECORD,
      args: { bookingId: BOOKING_A },
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

  it("does not gate an entry that is about no particular record", async () => {
    const result = await run({ tool: NON_SENSITIVE });
    expect(result.status).toBe("ok");
    expect(lastAuditMetadata().sensitiveInclusion).toBe("not_applicable");
  });

  it("gates a PER-RECORD entry even when it surfaces no personal data (#2785 review)", async () => {
    // The hole this closes. `booking_audit_history`, `payment_refund_state` and the
    // Xero linkage entry return codes, amounts and instants — no names — so they
    // declared `surfacesPersonalData: false` and sat entirely outside the gate. The
    // model could therefore read the refund history of a payment whose
    // `payment_summary` the ledger had just refused, using an id it saw in a hop-1
    // row. The record scope binds them now; the personal-details TICK still does not.
    const perRecordCodes = entry({
      id: "diagnostics.non_personal_per_record_fixture",
      surfacesPersonalData: false,
      consentRecordKind: "booking",
      consentRecordArgKey: "bookingId",
    });

    const outside = await run({
      tool: perRecordCodes,
      args: { bookingId: BOOKING_B },
      consent: consentTo([{ kind: "booking", id: BOOKING_A }]),
    });
    expect(outside.status).toBe("error");
    if (outside.status === "error") {
      // Its own reason: telling this operator "that tool reads personal details"
      // would be false, and a durable row counted as a personal-inclusion refusal
      // would overstate what was refused.
      expect(outside.reason).toBe("record_not_included");
    }
    expect(runQueryMock).not.toHaveBeenCalled();
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "not_applicable",
      consentRecordKind: "booking",
      consentRecordOrigin: null,
      failureReason: "record_not_included",
    });

    // Non-vacuity: the same entry, the included record, and NO personal-details tick.
    const untickedButSelected = createDiagnosticsConsentLedger({
      recordConsentGranted: false,
      peopleSearchGranted: false,
      selectedRecords: [{ kind: "booking", id: BOOKING_A }],
    });
    const inside = await run({
      tool: perRecordCodes,
      args: { bookingId: BOOKING_A },
      consent: untickedButSelected,
    });
    expect(inside.status).toBe("ok");
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "not_applicable",
      consentRecordKind: "booking",
      consentRecordOrigin: "operator_selected",
    });
  });

  it("refuses a subject whose kind the investigation cannot hold (#2785 review)", async () => {
    // `finance_audit_history`'s shape: the record KIND is the `subject` argument, and
    // two of its four subjects are records an operator cannot select. A static
    // declaration could not express this at all, and leaving it undeclared left the
    // whole entry ungated.
    const auditHistory = entry({
      id: "diagnostics.audit_history_fixture",
      surfacesPersonalData: false,
      consentRecordArgKey: "recordId",
      consentRecordKindByArg: {
        argKey: "subject",
        kinds: { booking: "booking", manual_refund_task: null },
      },
    });
    const asked = question(consentTo([{ kind: "booking", id: BOOKING_A }]));

    const unmapped = await run({
      ...asked,
      tool: auditHistory,
      args: { subject: "manual_refund_task", recordId: BOOKING_A },
    });
    expect(unmapped.status).toBe("error");
    if (unmapped.status === "error") {
      expect(unmapped.reason).toBe("record_not_included");
    }
    expect(lastAuditMetadata().consentRecordKind).toBeNull();

    const mapped = await run({
      ...asked,
      tool: auditHistory,
      args: { subject: "booking", recordId: BOOKING_A },
    });
    expect(mapped.status).toBe("ok");
    expect(lastAuditMetadata().consentRecordKind).toBe("booking");
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
    const asked = question(consentTo([{ kind: "booking", id: BOOKING_A }]));
    const first = await run({ ...asked, tool: PER_RECORD });
    expect(first.status).toBe("ok");
    expect(asked.consent.has("member", MEMBER_M)).toBe(true);
    expect(asked.consent.originOf("member", MEMBER_M)).toBe("derived");

    const memberTool = entry({
      id: "diagnostics.member_fixture",
      requiredAreas: ["membership"],
      consentRecordKind: "member",
      consentRecordArgKey: "memberId",
    });
    const second = await run({
      ...asked,
      tool: memberTool,
      args: { memberId: MEMBER_M },
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

describe("one ledger belongs to one question (#2785 review)", () => {
  it("refuses every call once a ledger is presented to a SECOND question", async () => {
    // The multi-turn failure. AID-7's loop builds the ledger when the conversation
    // opens; on turn two the operator changes the record and clears the tick, and a
    // ledger kept across turns would still hold turn one's records and read them as
    // consented — recording `sensitiveInclusion: "granted"` for consent that had been
    // withdrawn. "Per request" is now enforced rather than described.
    const first = question(consentTo([{ kind: "booking", id: BOOKING_A }]));
    const allowed = await run({ ...first, tool: PER_RECORD });
    expect(allowed.status).toBe("ok");

    const secondSubmission = createDiagnosticsToolSession();
    secondSubmission.beginRound();
    const stale = await run({
      tool: PER_RECORD,
      consent: first.consent,
      session: secondSubmission,
    });
    expect(stale.status).toBe("error");
    if (stale.status === "error") expect(stale.reason).toBe("internal_error");
    // No rows, no database work — and the refusal is still audited.
    expect(runQueryMock).toHaveBeenCalledTimes(1);
    expect(lastAuditMetadata()).toMatchObject({
      failureReason: "internal_error",
      rowCount: 0,
    });
    // AND IT COST A CALL (#2785 review). Once a loop has made this mistake every
    // tool_use block of every round takes this exit, so a refusal that cost nothing
    // would leave `maxToolCallsPerRound` reading zero for the whole session while the
    // audit table filled — the same "probing is free" defect the unregistered-id
    // refusal was fixed for. The row records the round it was claimed in, not -1.
    expect(secondSubmission.stats()).toMatchObject({
      callsThisRound: 1,
      callsThisSession: 1,
    });
    expect(lastAuditMetadata().roundIndex).toBe(0);
  });

  it("spends the SAME round budget every other refusal spends", async () => {
    // What claiming actually buys, stated as the property rather than as a counter:
    // a round in which the model sent four blocks against a stale ledger has used its
    // four calls, so the fifth invocation of that round is out of budget — exactly as
    // it would have been had those four been unregistered ids or ordinary reads.
    // Before the claim, a session could take an unbounded number of these while
    // `stats()` still read zero, and the per-round ceiling never engaged at all.
    const staleLedger = consentTo([{ kind: "booking", id: BOOKING_A }]);
    staleLedger.bindToLoopSession(createDiagnosticsToolSession());
    const session = createDiagnosticsToolSession();
    session.beginRound();

    const perRound = DIAGNOSTICS_TOOL_SESSION_LIMITS.maxToolCallsPerRound;
    for (let call = 0; call < perRound; call += 1) {
      const refused = await run({ tool: PER_RECORD, consent: staleLedger, session });
      expect(refused.status).toBe("error");
      if (refused.status === "error") expect(refused.reason).toBe("internal_error");
    }
    expect(session.stats().callsThisRound).toBe(perRound);

    // A perfectly good call, on this question's own ledger, in the same round.
    const nextCall = await run({
      tool: PER_RECORD,
      consent: consentTo([{ kind: "booking", id: BOOKING_A }]),
      session,
    });
    expect(nextCall.status).toBe("error");
    if (nextCall.status === "error") {
      expect(nextCall.reason).toBe("call_budget_exhausted");
    }
  });

  it("does not throw, and still audits, when the ledger itself is missing", async () => {
    // A #2378 wiring step that adds the parameter to one call path and not another.
    // The tick read used to sit outside the try block, so this threw a TypeError
    // before any `fail(...)` existed: the caller saw a rejected promise and NO audit
    // row was written, which is the single outcome the never-throws wrapper exists to
    // prevent.
    findToolMock.mockReturnValue(NON_SENSITIVE);
    const session = createDiagnosticsToolSession();
    session.beginRound();
    const result = await invokeDiagnosticsTool({
      toolId: NON_SENSITIVE.id,
      args: {},
      actingMemberId: "member-1",
      session,
      invocationChannel: "model_tool_use",
      consent: undefined as unknown as DiagnosticsConsentLedger,
      observedAt: OBSERVED_AT,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("internal_error");
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(lastAuditMetadata().peopleSearchTick).toBe("withheld");
  });
});

describe("the durable row records the consent decision (#2785)", () => {
  it("distinguishes a granted read from a refused one", async () => {
    const asked = question(consentTo([{ kind: "booking", id: BOOKING_A }]));
    await run({ ...asked, tool: PER_RECORD });
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "granted",
      consentRecordKind: "booking",
      consentRecordOrigin: "operator_selected",
      invocationChannel: "model_tool_use",
      peopleSearchTick: "withheld",
    });

    await run({ ...asked, tool: PER_RECORD, args: { bookingId: BOOKING_B } });
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "refused",
      consentRecordKind: "booking",
      consentRecordOrigin: null,
    });
  });

  it("records a DERIVED record as derived", async () => {
    const asked = question(consentTo([{ kind: "booking", id: BOOKING_A }]));
    await run({ ...asked, tool: PER_RECORD });
    const memberTool = entry({
      id: "diagnostics.member_fixture",
      requiredAreas: ["membership"],
      consentRecordKind: "member",
      consentRecordArgKey: "memberId",
    });
    await run({ ...asked, tool: memberTool, args: { memberId: MEMBER_M } });
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
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "not_reached",
      // And no record KIND either: the arguments were never resolved, so nothing
      // established what this invocation was about. Copying the entry's static
      // declaration here would assert a subject nobody identified — and for the
      // entries whose kind is an argument there is no static declaration to copy.
      consentRecordKind: null,
    });

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

  it("records the inclusion decision for an ALLOWED search, both ways in (#2785 review)", async () => {
    // Untested before, and deleting the branch or flipping it to "refused" left every
    // other consent test green while every durable row for an allowed search silently
    // recorded "nobody established whether this was sensitive" — on the one invocation
    // class that returns a bulk list of people.
    const ticked = createDiagnosticsConsentLedger({
      recordConsentGranted: false,
      peopleSearchGranted: true,
      selectedRecords: [],
    });
    await run({ tool: SEARCH, consent: ticked, invocationChannel: "model_tool_use" });
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "granted",
      peopleSearchTick: "granted",
      invocationChannel: "model_tool_use",
      consentRecordKind: null,
    });

    // The operator's own record-picker action is the SECOND way in, and the row still
    // reads `granted` — their own act is the inclusion decision. `peopleSearchTick`
    // and `invocationChannel` beside it are what say which of the two happened, which
    // is why the field's own docblock now states both.
    await run({
      tool: SEARCH,
      consent: createEmptyDiagnosticsConsentLedger(),
      invocationChannel: "operator_action",
    });
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "granted",
      peopleSearchTick: "withheld",
      invocationChannel: "operator_action",
    });

    // And a REFUSED search is `refused`, not `not_reached`: the §1 decision was made.
    await run({ tool: SEARCH, invocationChannel: "model_tool_use" });
    expect(lastAuditMetadata()).toMatchObject({
      sensitiveInclusion: "refused",
      failureReason: "operator_action_required",
    });
  });

  it("narrows the invocation channel before it reaches the durable row (#2785 review)", async () => {
    // `audit.ts` asserts of the five new fields that "every one of them is a closed
    // enum or null — there is no free text and no identifier here". TypeScript makes
    // that true of in-repo call sites; this makes it true of the ROW, the same way
    // `toolId` is sanitised rather than echoed. An unrecognised value narrows to the
    // gated channel, so it cannot buy an operator's authority either.
    const result = await run({
      tool: NON_SENSITIVE,
      invocationChannel: "operator_action; DROP" as DiagnosticsInvocationChannel,
    });
    expect(result.status).toBe("ok");
    expect(lastAuditMetadata().invocationChannel).toBe("model_tool_use");
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
