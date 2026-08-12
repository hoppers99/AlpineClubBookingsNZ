import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credFindUnique: vi.fn(),
  settingsFindUnique: vi.fn(),
  moduleSettingsFindUnique: vi.fn(),
  getIntegrationCredentialValue: vi.fn(),
  providerNeedsReentry: vi.fn(),
  checkDiagnosticsDatabaseReadiness: vi.fn(),
}));

// AID-5 (#2374): the readiness aggregate now VERIFIES the dedicated SELECT-only
// role. Mocked here because the real function opens a `pg` pool; the real thing is
// proven against an actual PostgreSQL in
// `ai-diagnostics-select-only-role.realdb.test.ts`.
vi.mock("@/lib/diagnostics/tools/database", () => ({
  checkDiagnosticsDatabaseReadiness: mocks.checkDiagnosticsDatabaseReadiness,
}));

// The module-flags read is DELIBERATELY not mocked at the loader level (#2803): the
// point of the fix is which loader readiness calls and where the catch sits, and a
// doubled loader would prove neither. `clubModuleSettings` is the real query
// `loadEffectiveModuleFlagsStrict` issues, so failing only THIS one is a genuinely
// narrow failure — every other read below still succeeds.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findUnique: mocks.credFindUnique },
    diagnosticsSettings: { findUnique: mocks.settingsFindUnique },
    clubModuleSettings: { findUnique: mocks.moduleSettingsFindUnique },
  },
}));

vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mocks.getIntegrationCredentialValue,
  providerNeedsReentry: mocks.providerNeedsReentry,
}));

import {
  DIAGNOSTICS_CREDENTIAL_KEYS,
  DIAGNOSTICS_PROVIDER,
  getDiagnosticsReadiness,
  getOperationalDiagnosticsApiKey,
  readDiagnosticsModuleFlag,
} from "@/lib/ai-diagnostics-config";
import {
  DIAGNOSTICS_BLOCKER_CODES,
  DIAGNOSTICS_BLOCKER_DESCRIPTIONS,
} from "@/lib/ai-diagnostics-blockers";
import { ANTHROPIC_PROVIDER } from "@/lib/ai-assistant-config";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.credFindUnique.mockResolvedValue({ updatedAt: new Date("2026-08-02T00:00:00Z") });
  mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
  mocks.moduleSettingsFindUnique.mockResolvedValue({ aiDiagnostics: true });
  mocks.getIntegrationCredentialValue.mockResolvedValue("sk-ant-diag-xxx");
  mocks.providerNeedsReentry.mockResolvedValue(false);
  mocks.checkDiagnosticsDatabaseReadiness.mockResolvedValue({
    state: "verified",
    roleName: "ai_diagnostics_ro",
  });
});

describe("dedicated credential — NO sharing with page-help", () => {
  it("uses a DISTINCT provider namespace from the page-help Anthropic key", () => {
    expect(DIAGNOSTICS_PROVIDER).toBe("anthropic-diagnostics");
    expect(DIAGNOSTICS_PROVIDER).not.toBe(ANTHROPIC_PROVIDER);
  });

  it("resolves the operational key from the DEDICATED provider only", async () => {
    await getOperationalDiagnosticsApiKey();
    expect(mocks.getIntegrationCredentialValue).toHaveBeenCalledWith(
      DIAGNOSTICS_PROVIDER,
      DIAGNOSTICS_CREDENTIAL_KEYS.apiKey,
    );
    // It must NEVER fall back to the page-help "anthropic" provider.
    expect(mocks.getIntegrationCredentialValue).not.toHaveBeenCalledWith(
      ANTHROPIC_PROVIDER,
      expect.anything(),
    );
  });

  it("returns undefined (never a page-help key) when the dedicated key is absent", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    expect(await getOperationalDiagnosticsApiKey()).toBeUndefined();
  });
});

