import { describe, expect, it } from "vitest";
import { MODULE_KEYS, type ModuleSettingsValues } from "@/config/modules";
import {
  ADMIN_PERMISSION_AREAS,
  emptyAdminPermissionMatrix,
  getAdminRouteRequirement,
} from "@/lib/admin-permissions";
import {
  buildSetupReadiness,
  normalizeSetupProgress,
  type SetupDatabaseSnapshot,
} from "@/lib/setup-readiness";
import {
  SETUP_STEP_IDS,
  SETUP_STEP_REGISTRY,
  type SetupStepId,
} from "@/lib/setup-step-registry";
import {
  SETUP_ENVIRONMENT_REMEDY,
  SETUP_ENVIRONMENT_REMEDY_BY_STATUS,
} from "@/lib/setup-wizard-environment-view";
import { buildSetupWizardTraversal } from "@/lib/setup-wizard-traversal";
import {
  SETUP_STEP_PERMISSION_AREA,
  buildSetupWizardView,
  canChangeSetupProgress,
  resolveInitialStepId,
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

/**
 * A database snapshot in which a SEED has filled in some defaults and nobody has
 * confirmed anything — the D14/D15 "defaulted" scenario, made explicit.
 *
 * It became necessary with D17 (#246). This suite used to reach the defaulted
 * state by accident: on a bare `env: {}` fixture the ONE check that passed was
 * `auth-secret-strength` (see the note in `viewFor` below), and D17 moved that
 * one onto the Server-environment panel — so the operator half of the journey
 * had no passing check left and "however many checks pass" became a fixture
 * where none did. Rather than reinstate the accident, this states the scenario
 * the tests are actually about: a club whose seed wrote age tiers and a
 * cancellation policy, and whose operator has agreed to neither.
 */
function seededSnapshot(): SetupDatabaseSnapshot {
  return {
    adminCount: 0,
    ageTierSettingCount: 4,
    seasonCount: 0,
    cancellationPolicyCount: 0,
    bookingDefaultsConfigured: false,
    groupDiscountConfigured: false,
    membershipCancellationSettingsConfigured: false,
    membershipCancellationXeroGroupCount: 0,
    membershipCancellationArchiveContacts: false,
    operationalXeroConnected: false,
    operationalXeroTokenExpiresAt: null,
    xeroAccountMappingCount: 0,
    xeroHutFeeItemMappingCount: 0,
    xeroEntranceFeeMappingCount: 0,
  };
}

function viewFor(
  progress: { completedStepIds?: string[]; skippedStepIds?: string[] } = {},
  moduleSettings?: Parameters<typeof buildSetupWizardTraversal>[0]["moduleSettings"],
  database: SetupDatabaseSnapshot | undefined = seededSnapshot(),
  env: Record<string, string> = {},
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
  const readiness = buildSetupReadiness({ progress: normalised, env, database });
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
    // An OPERATOR step since D17 (#246). This named `sentry` until that change
    // made it an environment fact — which cannot be deferred, is not part of
    // `outstanding`, and whose progress transition the route now refuses (422).
    const view = viewFor({ skippedStepIds: ["seasons-rates"] });
    const entry = view.outstanding.find((item) => item.id === "seasons-rates");
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
    RENDERED ROW is right, because `buildSetupWizardView` falls back to
    rendering a bare id when readiness and the registry disagree about a step —
    a fallback that is deliberate, quiet, and exactly what a half-done merge
    would leave behind.

    The subject is `site-style` (epic #213, C7, #222): a step that genuinely
    arrived mid-epic and slotted into the middle of a journey clubs were already
    part-way through, which is the property under test. It named
    `environment-role` (ENV-SAFETY 1, #3034) until D17 (#246) made that an
    environment fact — the same scenario for a FACT is the test immediately
    below, so both halves of the split keep this coverage rather than one of
    them inheriting it.
  */
  it("renders a step added by an update as a real rail row, not a bare id", () => {
    const before = SETUP_STEP_IDS.filter((id) => id !== "site-style");
    const view = viewFor({ completedStepIds: [...before] });

    const added = view.steps.find((step) => step.id === "site-style");
    expect(added, "the new step is missing from the journey entirely").toBeTruthy();
    // Titled and categorised from the readiness check, not from the id.
    expect(added?.title).not.toBe("site-style");
    expect(added?.categoryId).toBe("website");
    expect(added?.permissionArea).toBe("content");
    // In its own group, in journey position — between the booking rules and the
    // integrations, which is where C7 slotted it without renumbering anything.
    const journey = view.steps.map((step) => step.id);
    expect(journey.indexOf("site-style")).toBeGreaterThan(
      journey.indexOf("seasons-rates"),
    );
    expect(journey.indexOf("site-style")).toBeLessThan(journey.indexOf("stripe"));
    // And it is stated as outstanding rather than silently swallowed.
    expect(view.outstanding.map((item) => item.id)).toContain("site-style");
    expect(view.allResolved).toBe(false);
  });

  /*
    THE SAME SCENARIO FOR AN ENVIRONMENT FACT (D17, #246) — and the reason the
    test above could not simply be re-pointed and left at that.

    `environment-role` is the step that actually arrived by an update
    (ENV-SAFETY 1, #3034), and it is now a fact. A club updating INTO D17 has a
    progress row naming ids that are no longer steps at all, so this pins that
    such a club is not shown a bare id, is not told it has outstanding work it
    cannot do, and is not blocked from finishing — the fact simply appears on
    the panel, titled from its own readiness check.
  */
  it("renders a fact added by an update as a real panel row, and never as outstanding", () => {
    const before = SETUP_STEP_IDS.filter((id) => id !== "environment-role");
    const view = viewFor({ completedStepIds: [...before] });

    const fact = view.environment.find((row) => row.id === "environment-role");
    expect(fact, "the fact is missing from the panel entirely").toBeTruthy();
    expect(fact?.title).not.toBe("environment-role");
    expect(fact?.permissionArea).toBe("support");

    // It is not on the rail, not in the journey, and not outstanding work.
    expect(view.steps.map((step) => step.id)).not.toContain("environment-role");
    expect(view.outstanding.map((item) => item.id)).not.toContain(
      "environment-role",
    );
    // A stored "completed" for an id that is no longer a step is simply
    // ignored, exactly as one for a removed step is — it does not resurrect the
    // id, and it does not make the fact read green.
    expect(fact?.status).not.toBe("complete");
    // …and because nothing has declared the role, it holds the publish shut and
    // carries a remedy addressed to somebody other than the reader.
    expect(fact?.blocksLaunch).toBe(true);
    expect(view.launchBlockedBy.map((row) => row.id)).toContain(
      "environment-role",
    );
    expect(fact?.remedy?.who).toContain("Whoever runs your server");
  });
});

/*
  THE PANEL'S OWN VIEW MODEL (D17, C15 #246).
*/
describe("buildSetupWizardView — the environment half", () => {
  it("carries the registry's five facts, and nothing else", () => {
    const view = viewFor();
    expect(view.environment.map((row) => row.id)).toEqual([
      "environment-role",
      "runtime-env",
      "auth-secret-strength",
      "email-ses",
      "sentry",
    ]);
    // The two halves partition the applicable set — nothing is on both
    // surfaces, and nothing fell between them.
    const stepIds = new Set(view.steps.map((step) => step.id));
    for (const row of view.environment) {
      expect(stepIds.has(row.id)).toBe(false);
    }
  });

  it("KEEPS THE TWO PROVIDER TESTS — the split relocates controls, never deletes them", () => {
    // The finding this whole design turns on: `email-ses` and `sentry` are two
    // of the four checks that declare a provider test, and both moved off the
    // rail. Losing the action here would be the #223 regression all over again.
    const view = viewFor();
    const byId = new Map(view.environment.map((row) => [row.id, row]));
    expect(byId.get("email-ses")?.action).toMatchObject({
      type: "provider-test",
      provider: "smtp",
    });
    expect(byId.get("sentry")?.action).toMatchObject({
      type: "provider-test",
      provider: "sentry",
    });
  });

  it("gives every non-green fact a remedy, and every green one none", () => {
    const view = viewFor();
    for (const row of view.environment) {
      if (row.status === "complete") {
        expect(row.remedy, `${row.id} is green and should carry no remedy`).toBeNull();
      } else {
        expect(row.remedy, `${row.id} is not green and needs a remedy`).toBeTruthy();
        // R2-3's order: who FIRST, then the line to send them, then why.
        expect(row.remedy?.who.length).toBeGreaterThan(0);
        expect(row.remedy?.send.length).toBeGreaterThan(0);
        expect(row.remedy?.why.length).toBeGreaterThan(0);
      }
    }
  });

  it("registers a remedy for EVERY environment fact the registry declares", () => {
    // The guard that makes `SETUP_ENVIRONMENT_REMEDY`'s partiality safe. It is
    // keyed over `SetupStepId` but only ever consulted for environment ids, so
    // the type system cannot demand completeness — this does.
    for (const entry of SETUP_STEP_REGISTRY) {
      if (entry.kind !== "environment") continue;
      expect(
        SETUP_ENVIRONMENT_REMEDY[entry.id],
        `environment fact "${entry.id}" has no remedy — an operator would be told what is wrong and not who fixes it`,
      ).toBeTruthy();
    }
  });

  it("names no remedy for a step that is not an environment fact", () => {
    // The other direction: a stale entry left behind by a reclassification
    // would be dead copy nobody could reach, and dead copy rots.
    const environmentIds = new Set(
      SETUP_STEP_REGISTRY.filter((entry) => entry.kind === "environment").map(
        (entry) => entry.id,
      ),
    );
    for (const id of Object.keys(SETUP_ENVIRONMENT_REMEDY)) {
      expect(environmentIds.has(id as SetupStepId), id).toBe(true);
    }
  });

  it("titles and details every row from its readiness check", () => {
    const view = viewFor();
    for (const row of view.environment) {
      expect(row.title, row.id).not.toBe(row.id);
      expect(row.message.length, row.id).toBeGreaterThan(0);
    }
  });

  it("blocks the launch on the gating facts, and on neither advisory one", () => {
    const view = viewFor();
    // Two of the three on THIS fixture. `auth-secret-strength` reads green on a
    // bare `env: {}` — the check's own no-duplicate-finding rule, described in
    // `viewFor` above — so it is not blocking here, and the test below is the
    // one that exercises it. Asserting all three here would have been asserting
    // the fixture, not the rule.
    expect(view.launchBlockedBy.map((row) => row.id)).toEqual([
      "environment-role",
      "runtime-env",
    ]);
    const byId = new Map(view.environment.map((row) => [row.id, row]));
    expect(byId.get("auth-secret-strength")?.status).toBe("complete");
    // The advisories are genuinely not green here, so their exclusion from the
    // gate is a real answer rather than a vacuous one.
    expect(byId.get("email-ses")?.status).not.toBe("complete");
    expect(byId.get("sentry")?.status).not.toBe("complete");
    expect(byId.get("email-ses")?.blocksLaunch).toBe(false);
    expect(byId.get("sentry")?.blocksLaunch).toBe(false);
  });

  it("blocks the launch on a WEAK auth secret", () => {
    // The third gating fact, on a deployment that has one and it is too short —
    // the state CI's own `verify` job runs in (`AUTH_SECRET: ci-auth-secret`),
    // and the one where this site cannot store a Stripe or Xero credential.
    const progress = normalizeSetupProgress({
      completedStepIds: [],
      skippedStepIds: [],
      completedAt: null,
      completedByMemberId: null,
    });
    const readiness = buildSetupReadiness({
      progress,
      env: { AUTH_SECRET: "too-short" },
      database: seededSnapshot(),
    });
    const readinessStatuses: Partial<
      Record<SetupStepId, (typeof readiness.categories)[number]["checks"][number]["status"]>
    > = {};
    for (const category of readiness.categories) {
      for (const check of category.checks) readinessStatuses[check.id] = check.status;
    }
    const view = buildSetupWizardView(
      readiness,
      buildSetupWizardTraversal({ progress, readinessStatuses }),
    );

    const secret = view.environment.find(
      (row) => row.id === "auth-secret-strength",
    );
    expect(secret?.status).toBe("warning");
    expect(secret?.blocksLaunch).toBe(true);
    expect(view.launchBlockedBy.map((row) => row.id)).toContain(
      "auth-secret-strength",
    );
    // A warning, not a `blocked` — which is exactly why the gate is written as
    // "anything but complete" rather than as a status test.
    expect(secret?.remedy?.send).toContain("AUTH_SECRET");
  });
});

/*
  THE PUBLISH GATE'S REACHABLE STATES (C15 #246 fix round, review finding F2).

  The gate is `status !== "complete"`, which means every branch a gated check
  can reach that is not green holds the public site shut. That is the right
  predicate and it is WIDER than the three conditions D17's own prose named:
  `environment-role` turned out to have a fifth branch (#3035 — declared
  PRODUCTION while ALSO declaring a local capture mailbox), which gates publish
  correctly and was answered with the wrong remedy, because nobody had counted
  the branches.

  So this is a census with teeth. For each gated fact it drives the REAL
  readiness builder through every branch that can reach the wizard, and asserts
  the status set it observes is exactly the one declared below. A future branch
  that changes a gated check's verdict fails here rather than silently widening
  the gate — and the assertion message says what the author now owes: a decision
  about whether publish should be held in that state, and a remedy row for it.

  Not a source regex, deliberately. A regex over `setup-readiness.ts` would pin
  the shape of the code rather than the behaviour, and would pass a branch that
  returns an existing status for a new reason — which is precisely the #3035
  case.
*/
describe("the publish gate's reachable statuses (D17, F2)", () => {
  const productionRole = (): SetupDatabaseSnapshot["environmentRole"] => ({
    role: "PRODUCTION",
    decidedBy: "deployment-declaration",
    declaration: { kind: "production" },
    databaseOverride: { kind: "none" },
    notes: [],
  });

  const nonProductionRole = (): SetupDatabaseSnapshot["environmentRole"] => ({
    role: "NON_PRODUCTION",
    decidedBy: "deployment-declaration",
    declaration: { kind: "non-production" },
    databaseOverride: { kind: "none" },
    notes: [],
  });

  const unknownRole = (): SetupDatabaseSnapshot["environmentRole"] => ({
    role: "UNKNOWN",
    decidedBy: "unresolved",
    declaration: { kind: "absent" },
    databaseOverride: { kind: "none" },
    notes: [],
  });

  const completeRuntimeEnv = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    NEXTAUTH_URL: "https://club.example.nz",
    CRON_SECRET: "a-cron-secret-value",
    SEED_ADMIN_EMAIL: "admin@example.nz",
    SEED_ADMIN_PASSWORD: "a-seed-admin-password",
    AUTH_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
  };

  /**
   * Every branch of every GATED fact that the wizard's own payload can reach,
   * named, with the status it produces.
   *
   * `environment-role`'s "database state was not checked" branch is deliberately
   * absent: it needs the snapshot to carry no `environmentRole` at all, which
   * only `npm run setup:check` without database access produces —
   * `/api/admin/setup/wizard` always passes a snapshot and
   * `resolveEnvironmentRole()` always answers. The scenario below that omits the
   * whole database is the closest reachable thing and is listed under its own
   * name, so the exclusion is stated rather than assumed.
   */
  const gatingStatusSets: Record<
    string,
    readonly {
      readonly label: string;
      readonly status: "complete" | "warning" | "blocked" | "not_started";
      readonly database: SetupDatabaseSnapshot | undefined;
      readonly env: Record<string, string>;
    }[]
  > = {
    "environment-role": [
      {
        label: "declared PRODUCTION, mail going out",
        status: "complete",
        database: {
          ...seededSnapshot(),
          environmentRole: productionRole(),
          withheldEmail: {
            available: true,
            count: 0,
            mostRecentAt: null,
            captureInProduction: 0,
          },
        },
        env: completeRuntimeEnv,
      },
      {
        label: "declared NON_PRODUCTION",
        status: "complete",
        database: { ...seededSnapshot(), environmentRole: nonProductionRole() },
        env: completeRuntimeEnv,
      },
      {
        label: "UNKNOWN — nothing has declared it",
        status: "blocked",
        database: { ...seededSnapshot(), environmentRole: unknownRole() },
        env: completeRuntimeEnv,
      },
      {
        label: "declared PRODUCTION but capturing its mail (#3035)",
        status: "warning",
        database: {
          ...seededSnapshot(),
          environmentRole: productionRole(),
          withheldEmail: {
            available: true,
            count: 7,
            mostRecentAt: "2026-06-30T00:00:00.000Z",
            captureInProduction: 7,
          },
        },
        env: completeRuntimeEnv,
      },
      {
        label: "no snapshot at all — setup:check without a database",
        status: "warning",
        database: undefined,
        env: completeRuntimeEnv,
      },
    ],
    "runtime-env": [
      {
        label: "every required variable set and well formed",
        status: "complete",
        database: { ...seededSnapshot(), environmentRole: productionRole() },
        env: completeRuntimeEnv,
      },
      {
        label: "a required variable missing",
        status: "blocked",
        database: { ...seededSnapshot(), environmentRole: productionRole() },
        env: { ...completeRuntimeEnv, CRON_SECRET: "" },
      },
    ],
    "auth-secret-strength": [
      {
        label: "a strong secret",
        status: "complete",
        database: { ...seededSnapshot(), environmentRole: productionRole() },
        env: completeRuntimeEnv,
      },
      {
        label: "a weak secret",
        status: "warning",
        database: { ...seededSnapshot(), environmentRole: productionRole() },
        env: { ...completeRuntimeEnv, AUTH_SECRET: "too-short" },
      },
    ],
  };

  it("covers every fact that can hold the publish button shut", () => {
    // The census's own completeness. A NEW gating fact — or an existing one
    // reclassified into the gate — has no scenarios here, so it fails with the
    // instruction rather than being quietly ungoverned.
    const gated = SETUP_STEP_REGISTRY.filter(
      (entry) => entry.launchGate === "blocks-until-complete",
    ).map((entry) => entry.id);

    expect(gated.sort()).toEqual(Object.keys(gatingStatusSets).sort());
    for (const id of gated) {
      expect(
        gatingStatusSets[id]?.length ?? 0,
        `"${id}" holds the publish button shut and no branch of it is exercised here — widening the launch gate needs an owner decision and a SETUP_ENVIRONMENT_REMEDY row for every state it can be met in`,
      ).toBeGreaterThan(1);
    }
  });

  it("reaches exactly the declared statuses, and no others", () => {
    for (const [id, scenarios] of Object.entries(gatingStatusSets)) {
      const observed = new Set<string>();
      for (const scenario of scenarios) {
        const view = viewFor({}, undefined, scenario.database, scenario.env);
        const row = view.environment.find((entry) => entry.id === id);
        expect(row, `${id} is not on the panel at all`).toBeTruthy();
        expect(
          row?.status,
          `"${id}" in the state "${scenario.label}" no longer reads ${scenario.status}. A gated check's verdicts decide when the public site is held shut, so a changed or added branch needs an owner decision and a remedy row before it lands`,
        ).toBe(scenario.status);
        expect(
          row?.blocksLaunch,
          `"${id}" in the state "${scenario.label}" must hold publish shut iff it is not complete`,
        ).toBe(scenario.status !== "complete");
        observed.add(scenario.status);
      }
      expect(
        [...observed].sort(),
        `the reachable status set for "${id}" moved`,
      ).toEqual([...new Set(scenarios.map((s) => s.status))].sort());
    }
  });

  it("hands every reachable non-green state a remedy that fits its CAUSE", () => {
    // F1's finding, and the reason the census exists. Both non-green states of
    // `environment-role` gate publish; only one of them is fixed by setting
    // APP_ENVIRONMENT_ROLE, and telling the other operator to set a variable
    // that is already set correctly sends them to the wrong place entirely.
    for (const [id, scenarios] of Object.entries(gatingStatusSets)) {
      for (const scenario of scenarios) {
        if (scenario.status === "complete") continue;
        const view = viewFor({}, undefined, scenario.database, scenario.env);
        const row = view.environment.find((entry) => entry.id === id);
        expect(
          row?.remedy,
          `"${id}" in the state "${scenario.label}" holds the site shut and offers no remedy`,
        ).toBeTruthy();
      }
    }
  });

  it("tells a capturing live site to fix its TRANSPORT, not to set the role", () => {
    const capturing = gatingStatusSets["environment-role"].find(
      (scenario) => scenario.status === "warning" && scenario.database,
    );
    expect(capturing, "the #3035 scenario is missing").toBeTruthy();

    const view = viewFor({}, undefined, capturing?.database, capturing?.env);
    const row = view.environment.find((entry) => entry.id === "environment-role");
    expect(row?.status).toBe("warning");
    expect(row?.blocksLaunch).toBe(true);
    // The cause-aware override, in its own words.
    expect(row?.remedy).toEqual(
      SETUP_ENVIRONMENT_REMEDY_BY_STATUS["environment-role"]?.warning,
    );
    expect(row?.remedy?.send).toContain("USE_LOCAL_CAPTURE");
    // …and pointedly NOT the base remedy's instruction, which is the whole bug.
    expect(row?.remedy?.send).not.toContain("Set APP_ENVIRONMENT_ROLE to");
    expect(row?.remedy).not.toEqual(SETUP_ENVIRONMENT_REMEDY["environment-role"]);
  });

  it("still gives the UNDECLARED role the set-the-variable remedy", () => {
    // The converse, so the override cannot swallow the branch it was carved out
    // of: `blocked` must still resolve to the base entry.
    const undeclared = gatingStatusSets["environment-role"].find(
      (scenario) => scenario.status === "blocked",
    );
    const view = viewFor({}, undefined, undeclared?.database, undeclared?.env);
    const row = view.environment.find((entry) => entry.id === "environment-role");
    expect(row?.remedy).toEqual(SETUP_ENVIRONMENT_REMEDY["environment-role"]);
    expect(row?.remedy?.send).toContain("APP_ENVIRONMENT_ROLE");
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

// C21 (#252) retired `setupWizardNeighbours` along with the Back/Continue
// controls it drove — the rail is the sole navigation now, and its own
// unreachable-row gate is what `setup-wizard-rail.test.tsx` pins. What
// remains here is the one navigation helper that survives: resolving a
// requested-but-unreachable (or unknown) step id back to the current one.
describe("navigation helpers", () => {
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
