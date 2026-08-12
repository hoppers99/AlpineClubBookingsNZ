/**
 * Tiered readiness (AID-7, #2378, owner decision Q6) — the contract tests.
 *
 * The property that matters is not "the coarse view renders fewer fields". It is
 * that the detailed fields are never BUILT for a caller without `support:view`, so
 * they cannot reach the browser however the markup is written. These tests assert
 * absence on the object, which is the only place absence is real.
 */
import { describe, expect, it } from "vitest";

import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import type { DiagnosticsReadiness } from "@/lib/ai-diagnostics-config";
import { readinessForAdmin } from "@/lib/diagnostics-readiness-tiers";

function matrixWith(support: AdminPermissionLevel): AdminPermissionMatrix {
  return Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [
      area.key,
      area.key === "support" ? support : "view",
    ]),
  ) as AdminPermissionMatrix;
}

const NOT_READY: DiagnosticsReadiness = {
  ready: false,
  moduleEnabled: true,
  keyState: "missing" as DiagnosticsReadiness["keyState"],
  monthlyBudgetCents: 0,
  databaseState: "unverified" as DiagnosticsReadiness["databaseState"],
  blockers: ["no_key", "no_budget"] as unknown as DiagnosticsReadiness["blockers"],
};

describe("readiness is tiered on the server, not in the markup (#2378 Q6)", () => {
  it("gives a support-capable admin the whole verdict, unchanged", () => {
    const tiered = readinessForAdmin(NOT_READY, matrixWith("view"));

    expect(tiered.tier).toBe("detailed");
    if (tiered.tier !== "detailed") return;
    // Unchanged, not re-derived: a tier that recomputed readiness could disagree
    // with the verdict the server actually reached.
    expect(tiered.ready).toBe(NOT_READY.ready);
    expect(tiered.keyState).toBe(NOT_READY.keyState);
    expect(tiered.databaseState).toBe(NOT_READY.databaseState);
    expect(tiered.blockers).toEqual(NOT_READY.blockers);
  });

  it("gives an admin without support access NO operational detail at all", () => {
    const tiered = readinessForAdmin(NOT_READY, matrixWith("none"));

    expect(tiered.tier).toBe("coarse");
    // The point of the whole module: these are ABSENT from the object, not hidden
    // by a component. A field present here would reach the browser whatever the
    // markup did with it.
    expect("keyState" in tiered).toBe(false);
    expect("databaseState" in tiered).toBe(false);
    expect("monthlyBudgetCents" in tiered).toBe(false);
    expect("blockers" in tiered).toBe(false);
    // And nothing leaks through serialisation either — the check a reviewer
    // actually cares about, since this object is what crosses to the client.
    const serialised = JSON.stringify(tiered);
    expect(serialised).not.toContain("unverified");
    expect(serialised).not.toContain("no_key");
  });

  it("still tells a coarse reader the two things they can act on", () => {
    const tiered = readinessForAdmin(NOT_READY, matrixWith("none"));
    if (tiered.tier !== "coarse") throw new Error("expected the coarse tier");

    expect(tiered.ready).toBe(false);
    expect(tiered.moduleEnabled).toBe(true);
    // Not a blocker list — the question they actually have.
    expect(tiered.whoCanResolve).toMatch(/support access/i);
  });

  it("points a coarse reader at the module switch when that is the blocker", () => {
    const tiered = readinessForAdmin(
      { ...NOT_READY, moduleEnabled: false },
      matrixWith("none"),
    );
    if (tiered.tier !== "coarse") throw new Error("expected the coarse tier");

    // Saying "ask someone with support access" to a person who only needed to flip
    // a switch is wrong in the annoying direction.
    expect(tiered.whoCanResolve).toMatch(/Feature modules/i);
    expect(tiered.whoCanResolve).not.toMatch(/support access/i);
  });

  it("treats support:edit as implying support:view", () => {
    expect(readinessForAdmin(NOT_READY, matrixWith("edit")).tier).toBe(
      "detailed",
    );
  });

  it("can never widen a not-ready verdict into a ready one", () => {
    // The coarse tier only ever NARROWS. There is no path that invents readiness
    // the server did not establish — `ready` is fail-closed upstream and this
    // module must not be the place that undoes that.
    for (const level of ["none", "view", "edit"] as const) {
      expect(readinessForAdmin(NOT_READY, matrixWith(level)).ready).toBe(false);
      expect(
        readinessForAdmin({ ...NOT_READY, ready: true }, matrixWith(level)).ready,
      ).toBe(true);
    }
  });
});