describe("getDiagnosticsReadiness — fail-closed gate", () => {
  it("is READY only when module on + key saved + positive budget + VERIFIED SELECT-only role", async () => {
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r).toMatchObject({
      ready: true,
      moduleEnabled: true,
      keyState: "saved",
      monthlyBudgetCents: 1000,
      databaseState: "verified",
      blockers: [],
    });
  });

  it("is NOT ready while the module is off (even with key + budget)", async () => {
    const r = await getDiagnosticsReadiness({ aiDiagnostics: false });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("module_off");
  });

  it("is NOT ready when the dedicated key is not configured", async () => {
    mocks.credFindUnique.mockResolvedValue(null);
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.keyState).toBe("not_configured");
    expect(r.blockers).toContain("credential_not_configured");
  });

  it("is NOT ready when the dedicated key needs re-entry (auth secret rotated)", async () => {
    mocks.providerNeedsReentry.mockResolvedValue(true);
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.keyState).toBe("needs_reentry");
    expect(r.blockers).toContain("credential_needs_reentry");
  });

  it("is NOT ready when the budget is zero (ship default, hard-off)", async () => {
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 0 });
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("budget_not_set");
  });

  it("is NOT ready (no throw) on a DB fault — fail closed with resolve_error", async () => {
    mocks.settingsFindUnique.mockRejectedValue(new Error("db down"));
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual(["resolve_error"]);
    // Even the catch-all reports an UNVERIFIED role — never a verified one.
    expect(r.databaseState).toBe("unverified");
  });

  // AID-5 (#2374): the dedicated SELECT-only role is mandatory (ADR-007), and
  // readiness must VERIFY it rather than trust that the env var is set. Every
  // non-verified state blocks, and the state is reported distinctly so an operator
  // knows whether to provision, repair or fix connectivity.
  it("is NOT ready when the SELECT-only role is not configured at all", async () => {
    mocks.checkDiagnosticsDatabaseReadiness.mockResolvedValue({
      state: "not_configured",
      roleName: null,
    });
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.databaseState).toBe("not_configured");
    expect(r.blockers).toContain("database_not_configured");
    // The absent-role case is NOT reported as an unsafe role: different fix.
    expect(r.blockers).not.toContain("database_role_unsafe");
  });

  it.each([
    ["misconfigured", "malformed URL, no role, or the application's own role"],
    ["unverified", "the server could not be asked, so the role is not trusted"],
    ["over_privileged", "the server says the role is not SELECT-only"],
  ])("is NOT ready when the SELECT-only role is %s (%s)", async (state) => {
    mocks.checkDiagnosticsDatabaseReadiness.mockResolvedValue({
      state,
      roleName: null,
    });
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.databaseState).toBe(state);
    expect(r.blockers).toContain("database_role_unsafe");
  });

  it("reports a missing-grants blocker for an under-provisioned role", async () => {
    mocks.checkDiagnosticsDatabaseReadiness.mockResolvedValue({
      state: "under_provisioned",
      roleName: null,
    });
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("database_grants_missing");
    expect(r.blockers).not.toContain("database_role_unsafe");
  });

  it("reports UNKNOWN, not off, when the module flags cannot be read (#2803)", async () => {
    // THE NARROW FAILURE, and it is narrow on purpose: only the module-settings
    // query fails. P2022 is the realistic trigger — a blue/green window where the
    // deployed client selects a ClubModuleSettings column the migration has not
    // added yet — and every other read below still succeeds, so nothing else on the
    // row marks a fault. Before #2803 this produced module_enabled:false +
    // module_off, and an operator was sent to switch on a module already on.
    mocks.moduleSettingsFindUnique.mockRejectedValue(
      new Error("P2022 column ClubModuleSettings.aiDiagnostics does not exist"),
    );

    const r = await getDiagnosticsReadiness({
      aiDiagnostics: await readDiagnosticsModuleFlag(),
    });

    expect(r.ready).toBe(false);
    expect(r.moduleEnabled).toBeNull();
    expect(r.blockers).toContain("module_flags_unreadable");
    // The distinction IS the fix: claiming the club switched it off is the defect.
    expect(r.blockers).not.toContain("module_off");
    // And the failure is narrow rather than an outage — everything else answered,
    // which is exactly the case the old row could not be told apart from.
    expect(r.keyState).toBe("saved");
    expect(r.databaseState).toBe("verified");
    expect(r.monthlyBudgetCents).toBe(1000);
    expect(r.blockers).not.toContain("resolve_error");
  });

  it("still reports module_off, and NOTHING else, for a genuinely disabled module", async () => {
    mocks.moduleSettingsFindUnique.mockResolvedValue({ aiDiagnostics: false });

    const r = await getDiagnosticsReadiness({
      aiDiagnostics: await readDiagnosticsModuleFlag(),
    });

    expect(r.ready).toBe(false);
    expect(r.moduleEnabled).toBe(false);
    // Exactly one blocker: a real setting is a real setting, and the unreadable
    // code must never be raised beside it.
    expect(r.blockers).toEqual(["module_off"]);
  });

  it("reads the flag through the STRICT loader and reports its real answer", async () => {
    mocks.moduleSettingsFindUnique.mockResolvedValue({ aiDiagnostics: true });
    expect(await readDiagnosticsModuleFlag()).toBe(true);

    // A club that never saved the Modules panel has no row at all. That is an
    // OBSERVATION with a documented default, not a failure, so it is `false` and
    // not `null` — the strict loader normalises it rather than throwing.
    mocks.moduleSettingsFindUnique.mockResolvedValue(null);
    expect(await readDiagnosticsModuleFlag()).toBe(false);

    mocks.moduleSettingsFindUnique.mockRejectedValue(new Error("timeout"));
    expect(await readDiagnosticsModuleFlag()).toBeNull();
  });

  it("STAYS ANSWERABLE when the application database is unreachable", async () => {
    // The constraint the fault-tolerance exists for, and the one #2803 must not
    // break: every read fails, and readiness still RETURNS a verdict rather than
    // throwing or refusing. Unknown module state, resolve_error, no exception.
    const outage = new Error("could not connect to server");
    mocks.moduleSettingsFindUnique.mockRejectedValue(outage);
    mocks.credFindUnique.mockRejectedValue(outage);
    mocks.settingsFindUnique.mockRejectedValue(outage);
    mocks.checkDiagnosticsDatabaseReadiness.mockRejectedValue(outage);

    const r = await getDiagnosticsReadiness({
      aiDiagnostics: await readDiagnosticsModuleFlag(),
    });

    expect(r.ready).toBe(false);
    expect(r.moduleEnabled).toBeNull();
    expect(r.blockers).toEqual(["resolve_error"]);
    expect(r.databaseState).toBe("unverified");
  });

  it("never reports a role name on the readiness response (metadata only)", async () => {
    // The role name is deployment configuration, but a readiness response is JSON
    // an admin browser receives — nothing about the credential belongs in it
    // beyond the state. This pins that the aggregate drops the name.
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(JSON.stringify(r)).not.toContain("ai_diagnostics_ro");
    expect(Object.keys(r)).not.toContain("roleName");
  });
});

