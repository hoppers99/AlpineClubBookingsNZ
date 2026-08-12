// @vitest-environment jsdom

/**
 * THE MODULE FLAG IS TRI-STATE ON THIS PAGE, AND `null` IS NOT "OFF" (#2803).
 *
 * This file exists because both bugs it pins actually shipped into this branch, and
 * both were invisible for the same reason: **`false` is unreachable here**.
 * `/admin/ai-diagnostics` is gated by the `aiDiagnostics` feature-route rule, so with
 * the module genuinely off the page 404s and never renders. Every falsy value that
 * reaches this markup is therefore `null` — "the club's module settings could not be
 * read".
 *
 * Which means a `!moduleEnabled` test or a two-armed ternary does not merely RISK
 * being wrong. It is wrong every single time it fires:
 *
 *   1. `{!readiness.moduleEnabled && <Link href="/admin/modules">}` offered "Open
 *      Feature modules" — sending an administrator to switch on a module that may
 *      already be on, while the real fault went unmentioned.
 *   2. `{readiness.moduleEnabled ? "On" : "Off"}` reported the module as **Off** on
 *      the strength of a failed read.
 *
 * The readiness contract states the rule in as many words — "a consumer must render
 * `null` as 'unknown', never as 'off': the two send an operator to different places"
 * — and nothing was checking that any consumer obeyed it. Now something is.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { DiagnosticsReadiness } from "@/lib/ai-diagnostics-config";

const mocks = vi.hoisted(() => ({
  readiness: null as DiagnosticsReadiness | null,
}));

vi.mock("@/lib/admin-layout-guard", () => ({
  guardAdminLayout: async () => ({
    outcome: "admitted" as const,
    // Full support access, so the DETAILED tier renders — the tier that carries the
    // Module row at all.
    permissionMatrix: {
      overview: "edit",
      bookings: "edit",
      membership: "edit",
      finance: "edit",
      lodge: "edit",
      support: "edit",
      settings: "edit",
    } as unknown as AdminPermissionMatrix,
  }),
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: async () => ({ aiDiagnostics: true }),
}));

vi.mock("@/lib/ai-diagnostics-config", () => ({
  getDiagnosticsReadiness: async () => mocks.readiness,
}));

// The budget card fetches on mount and is covered by its own suite; this file is
// about the readiness section's treatment of the flag.
vi.mock("../_components/diagnostics-budget-card", () => ({
  DiagnosticsBudgetCard: () => null,
}));

import DiagnosticsPage from "../page";

function readiness(
  moduleEnabled: DiagnosticsReadiness["moduleEnabled"],
): DiagnosticsReadiness {
  return {
    ready: false,
    moduleEnabled,
    keyState: "not_configured",
    monthlyBudgetCents: 0,
    databaseState: "not_configured",
    blockers: [
      moduleEnabled === null ? "module_flags_unreadable" : "module_off",
    ] as DiagnosticsReadiness["blockers"],
  };
}

async function renderPage(
  moduleEnabled: DiagnosticsReadiness["moduleEnabled"],
) {
  mocks.readiness = readiness(moduleEnabled);
  render(await DiagnosticsPage());
}

describe("an unreadable module flag (#2803)", () => {
  it("is never reported as Off", async () => {
    await renderPage(null);
    expect(screen.getByText("Could not be read")).toBeTruthy();
    expect(screen.queryByText("Off")).toBeNull();
  });

  it("does not send the operator to switch on a module", async () => {
    await renderPage(null);
    // The old markup's exact offer. It was wrong 100% of the times it appeared.
    expect(screen.queryByText("Open Feature modules")).toBeNull();
    expect(
      screen.getByText(/could not be established/).textContent,
    ).toContain("switching it on will not help");
  });
});

describe("a module that really is on", () => {
  it("says so, with no unknown-state notice", async () => {
    await renderPage(true);
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.queryByText(/could not be established/)).toBeNull();
    expect(screen.queryByText("Could not be read")).toBeNull();
  });
});

describe("a module that really is off", () => {
  /**
   * THIS CASE CANNOT HAPPEN IN PRODUCTION, and is here precisely for that reason.
   *
   * The feature-route rule 404s the page when the module is off, so `false` never
   * reaches this markup — which is what made both shipped bugs invisible. Rendering
   * the component directly is the only place the distinction can be observed at all,
   * and without this case the notice's condition is untested: swapping `=== null`
   * back to `!` still renders the corrected copy, just under a looser test, and
   * every other assertion here passes.
   *
   * So this is the one that holds the CONDITION rather than the wording, and it is
   * mutation-verified against exactly that swap.
   */
  it("says Off, and does NOT claim the state could not be established", async () => {
    await renderPage(false);
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.queryByText(/could not be established/)).toBeNull();
    expect(screen.queryByText("Could not be read")).toBeNull();
  });
});
