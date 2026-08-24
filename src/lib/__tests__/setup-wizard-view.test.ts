import { describe, expect, it } from "vitest";
import { MODULE_KEYS, type ModuleSettingsValues } from "@/config/modules";
import {
  ADMIN_PERMISSION_AREAS,
  emptyAdminPermissionMatrix,
  getAdminRouteRequirement,
} from "@/lib/admin-permissions";
import { buildSetupReadiness, normalizeSetupProgress } from "@/lib/setup-readiness";
import { SETUP_STEP_IDS, type SetupStepId } from "@/lib/setup-step-registry";
import { buildSetupWizardTraversal } from "@/lib/setup-wizard-traversal";
import {
  SETUP_STEP_PERMISSION_AREA,
  buildSetupWizardView,
  canChangeSetupProgress,
  resolveInitialStepId,
  setupWizardNeighbours,
  type SetupWizardView,
} from "@/lib/setup-wizard-view";

/**
 * The wizard's view model (epic #213, C5).
 *
 * Built over the REAL readiness builder and the REAL traversal rather than over
 * stubs of both: the whole job of this module is that those two agree, and two
 * hand-written fixtures would agree with each other no matter what the
 * production pair did.
 */

const allModulesOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as ModuleSettingsValues;

function viewFor(
  progress: { completedStepIds?: string[]; skippedStepIds?: string[] } = {},
  moduleSettings?: Parameters<typeof buildSetupWizardTraversal>[0]["moduleSettings"],
): SetupWizardView {
  const normalised = normalizeSetupProgress({
    completedStepIds: progress.completedStepIds ?? [],
    skippedStepIds: progress.skippedStepIds ?? [],
    completedAt: null,
    completedByMemberId: null,
  });
  const readiness = buildSetupReadiness({ progress: normalised });
  const readinessStatuses: Partial<
    Record<SetupStepId, (typeof readiness.categories)[number]["checks"][number]["status"]>
  > = {};
  for (const category of readiness.categories) {
    for (const check of category.checks) readinessStatuses[check.id] = check.status;
  }
  const traversal = buildSetupWizardTraversal({
    progress: normalised,
    moduleSettings,
    readinessStatuses,
  });
  return buildSetupWizardView(readiness, traversal);
}

describe("SETUP_STEP_PERMISSION_AREA (D12)", () => {
  it("names a real permission area for every registered step", () => {
    const areas = new Set(ADMIN_PERMISSION_AREAS.map((area) => area.key));
    for (const id of SETUP_STEP_IDS) {
      expect(
        areas.has(SETUP_STEP_PERMISSION_AREA[id]),
        `step "${id}" maps to an area that does not exist`,
      ).toBe(true);
    }
    // The map is a Record over the id union, so a step with no entry is a
    // TYPECHECK failure rather than a runtime one; this pins that the two sets
    // are the same size, which is what a stray extra key would break.
    expect(Object.keys(SETUP_STEP_PERMISSION_AREA).sort()).toEqual(
      [...SETUP_STEP_IDS].sort(),
    );
  });

  it("keeps the two counter-intuitive mappings the rule produces", () => {
    // Both follow from "the area that governs the page the work is done on",
    // and both read wrongly if you go by the step's subject matter instead.
    expect(SETUP_STEP_PERMISSION_AREA["seed-admin"]).toBe("membership");
    expect(SETUP_STEP_PERMISSION_AREA["membership-cancellation"]).toBe("support");
  });
});

