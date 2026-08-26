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
  // `env: {}`, not the ambient default — matching every other readiness call
  // site in the test tree (`setup-readiness.test.ts`'s `baseEnv` fixture,
  // `setup-step-registry.test.ts` and `setup-surface-registry-parity.test.ts`'s
  // `env: {}`). Without it `buildSetupReadiness` falls through to the REAL
  // `process.env`, and this suite's "however many checks pass" claim then rides
  // whatever the runner happens to export. Measured divergence: an unset
  // AUTH_SECRET/NEXTAUTH_SECRET reads `auth-secret-strength` as "complete" (the
  // check's own no-duplicate-finding rule — see setup-readiness.ts), while CI's
  // `verify` job sets `AUTH_SECRET: ci-auth-secret`, which is real but under the
  // 32-character strength floor, reading "warning" instead. That was the ONLY
  // check complete on a bare fixture, so the CI env collapsed the "opens a
  // fresh install … however many checks pass" fixture's defaulted population to
  // zero — passing locally, failing on every CI run (PR #241).
  const readiness = buildSetupReadiness({ progress: normalised, env: {} });
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

/**
 * A view with a HAND-CHOSEN reachability pattern, for the pure navigation
 * helpers only.
 *
 * The real-builders rule above is about the marriage of readiness and traversal,
 * and `setupWizardNeighbours` is not part of it — it is a pure walk over
 * `view.steps`. The pattern that matters (a LOCKED step sitting in front of a
 * reachable one) is a state the real traversal genuinely produces, because a
 * stale step re-caps the frontier under steps that are complete and therefore
 * still reachable on their own account (#219 F2) — but reproducing it through
 * the builders would take a fixture whose staleness is incidental to what is
 * being asserted here.
 */