describe("the readiness blocker catalogue is closed and complete (#2803)", () => {
  it("gives every code a real sentence, and no duplicates", () => {
    expect(new Set(DIAGNOSTICS_BLOCKER_CODES).size).toBe(
      DIAGNOSTICS_BLOCKER_CODES.length,
    );
    for (const code of DIAGNOSTICS_BLOCKER_CODES) {
      const description = DIAGNOSTICS_BLOCKER_DESCRIPTIONS[code];
      // A code with no sentence is a token the model paraphrases, and the
      // paraphrase is where a wrong operator instruction comes from.
      expect(description?.trim().length, code).toBeGreaterThan(40);
      expect(description, code).not.toContain(code);
    }
    // `none` is the ABSENCE of a blocker and must never be a code, or a caller can
    // treat the healthy case as a finding.
    expect(DIAGNOSTICS_BLOCKER_CODES).not.toContain("none");
  });

  it("says in as many words that unreadable is not off", () => {
    // The one sentence this whole change exists for. If it ever softens, the model
    // is free to render the unknown state as "the module is off" again.
    const unreadable = DIAGNOSTICS_BLOCKER_DESCRIPTIONS.module_flags_unreadable;
    expect(unreadable).toMatch(/not evidence that the module is off/i);
    expect(unreadable).toMatch(/unknown/i);
    expect(DIAGNOSTICS_BLOCKER_DESCRIPTIONS.module_off).toMatch(
      /switched OFF/i,
    );
  });

  it("emits blockers in declared catalogue order", async () => {
    // Several can be true at once, and the first is reported as the primary
    // problem — so the emission order has to BE the declared priority order.
    mocks.moduleSettingsFindUnique.mockResolvedValue({ aiDiagnostics: false });
    mocks.credFindUnique.mockResolvedValue(null);
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 0 });
    mocks.checkDiagnosticsDatabaseReadiness.mockResolvedValue({
      state: "not_configured",
      roleName: null,
    });

    const r = await getDiagnosticsReadiness({
      aiDiagnostics: await readDiagnosticsModuleFlag(),
    });

    expect(r.blockers).toEqual([
      "module_off",
      "credential_not_configured",
      "budget_not_set",
      "database_not_configured",
    ]);
    const declared = r.blockers.map((code) =>
      DIAGNOSTICS_BLOCKER_CODES.indexOf(code),
    );
    expect(declared).toEqual([...declared].sort((a, b) => a - b));
    expect(declared).not.toContain(-1);
  });
});