describe("buildSetupWizardView", () => {
  it("carries the traversal's percentage through untouched (D7)", () => {
    const readiness = buildSetupReadiness({});
    const traversal = buildSetupWizardTraversal({
      progress: { completedStepIds: [], skippedStepIds: [] },
    });
    const view = buildSetupWizardView(readiness, traversal);
    expect(view.percentComplete).toBe(traversal.percentComplete);
    expect(view.allResolved).toBe(traversal.allResolved);
    expect(view.currentStepId).toBe(traversal.currentStepId);
  });

  it("groups every applicable step under a readiness category, once", () => {
    const view = viewFor();
    const grouped = view.groups.flatMap((group) => group.steps.map((s) => s.id));
    expect(grouped.sort()).toEqual(view.steps.map((s) => s.id).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const group of view.groups) {
      expect(group.steps.length).toBeGreaterThan(0);
    }
  });

  it("keeps journey order within a group, and the readiness order across groups", () => {
    const view = viewFor();
    const journey = view.steps.map((step) => step.id);
    for (const group of view.groups) {
      const positions = group.steps.map((step) => journey.indexOf(step.id));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
    expect(view.groups[0].title).toBe("Foundation");
  });

  it("drops a disabled module's steps from the rail entirely (D4)", () => {
    // xeroIntegration off: its two steps must not appear as rows, as a group,
    // or in the outstanding list. A declined module leaves no trace.
    const off = viewFor({}, { ...allModulesOn, xeroIntegration: false });
    const ids = off.steps.map((step) => step.id);
    expect(ids).not.toContain("xero-operational");
    expect(ids).not.toContain("xero-mappings");
    expect(off.outstanding.map((item) => item.id)).not.toContain("xero-mappings");
  });

  it("states a deferred step as outstanding, and says it was skipped", () => {
    const view = viewFor({ skippedStepIds: ["sentry"] });
    const entry = view.outstanding.find((item) => item.id === "sentry");
    expect(entry).toBeDefined();
    expect(entry?.deferred).toBe(true);
  });

  it("titles a step from its readiness check", () => {
    const view = viewFor();
    const clubConfig = view.steps.find((step) => step.id === "club-config");
    expect(clubConfig?.title).not.toBe("club-config");
    expect(clubConfig?.categoryTitle).toBe("Foundation");
  });
});

describe("navigation helpers", () => {
  it("walks the flat journey order, not the grouped one", () => {
    const view = viewFor();
    const second = view.steps[1];
    const neighbours = setupWizardNeighbours(view, second.id);
    expect(neighbours.previous?.id).toBe(view.steps[0].id);
    expect(neighbours.next?.id).toBe(view.steps[2].id);
  });

  it("returns an unreachable next step rather than null", () => {
    // The caller disables Continue on `next.isReachable === false`; returning
    // null would make "blocked" and "end of journey" indistinguishable, and the
    // end of the journey is where D9's launch panel lives.
    const view = viewFor();
    const frontierIndex = view.steps.findIndex(
      (step) => step.id === view.navigationFrontierStepId,
    );
    const beyond = view.steps[frontierIndex + 1];
    if (!beyond) return; // every step reachable: nothing to assert here
    expect(beyond.isReachable).toBe(false);
    expect(setupWizardNeighbours(view, view.steps[frontierIndex].id).next?.id).toBe(
      beyond.id,
    );
  });

  it("resolves an unreachable or unknown requested step back to the current one", () => {
    const view = viewFor();
    expect(resolveInitialStepId(view, "not-a-step")).toBe(view.currentStepId);
    const unreachable = view.steps.find((step) => !step.isReachable);
    if (unreachable) {
      expect(resolveInitialStepId(view, unreachable.id)).toBe(view.currentStepId);
    }
  });
});

describe("canChangeSetupProgress (D12)", () => {
  // The gate has to agree with the SERVER, which enforces
  // PATCH /api/admin/setup/progress at support:edit for every step. Gating on
  // the step's own area was wrong in both directions on shipped role bundles,
  // and both directions are asserted here.
  it("asks for support edit, whatever area the step's settings page belongs to", () => {
    const view = viewFor();
    const bookingStep = view.steps.find((step) => step.permissionArea === "bookings");
    expect(bookingStep).toBeDefined();

    // Direction 1 — the false ENABLE: a bookings officer with only support view
    // would have been handed a button whose PATCH answers 403.
    const bookingsEditor = {
      ...emptyAdminPermissionMatrix(),
      bookings: "edit" as const,
      support: "view" as const,
    };
    expect(canChangeSetupProgress(bookingsEditor)).toBe(false);

    // Direction 2 — the false DISABLE: a support officer may change progress on
    // every step, including one whose settings page is another area's.
    const supportEditor = { ...emptyAdminPermissionMatrix(), support: "edit" as const };
    expect(canChangeSetupProgress(supportEditor)).toBe(true);

    const supportViewer = { ...emptyAdminPermissionMatrix(), support: "view" as const };
    expect(canChangeSetupProgress(supportViewer)).toBe(false);
    expect(canChangeSetupProgress(emptyAdminPermissionMatrix())).toBe(false);
  });

  it("matches the area the route resolver really enforces for the progress API", () => {
    // Not a restatement of the line above: this reads the answer out of the
    // REAL resolver, so a later prefix edit that moves /api/admin/setup off
    // `support` fails here rather than silently re-opening the gap.
    const requirement = getAdminRouteRequirement(
      "/api/admin/setup/progress",
      "PATCH",
    );
    expect(requirement?.area).toBe("support");
    expect(requirement?.level).toBe("edit");
  });
});
