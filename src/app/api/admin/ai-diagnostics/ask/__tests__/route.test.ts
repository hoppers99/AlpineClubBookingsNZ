/**
 * THE ASK ROUTE'S GATE SEQUENCE (AID-7, #2378).
 *
 * This is the endpoint that makes the AID substrate reachable by a human, so what is
 * tested here is the ORDER and the FAIL-CLOSED direction of its gates — not the
 * answering, which `loop.test.ts` covers.
 *
 * The cases are chosen from the ways a gate can be wrong without anything throwing: a
 * check that runs after the thing it guards, a refusal that leaks which gate refused,
 * a client value that reaches a decision it should only have selected, and a failure
 * that is reported as an answer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  applyRateLimit: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitedResponse: vi.fn(),
  readModuleFlag: vi.fn(),
  readiness: vi.fn(),
  apiKey: vi.fn(),
  meteringHealthy: vi.fn(),
  freshMatrix: vi.fn(),
  resolveContext: vi.fn(),
  runAnswer: vi.fn(),
  loadBundle: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  checkRateLimit: mocks.checkRateLimit,
  rateLimitedResponse: mocks.rateLimitedResponse,
  rateLimiters: {
    aiDiagnosticsIp: { id: "ai-diagnostics-ip" },
    aiDiagnosticsAdmin: { id: "ai-diagnostics-admin" },
    aiDiagnosticsGlobal: { id: "ai-diagnostics-global" },
  },
}));
vi.mock("@/lib/ai-diagnostics-config", () => ({
  readDiagnosticsModuleFlag: mocks.readModuleFlag,
  getDiagnosticsReadiness: mocks.readiness,
  getOperationalDiagnosticsApiKey: mocks.apiKey,
}));
// PARTIAL, not a replacement: the real module also exports the bounds
// (`DIAGNOSTICS_MAX_TOOL_ROUNDS`) that `tools/session.ts` reads at module-body time,
// and a full replacement makes the route fail to import rather than fail a test.
vi.mock("@/lib/ai-diagnostics-usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-diagnostics-usage")>()),
  isDiagnosticsMeteringHealthy: mocks.meteringHealthy,
}));
vi.mock("@/lib/diagnostics/page-context/authorize", () => ({
  readFreshAdminPermissionMatrix: mocks.freshMatrix,
}));
vi.mock("@/lib/diagnostics/page-context/resolve", () => ({
  resolveDiagnosticsPageContext: mocks.resolveContext,
}));
vi.mock("@/lib/diagnostics/answer/loop", () => ({
  runDiagnosticsAnswer: mocks.runAnswer,
}));
vi.mock("@/lib/diagnostics/knowledge/load", () => ({
  loadKnowledgeBundle: mocks.loadBundle,
}));
vi.mock("@/lib/observability-bridge", () => ({ reportAiError: vi.fn() }));

import { POST } from "../route";

const OK_SUMMARY = {
  complete: true,
  hasWithheldEvidence: false,
  withheldAreas: [],
  hasConsentWithheld: false,
  hasSearchWithheld: false,
  hasAuthoritativeBlocker: false,
  hasInferredBlockerOnly: false,
  states: [],
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    // `/admin/members/[id]` is the ONE dynamic route the page-context registry
    // carries — discovered while writing these tests, not assumed. Bookings have no
    // detail page at all in this codebase, which is why the route also accepts a
    // registered `recordId` selector; that path is covered separately below.
    pathname: "/admin/members/clx0123456789abcdefgh",
    question: "why will this booking not confirm?",
    transcript: [],
    allowPeopleSearch: false,
    allowRecordPersonalDetails: false,
    ...overrides,
  };
}

function request(payload: unknown = body()) {
  return new Request("https://example.test/api/admin/ai-diagnostics/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "member-1" } },
  });
  mocks.applyRateLimit.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ success: true });
  mocks.readModuleFlag.mockResolvedValue(true);
  mocks.meteringHealthy.mockReturnValue(true);
  mocks.readiness.mockResolvedValue({
    ready: true,
    moduleEnabled: true,
    keyState: "saved",
    monthlyBudgetCents: 5000,
    databaseState: "verified",
    blockers: [],
  });
  mocks.apiKey.mockResolvedValue("sk-diagnostics");
  mocks.freshMatrix.mockResolvedValue({ ok: true, matrix: { support: "view" } });
  mocks.resolveContext.mockResolvedValue({
    schemaVersion: 1,
    status: "resolved",
    reason: null,
    route: { key: "admin.booking-detail", pathname: "/admin/bookings/[id]", label: "Booking" },
    selection: {},
    record: {
      kind: "booking",
      id: "clx0123456789abcdefgh",
      sensitiveIncluded: false,
      facts: [],
      observedAt: "2026-08-13T00:00:00.000Z",
    },
    omissions: [],
    observedAt: "2026-08-13T00:00:00.000Z",
    audit: {},
  });
  mocks.loadBundle.mockResolvedValue({ ok: false, reason: "missing" });
  mocks.runAnswer.mockResolvedValue({
    ok: true,
    answer: "The deposit is unpaid.",
    truncated: false,
    sources: [],
    summary: OK_SUMMARY,
    roundsUsed: 1,
  });
});

describe("admission (#2378, Q6)", () => {
  it("admits ANY admitted admin — the shell is not a support permission", async () => {
    await POST(request());
    // `permission: false` is the decision: opening the shell grants zero evidence
    // access, and every tool re-checks its own area at invocation.
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: false });
  });

  it("returns the guard's own refusal untouched", async () => {
    const refusal = new Response("nope", { status: 403 });
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: refusal });
    expect(await POST(request())).toBe(refusal);
    expect(mocks.readModuleFlag).not.toHaveBeenCalled();
  });
});

describe("rate limits run BEFORE the body is read (#2378)", () => {
  it("throttles an unparseable body rather than 400-ing it", async () => {
    const limited = new Response("slow down", { status: 429 });
    mocks.applyRateLimit.mockResolvedValue(limited);
    const bad = new Request("https://example.test/api/admin/ai-diagnostics/ask", {
      method: "POST",
      body: "{{{not json",
    });
    expect(await POST(bad)).toBe(limited);
  });
});

describe("the body is strict (#2378)", () => {
  it("rejects an unknown key rather than ignoring it", async () => {
    const response = await POST(request(body({ actingMemberId: "someone-else" })));
    expect(response.status).toBe(400);
    expect(mocks.runAnswer).not.toHaveBeenCalled();
  });

  it("requires BOTH ticks to be stated", async () => {
    const missing = body();
    delete (missing as Record<string, unknown>).allowPeopleSearch;
    expect((await POST(request(missing))).status).toBe(400);
  });

  it("rejects invalid JSON with a 400", async () => {
    const bad = new Request("https://example.test/api/admin/ai-diagnostics/ask", {
      method: "POST",
      body: "{{{",
    });
    expect((await POST(bad)).status).toBe(400);
  });
});

describe("the module gate is indistinguishable from a missing route (#2378)", () => {
  it("answers a disabled module with the frozen 404", async () => {
    mocks.readModuleFlag.mockResolvedValue(false);
    const response = await POST(request());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.runAnswer).not.toHaveBeenCalled();
  });

  it("treats an UNREADABLE module flag as a refusal too (#2803)", async () => {
    // `null` is "we could not check", which is not the same as off — but it is equally
    // not authorisation to spend, so it refuses on the same terms.
    mocks.readModuleFlag.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(404);
    expect(mocks.runAnswer).not.toHaveBeenCalled();
  });
});

describe("the failure states are first-class and structured (#2378)", () => {
  it("reports an unready deployment without naming which gate failed", async () => {
    // The blocker LIST is support-only (Q6, tiered readiness). A coarse reader gets
    // "not ready" plus where to look, never "the database role is missing a GRANT".
    mocks.readiness.mockResolvedValue({
      ready: false,
      moduleEnabled: true,
      keyState: "saved",
      monthlyBudgetCents: 5000,
      databaseState: "grants_missing",
      blockers: ["database_grants_missing"],
    });
    const response = await POST(request());
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ status: "blocked", reason: "not_ready" });
    expect(JSON.stringify(json)).not.toContain("grants_missing");
    expect(json.nextStep).toContain("AI Diagnostics");
  });

  it("separates a missing credential from a general not-ready", async () => {
    mocks.readiness.mockResolvedValue({
      ready: false,
      moduleEnabled: true,
      keyState: "not_configured",
      monthlyBudgetCents: 5000,
      databaseState: "verified",
      blockers: ["key_missing"],
    });
    const json = await (await POST(request())).json();
    expect(json.reason).toBe("not_configured");
  });

  it("refuses when metering is unhealthy, before any spend", async () => {
    mocks.meteringHealthy.mockReturnValue(false);
    const json = await (await POST(request())).json();
    expect(json).toMatchObject({ status: "blocked", reason: "metering_unavailable" });
    expect(mocks.runAnswer).not.toHaveBeenCalled();
  });

  it("passes a loop refusal through with its partial provenance", async () => {
    mocks.runAnswer.mockResolvedValue({
      ok: false,
      reason: "budget_exhausted",
      sources: [
        {
          toolId: "booking_block_state",
          label: "Booking blockers",
          state: "ok",
          stateDescription: "Evidence was retrieved.",
          observedAt: "2026-08-13T00:00:00.000Z",
          rowCount: 2,
          missingAreas: [],
        },
      ],
      summary: OK_SUMMARY,
      roundsUsed: 1,
    });
    const json = await (await POST(request())).json();
    expect(json).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
    // A partial run still explains itself rather than vanishing.
    expect(json.provenance.sources).toHaveLength(1);
  });

  it("fails closed when the fresh matrix cannot be read", async () => {
    // A read failure is not a permission answer. Answering with an empty toolset would
    // look to the operator like "diagnostics found nothing".
    mocks.freshMatrix.mockResolvedValue({ ok: false, failure: "read_failed" });
    const json = await (await POST(request())).json();
    expect(json.status).toBe("blocked");
    expect(mocks.runAnswer).not.toHaveBeenCalled();
  });
});

describe("client values are selectors, never facts (#2378, owner directive 3 Aug)", () => {
  it("derives the route key and record id from the pathname, server-side", async () => {
    await POST(request());
    const selector = mocks.resolveContext.mock.calls[0][0].selector;
    // The client sent a pathname. The SERVER chose the route — and therefore the
    // record KIND, which is the property `page-context/registry.ts` keeps server-side.
    expect(selector.routeKey).toBe("admin.member-detail");
    expect(selector.recordId).toBe("clx0123456789abcdefgh");
    expect(mocks.resolveContext.mock.calls[0][0].actingMemberId).toBe("member-1");
  });

  it("forces includeSensitiveRecord from the operator's own tick", async () => {
    await POST(request(body({ allowRecordPersonalDetails: true })));
    expect(mocks.resolveContext.mock.calls[0][0].selector.includeSensitiveRecord).toBe(
      true,
    );
    // And the SAME boolean seeds the ledger, so the two channels cannot disagree.
    expect(mocks.runAnswer.mock.calls[0][0].consent.recordConsentGranted).toBe(true);
  });

  it("seeds the consent ledger ONLY from a record the server itself resolved", async () => {
    mocks.resolveContext.mockResolvedValue({
      schemaVersion: 1,
      status: "denied",
      reason: "permission_denied",
      route: null,
      selection: {},
      record: null,
      omissions: [],
      observedAt: "2026-08-13T00:00:00.000Z",
      audit: {},
    });
    await POST(request());
    // A denied resolution seeds nothing: the ticks then apply to an empty
    // investigation and every per-record entry refuses, which is what should happen
    // when the server could not establish what the operator is looking at.
    expect(mocks.runAnswer.mock.calls[0][0].consent.size).toBe(0);
  });

  it("accepts a registered recordId on a LIST route, where the URL names none", async () => {
    // The flagship flow: bookings have no detail page, so the operator asks from the
    // list with a booking open. The id is a selector; the KIND still comes from the
    // route the server matched.
    await POST(
      request(
        body({
          pathname: "/admin/bookings",
          recordId: "clx0123456789abcdefgh",
        }),
      ),
    );
    const selector = mocks.resolveContext.mock.calls[0][0].selector;
    expect(selector.routeKey).toBe("admin.bookings");
    expect(selector.recordId).toBe("clx0123456789abcdefgh");
  });

  it("ignores a registered recordId on a route that can hold no record", async () => {
    // A static page cannot be about a record, so a stale registration from a list the
    // operator was on before must not select one here.
    await POST(
      request(body({ pathname: "/admin/health", recordId: "clx0123456789abcdefgh" })),
    );
    expect(mocks.resolveContext.mock.calls[0][0].selector.recordId).toBeUndefined();
  });

  it("lets the URL's own record win over a registered one", async () => {
    await POST(
      request(
        body({
          pathname: "/admin/members/clxurlurlurlurlurlurl",
          recordId: "clxregisteredregistered",
        }),
      ),
    );
    expect(mocks.resolveContext.mock.calls[0][0].selector.recordId).toBe(
      "clxurlurlurlurlurlurl",
    );
  });

  it("passes both ticks through to the ledger exactly as sent", async () => {
    await POST(request(body({ allowPeopleSearch: true })));
    const consent = mocks.runAnswer.mock.calls[0][0].consent;
    expect(consent.peopleSearchGranted).toBe(true);
    expect(consent.recordConsentGranted).toBe(false);
  });
});

describe("deployed-code evidence degrades rather than refusing (#2378)", () => {
  it("answers without a knowledge bundle", async () => {
    mocks.loadBundle.mockResolvedValue({ ok: false, reason: "missing" });
    const json = await (await POST(request())).json();
    expect(json.status).toBe("answered");
    expect(mocks.runAnswer.mock.calls[0][0].sourceBlock).toBeUndefined();
  });
});

describe("a good answer carries its provenance (#2378, D10)", () => {
  it("returns the answer and a server-composed provenance line", async () => {
    const json = await (await POST(request())).json();
    expect(json).toMatchObject({
      status: "answered",
      answer: "The deposit is unpaid.",
      truncated: false,
    });
    expect(typeof json.provenance.line).toBe("string");
    expect(json.provenance.line.length).toBeGreaterThan(0);
  });
});
