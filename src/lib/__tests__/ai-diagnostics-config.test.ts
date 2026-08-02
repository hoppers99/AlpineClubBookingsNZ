import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credFindUnique: vi.fn(),
  settingsFindUnique: vi.fn(),
  getIntegrationCredentialValue: vi.fn(),
  providerNeedsReentry: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findUnique: mocks.credFindUnique },
    diagnosticsSettings: { findUnique: mocks.settingsFindUnique },
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
} from "@/lib/ai-diagnostics-config";
import { ANTHROPIC_PROVIDER } from "@/lib/ai-assistant-config";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.credFindUnique.mockResolvedValue({ updatedAt: new Date("2026-08-02T00:00:00Z") });
  mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
  mocks.getIntegrationCredentialValue.mockResolvedValue("sk-ant-diag-xxx");
  mocks.providerNeedsReentry.mockResolvedValue(false);
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
  it("is READY only when module on + key saved + positive budget", async () => {
    const r = await getDiagnosticsReadiness({ aiDiagnostics: true });
    expect(r).toMatchObject({
      ready: true,
      moduleEnabled: true,
      keyState: "saved",
      monthlyBudgetCents: 1000,
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
  });
});