function stubView(
  steps: { id: string; isReachable: boolean }[],
): SetupWizardView {
  const details = steps.map((step) => ({
    id: step.id as SetupStepId,
    title: step.id,
    state: "not-started" as const,
    isReachable: step.isReachable,
    isStale: false,
    isDeferred: false,
    isDefaulted: false,
    permissionArea: "support" as const,
    categoryId: "foundation",
    categoryTitle: "Foundation",
    description: "",
    message: "",
    details: [] as string[],
    links: [] as { label: string; href: string }[],
    required: false,
    progress: "open" as const,
    status: "not_started" as const,
  }));
  return {
    groups: [],
    steps: details,
    percentComplete: 0,
    currentStepId: details[0]?.id ?? null,
    navigationFrontierStepId: details[0]?.id ?? null,
    allResolved: false,
    outstanding: [],
  };
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
    const readiness = buildSetupReadiness({ env: {} });
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

  /*
    D14/D15 (#237), over the REAL readiness builder and the REAL traversal — the
    end-to-end form of the claim rather than a synthetic registry's version of
    it. This is the state the UAT walkthrough found and reported: an install
    where several checks pass on their own and nobody has confirmed anything.
  */
  it("opens a fresh install at the first step, at 0%, however many checks pass", () => {
    const view = viewFor();

    // The fixture must actually hold defaulted steps, or the assertions below
    // would pass vacuously on a readiness result where nothing passed at all.
    expect(view.steps.filter((step) => step.isDefaulted).length).toBeGreaterThan(
      0,
    );

    expect(view.percentComplete).toBe(0);
    expect(view.currentStepId).toBe(view.steps[0].id);
    // …and the launch panel stays locked, which is D15's deliberate cost: a club
    // cannot arrive at "ready to open" having agreed to nothing.
    expect(view.allResolved).toBe(false);
  });

  it("carries the defaulted flag through to the rail row", () => {
    const view = viewFor();
    const defaulted = view.steps.find((step) => step.isDefaulted);
    expect(defaulted).toBeDefined();
    // Never both — staleness is intersected against confirmed steps, and this is
    // precisely the absence of a confirmation.
    expect(defaulted?.isStale).toBe(false);
    // The detail carries no `isComplete` — the view model reads completeness off
    // `state`, deliberately, so there is one verdict rather than two.
    expect(defaulted?.state).not.toBe("complete");
    // The check really did pass, which is what makes this defaulted rather than
    // not-started, and nobody recorded anything against it.
    expect(defaulted?.status).toBe("complete");
    expect(defaulted?.progress).toBe("open");
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

  /*
    MOCKUP 7'S SCENARIO, at the view layer: a club that finished setup on the
    previous version, updated, and now has a step it has never seen. The
    traversal suite proves the STATE is right for every id; this proves the
    RENDERED ROW is right for the step that actually arrived this way
    (`environment-role`, ENV-SAFETY 1 #3034), because `buildSetupWizardView`
    falls back to rendering a bare id when readiness and the registry disagree
    about a step — a fallback that is deliberate, quiet, and exactly what a
    half-done merge would leave behind.
  */
  it("renders a step added by an update as a real rail row, not a bare id", () => {
    const before = SETUP_STEP_IDS.filter((id) => id !== "environment-role");
    const view = viewFor({ completedStepIds: [...before] });

    const added = view.steps.find((step) => step.id === "environment-role");
    expect(added, "the new step is missing from the journey entirely").toBeTruthy();
    // Titled and categorised from the readiness check, not from the id.
    expect(added?.title).not.toBe("environment-role");
    expect(added?.categoryId).toBe("foundation");
    expect(added?.categoryTitle).toBe("Foundation");
    expect(added?.permissionArea).toBe("support");
    // Third in the rail's Foundation group, where upstream ships it.
    const foundation = view.groups.find((group) => group.id === "foundation");
    expect(foundation?.steps.map((step) => step.id).slice(0, 3)).toEqual([
      "club-config",
      "club-time-zone",
      "environment-role",
    ]);
    // And it is stated as outstanding rather than silently swallowed.
    expect(view.outstanding.map((item) => item.id)).toContain("environment-role");
    expect(view.allResolved).toBe(false);
  });
});

/*
  Wayfinding (#223 fix round). A step's "Open the settings for this step" link
  has to reach an editor that EXISTS in both positions of the legacy-surfaces
  switch. `club-config` pointed at `/admin/setup`, which never held a
  club-identity editor and holds no route to one at all once the surfaces are
  hidden — so an operator on the wizard's first step was sent to a page that
  could not do the thing the step is about.
*/
describe("a step's settings link reaches a real editor (#223)", () => {
  it("sends club-config to the club identity editor, under its real area", () => {
    const view = viewFor();
    const step = view.steps.find((entry) => entry.id === "club-config");

    expect(step?.href).toBe("/admin/appearance/identity");
    // The area is the one that governs THAT page — `content`, which
    // `/api/admin/club-identity` enforces — not the area of `/admin/setup`.
    expect(step?.permissionArea).toBe("content");
  });

  it("sends no step to /admin/setup or a retired hub, which carry no editor of their own", () => {
    // `/admin/setup` and its foundations/finance/booking-rules/integrations
    // sub-hubs are the switch's home and a list of links; none of them edit
    // anything themselves once the legacy surfaces are hidden. A step whose
    // settings link — via `href` OR one of `links[]` — lands on one of these
    // is a step with no destination in the hidden position.
    // `/admin/setup/cancellation` is deliberately excluded: it was never
    // retired and still carries its own editor.
    const RETIRED_HUB =
      /^\/admin\/setup(\/(foundations|finance|booking-rules|integrations))?$/;
    const view = viewFor();
    const stranded = view.steps
      .filter(
        (step) =>
          (step.href !== undefined && RETIRED_HUB.test(step.href)) ||
          step.links.some((link) => RETIRED_HUB.test(link.href)),
      )
      .map((step) => step.id);

    expect(stranded).toEqual([]);
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

  // Back is SYMMETRIC with Continue: it targets a step the operator may
  // actually open, and is simply absent when there is none. The old
  // `steps[index - 1]` teleported — the client resolves an unreachable target
  // back to `currentStepId`, so Back could move somebody somewhere they never
  // asked to go, with nothing on screen saying so.
  //
  // Mutation-verified: restoring `previous: view.steps[index - 1] ?? null`
  // fails both assertions below.
  it("walks Back to the nearest EARLIER REACHABLE step, skipping locked ones", () => {
    const view = stubView([
      { id: "a", isReachable: true },
      { id: "b", isReachable: false },
      { id: "c", isReachable: false },
      { id: "d", isReachable: true },
    ]);
    expect(setupWizardNeighbours(view, "d" as SetupStepId).previous?.id).toBe("a");
  });

  it("has no Back at all when nothing earlier is reachable", () => {
    const view = stubView([
      { id: "a", isReachable: false },
      { id: "b", isReachable: true },
    ]);
    expect(setupWizardNeighbours(view, "b" as SetupStepId).previous).toBeNull();
    // …and the first step never had one.
    expect(setupWizardNeighbours(view, "a" as SetupStepId).previous).toBeNull();
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
