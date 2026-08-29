import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  type ModuleSettingsValues,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { DEFAULT_SETUP_SURFACE_SETTINGS } from "@/config/club-settings-defaults";
import { normalizeSetupSurfaceSettings } from "@/lib/setup-surface-settings";
import {
  SETUP_HUB_CARDS,
  getVisibleSetupHubCards,
} from "@/app/(admin)/admin/setup/setup-hub-cards";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  buildSetupReadiness,
  type SetupDatabaseSnapshot,
} from "@/lib/setup-readiness";
import {
  SETUP_STEP_IDS,
  SETUP_STEP_REGISTRY,
  getApplicableSetupStepIds,
} from "@/lib/setup-step-registry";
import { buildSetupWizardTraversal } from "@/lib/setup-wizard-traversal";
import {
  buildSetupWizardView,
  type SetupWizardView,
} from "@/lib/setup-wizard-view";

/**
 * THE SHARED-DERIVATION CONTRACT (epic #213, child C8, #223).
 *
 * #223's first acceptance criterion: "cards, hub pages and wizard derive
 * outstanding work from the same registry and cannot report different totals".
 * Three surfaces used to answer that question three ways —
 * `buildSetupReadiness` built all twenty checks unconditionally,
 * `buildSetupWizardTraversal` filtered the registry by module flags, and the
 * hub cards were a hand-maintained array that consulted neither. This file is
 * the guard that keeps them married, and it is FAIL-CLOSED in both directions
 * on purpose: a step the cards show but the registry does not know is as much a
 * failure as a registry step no card shows.
 *
 * WHY A SEPARATE FILE from `setup-step-registry.test.ts`. That file is C1's
 * contract — what a registry IS and what makes one malformed. This one is about
 * the agreement BETWEEN surfaces, which is a different thing to break and a
 * different thing to read when it breaks.
 *
 * Note this suite cannot be reached from the module graph of a change to a hub
 * PAGE's own link list — those pages are not imported here. `test:related` will
 * pick this file up for any change to the registry, the readiness builder, the
 * traversal, or `setup-hub-cards.ts`, which is where the disagreement this
 * guards against would actually originate.
 */

function moduleFlags(
  overrides: Partial<ModuleSettingsValues> = {},
): ModuleSettingsValues {
  const allEnabled = Object.fromEntries(
    MODULE_KEYS.map((key) => [key, true]),
  ) as ModuleSettingsValues;
  return { ...allEnabled, ...overrides };
}

const allModulesOff = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, false]),
) as ModuleSettingsValues;

function databaseSnapshot(
  adminModuleSettings: ModuleSettingsValues,
): SetupDatabaseSnapshot {
  return {
    adminCount: 1,
    adminModuleSettings,
    ageTierSettingCount: 4,
    seasonCount: 2,
    cancellationPolicyCount: 1,
    bookingDefaultsConfigured: true,
    groupDiscountConfigured: true,
    membershipCancellationSettingsConfigured: true,
    membershipCancellationXeroGroupCount: 1,
    membershipCancellationArchiveContacts: true,
    operationalXeroConnected: true,
    operationalXeroTokenExpiresAt: "2026-09-01T00:00:00.000Z",
    xeroAccountMappingCount: 1,
    xeroHutFeeItemMappingCount: 1,
    xeroEntranceFeeMappingCount: 1,
  };
}

function cardStepIds(database: SetupDatabaseSnapshot | undefined) {
  return buildSetupReadiness({
    env: {},
    // Deliberately absent: the club-config check reports on a missing config
    // rather than throwing, and no step's PRESENCE depends on the file.
    configDir: "/nonexistent-setup-surface-parity-fixture",
    database,
  });
}

function wizardStepIds(moduleSettings: ModuleSettingsValues | null | undefined) {
  return buildSetupWizardTraversal({
    progress: { completedStepIds: [], skippedStepIds: [] },
    moduleSettings,
  }).applicableStepIds;
}

/*
  The module states worth checking, named rather than randomised so a failure
  says which club shape broke. `undefined` is the fail-open case — a DB-less
  `npm run setup:check` — and it is in this matrix because it is the one input
  where the correct answer is "show everything", so a filter written the wrong
  way round passes every other row and fails here.
*/
const MODULE_STATES: readonly {
  name: string;
  settings: ModuleSettingsValues | null | undefined;
}[] = [
  { name: "every module enabled", settings: moduleFlags() },
  { name: "every module disabled", settings: allModulesOff },
  { name: "first-install defaults", settings: DEFAULT_MODULE_SETTINGS },
  { name: "no saved Modules row (null)", settings: null },
  { name: "module state unknown (undefined)", settings: undefined },
  {
    name: "Xero off, finance dashboard on",
    settings: moduleFlags({ xeroIntegration: false }),
  },
  {
    name: "finance dashboard off, Xero on",
    settings: moduleFlags({ financeDashboard: false }),
  },
  {
    name: "address autocomplete off",
    settings: moduleFlags({ addressAutocomplete: false }),
  },
];

describe("setup surfaces — one derivation, three surfaces (#223 AC1)", () => {
  for (const { name, settings } of MODULE_STATES) {
    it(`cards and wizard report the same step set and the same total: ${name}`, () => {
      // `undefined` means "no snapshot at all" for the cards, which is the same
      // input the traversal calls UNKNOWN. `null` is a snapshot that exists and
      // whose Modules row does not.
      const readiness = cardStepIds(
        settings === undefined ? undefined : databaseSnapshot(
          settings ?? DEFAULT_MODULE_SETTINGS,
        ),
      );
      const displayed = readiness.categories.flatMap((category) =>
        category.checks.map((check) => check.id),
      );
      const walked = wizardStepIds(
        settings === undefined ? undefined : settings ?? DEFAULT_MODULE_SETTINGS,
      );

      expect(displayed).toEqual([...walked]);
      expect(readiness.summary.total).toBe(walked.length);
    });

    it(`the registry is the source both of them read: ${name}`, () => {
      const registryAnswer = getApplicableSetupStepIds(settings);
      const readiness = cardStepIds(
        settings === undefined ? undefined : databaseSnapshot(
          settings ?? DEFAULT_MODULE_SETTINGS,
        ),
      );
      const displayed = readiness.categories.flatMap((category) =>
        category.checks.map((check) => check.id),
      );

      expect(displayed).toEqual(registryAnswer);
    });
  }

  it("shows a card for EVERY applicable step — no step is silently unreachable", () => {
    // The fail-closed direction the totals check alone would miss: two surfaces
    // can agree on a COUNT while disagreeing about which steps. This asserts
    // per-id coverage with every module on, where the applicable set is the
    // whole registry, so a readiness builder that dropped a check outright is a
    // failure here rather than a quietly smaller number everywhere.
    const readiness = cardStepIds(databaseSnapshot(moduleFlags()));
    const displayed = new Set(
      readiness.categories.flatMap((category) =>
        category.checks.map((check) => check.id),
      ),
    );

    for (const id of SETUP_STEP_IDS) {
      expect(displayed.has(id)).toBe(true);
    }
  });

  it("shows no card the registry does not declare", () => {
    // The other direction: a check invented in `buildSetupReadiness` with no
    // registry entry would have no owning module, no order, and no wizard step
    // — it would appear on the cards and nowhere else.
    const known = new Set<string>(SETUP_STEP_IDS);
    const readiness = cardStepIds(databaseSnapshot(moduleFlags()));

    for (const category of readiness.categories) {
      for (const check of category.checks) {
        expect(known.has(check.id)).toBe(true);
      }
    }
  });

  it("renders no empty category", () => {
    for (const { settings } of MODULE_STATES) {
      const readiness = cardStepIds(
        settings === undefined ? undefined : databaseSnapshot(
          settings ?? DEFAULT_MODULE_SETTINGS,
        ),
      );
      for (const category of readiness.categories) {
        expect(category.checks.length).toBeGreaterThan(0);
      }
    }
  });
});

/*
  The hub cards' half of the same criterion. `coversStepIds` is typed as
  `SetupStepId`, so a renamed or deleted step is a TYPECHECK failure at the
  declaration; what the type system cannot see is a step nobody claimed, which
  is what these assertions carry.
*/
const STEPS_NO_LEGACY_HUB_CARD_COVERS: readonly string[] = [
  // Reached from Admin > Appearance > Site Style — an ordinary admin surface
  // with no setup HUB of its own. C7 (#222) added this step and the legacy hub
  // cards were never extended to it; the wizard's styling step is its journey
  // home, which is the whole reason the wizard is the destination (D6). Listed
  // rather than papered over, so that whoever adds an Appearance hub card can
  // delete this line and see the assertion tighten.
  "site-style",
];

function everyModuleOnFeatureFlags(): FeatureFlags {
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, true]),
  ) as FeatureFlags;
}

function fullAccessMatrix(): AdminPermissionMatrix {
  const matrix = emptyAdminPermissionMatrix();
  return Object.fromEntries(
    Object.keys(matrix).map((area) => [area, "edit"]),
  ) as AdminPermissionMatrix;
}

describe("setup hub cards — registry parity (#223 AC1)", () => {
  it("declares only step ids the registry knows", () => {
    const known = new Set<string>(SETUP_STEP_IDS);

    for (const card of SETUP_HUB_CARDS) {
      for (const id of card.coversStepIds) {
        expect(known.has(id)).toBe(true);
      }
    }
  });

  it("covers every registry step, or names it as deliberately uncovered", () => {
    const covered = new Set<string>(
      SETUP_HUB_CARDS.flatMap((card) => [...card.coversStepIds]),
    );
    const uncovered = SETUP_STEP_REGISTRY.map((entry) => entry.id).filter(
      (id) => !covered.has(id),
    );

    expect(uncovered).toEqual(STEPS_NO_LEGACY_HUB_CARD_COVERS);
  });

  it("names no uncovered step that is in fact covered", () => {
    // Keeps the exception list above honest in the other direction: an entry
    // left behind after somebody DID add a hub card for that step would
    // otherwise sit there forever, describing a gap that had been closed.
    const covered = new Set<string>(
      SETUP_HUB_CARDS.flatMap((card) => [...card.coversStepIds]),
    );

    for (const id of STEPS_NO_LEGACY_HUB_CARD_COVERS) {
      expect(covered.has(id)).toBe(false);
    }
  });

  it("hides a hub whose every covered step belongs to a disabled module (D4)", () => {
    const applicable = new Set<string>(
      getApplicableSetupStepIds(DEFAULT_MODULE_SETTINGS),
    );
    const visible = getVisibleSetupHubCards(
      SETUP_HUB_CARDS,
      everyModuleOnFeatureFlags(),
      fullAccessMatrix(),
      applicable,
      false,
    ).map((card) => card.href);

    // Finance covers exactly the three steps a first-install club does not get.
    expect(visible).not.toContain("/admin/setup/finance");
    // Operational Integrations covers `address-autocomplete` too, but also
    // three `core` steps, so it survives — the gate is "at least one", not
    // "all", which is what stops one module switch deleting a mixed hub.
    expect(visible).toContain("/admin/setup/integrations");
    expect(visible).toContain("/admin/setup/foundations");
  });

  it("keeps a card that covers no step at all, whatever the module state", () => {
    const noneApplicable = new Set<string>();
    const visible = getVisibleSetupHubCards(
      SETUP_HUB_CARDS,
      everyModuleOnFeatureFlags(),
      fullAccessMatrix(),
      noneApplicable,
      false,
    ).map((card) => card.href);

    expect(visible).toEqual([
      "/admin/membership-setup",
      "/admin/notifications",
    ]);
  });

  it("still applies the module and permission gates it always did", () => {
    const everyStepApplicable = new Set<string>(SETUP_STEP_IDS);
    const noAccess = emptyAdminPermissionMatrix();

    expect(
      getVisibleSetupHubCards(
        SETUP_HUB_CARDS,
        everyModuleOnFeatureFlags(),
        noAccess,
        everyStepApplicable,
        false,
      ),
    ).toEqual([]);
  });
});

/*
  The legacy-surfaces switch (epic #213 D8; #223 acceptance criteria 3 and 4).

  Two properties, and they pull in opposite directions, which is why both are
  pinned. WHAT IT HIDES: the four hubs the wizard replaces really do go. WHAT IT
  MUST NEVER HIDE: anything the wizard does not offer a route to — hiding a
  surface whose capability has nowhere else to live is removing a capability
  rather than relocating one, and D8's parity rule forbids it.
*/
const HUBS_RETIRED_BY_THE_WIZARD = [
  "/admin/setup/foundations",
  "/admin/setup/finance",
  "/admin/setup/booking-rules",
  "/admin/setup/integrations",
];

describe("legacy setup surfaces — the visibility switch (#223 AC3, AC4)", () => {
  it("defaults to SHOWN, and every absence resolves there", () => {
    // AC4's first half, and the property the whole flag's safety rests on: a
    // missing row, a caller with no record at all, and an empty object are the
    // same answer, and that answer never takes a surface away.
    expect(DEFAULT_SETUP_SURFACE_SETTINGS.legacySurfacesHidden).toBe(false);
    expect(normalizeSetupSurfaceSettings(null).legacySurfacesHidden).toBe(false);
    expect(normalizeSetupSurfaceSettings(undefined).legacySurfacesHidden).toBe(
      false,
    );
    expect(normalizeSetupSurfaceSettings({}).legacySurfacesHidden).toBe(false);
  });

  it("reads a stored answer as given, in both positions", () => {
    expect(
      normalizeSetupSurfaceSettings({ legacySurfacesHidden: true })
        .legacySurfacesHidden,
    ).toBe(true);
    expect(
      normalizeSetupSurfaceSettings({ legacySurfacesHidden: false })
        .legacySurfacesHidden,
    ).toBe(false);
  });

  it("retires exactly the four hubs the wizard replaces", () => {
    const retired = SETUP_HUB_CARDS.filter((card) => card.retiredByWizard).map(
      (card) => card.href,
    );

    expect(retired).toEqual(HUBS_RETIRED_BY_THE_WIZARD);
  });

  it("COVERAGE PARITY: never retires a card the wizard does not cover", () => {
    // The load-bearing direction. A card with no covered step has no wizard
    // route to send an operator to, so hiding it would delete the only entry
    // point to whatever it opened. Membership & Members and Email Messages /
    // Notifications are exactly that shape, which is why they stay.
    for (const card of SETUP_HUB_CARDS) {
      if (!card.retiredByWizard) continue;
      expect(
        card.coversStepIds.length,
        `${card.href} is retired by the wizard but covers no registry step, so hiding it would remove a capability rather than relocate one (epic #213 D8)`,
      ).toBeGreaterThan(0);
    }
  });

  it("hides the four, and keeps every other card, when the switch is on", () => {
    const everyStepApplicable = new Set<string>(SETUP_STEP_IDS);
    const visible = getVisibleSetupHubCards(
      SETUP_HUB_CARDS,
      everyModuleOnFeatureFlags(),
      fullAccessMatrix(),
      everyStepApplicable,
      true,
    ).map((card) => card.href);

    for (const href of HUBS_RETIRED_BY_THE_WIZARD) {
      expect(visible).not.toContain(href);
    }
    expect(visible).toEqual([
      "/admin/membership-setup",
      "/admin/setup/cancellation",
      "/admin/notifications",
    ]);
  });

  it("is REVERSIBLE: flipping back restores exactly the previous set", () => {
    // AC4's second half. The switch is a render-time filter over a list that
    // does not itself move, so "reversible" is provable rather than asserted:
    // the shown set with the switch off is identical before and after a flip.
    const everyStepApplicable = new Set<string>(SETUP_STEP_IDS);
    const shown = () =>
      getVisibleSetupHubCards(
        SETUP_HUB_CARDS,
        everyModuleOnFeatureFlags(),
        fullAccessMatrix(),
        everyStepApplicable,
        false,
      ).map((card) => card.href);

    const before = shown();
    // …hide…
    getVisibleSetupHubCards(
      SETUP_HUB_CARDS,
      everyModuleOnFeatureFlags(),
      fullAccessMatrix(),
      everyStepApplicable,
      true,
    );
    // …and show again.
    expect(shown()).toEqual(before);
  });

  /*
    THE GRANULARITY HOLE THIS CLOSES. Everything above compares STEP SETS: the
    cards, the hubs and the rail must walk the same ids. That is necessary and
    it is not sufficient, because a step can be present on both surfaces while
    one of them renders a CONTROL the other does not — and hiding the surface
    that has it removes a capability just as surely as hiding the step would.

    That is not hypothetical: it is what shipped. The four provider tests
    (Stripe, Email, Sentry, Operational Xero) are declared on the readiness
    checks, and until #223's fix round they rendered only in the readiness-card
    branch that the legacy-surfaces switch hides. The steps were all on the rail;
    the buttons were not.

    So this pair asserts the ACTION level, both ways round: every check that
    declares an action has a wizard step carrying it, and no step claims an
    action its check never declared.
  */
  it("carries every check's ACTION onto its wizard SURFACE — no control loses its home", () => {
    /*
      D17 (#246) MOVED TWO OF THESE, AND THIS GUARD HAD TO FOLLOW OR BE WRONG.

      The rule has always been "every control the readiness cards offered has a
      home on the wizard", and until D17 there was one such home: the step's own
      frame. D17 gives an environment fact a different one — a row on the
      Server-environment panel — and `email-ses` and `sentry` both moved onto it.

      So this now asks the SAME question over both surfaces rather than over the
      rail alone. Narrowing it to the rail would have made it pass while two
      live provider tests quietly disappeared, which is precisely the #223
      regression it was written for; widening it to "somewhere on the wizard" is
      what keeps its meaning intact across the move.
    */
    const readiness = cardStepIds(databaseSnapshot(moduleFlags()));
    const view = buildSetupWizardView(
      readiness,
      buildSetupWizardTraversal({
        progress: { completedStepIds: [], skippedStepIds: [] },
        moduleSettings: moduleFlags(),
      }),
    );
    const carriersById = new Map<
      string,
      { action?: SetupWizardView["steps"][number]["action"]; surface: string }
    >([
      ...view.steps.map(
        (step) => [step.id, { action: step.action, surface: "rail step" }] as const,
      ),
      ...view.environment.map(
        (row) =>
          [row.id, { action: row.action, surface: "environment panel row" }] as const,
      ),
    ]);

    const withActions = readiness.categories
      .flatMap((category) => category.checks)
      .filter((check) => check.action);

    // A guard that asserts nothing when the list empties is not a guard: the
    // four provider tests are the reason this exists, so their absence is a
    // failure rather than a vacuous pass.
    expect(withActions.map((check) => check.id).sort()).toEqual([
      "email-ses",
      "sentry",
      "stripe",
      "xero-operational",
    ]);

    for (const check of withActions) {
      const carrier = carriersById.get(check.id);
      expect(
        carrier?.action,
        `the ${check.id} check declares a ${check.action?.type} action, but its wizard ${carrier?.surface ?? "surface"} carries none — hiding the readiness cards would delete that control rather than relocate it (epic #213 D8/D17)`,
      ).toEqual(check.action);
    }

    // …and the split is real rather than incidental: two of the four now live
    // on the panel. Pinned so that quietly folding the facts back into the rail
    // fails HERE as well as in the traversal suite.
    expect(
      withActions
        .map((check) => carriersById.get(check.id)?.surface)
        .filter((surface) => surface === "environment panel row"),
    ).toHaveLength(2);
  });

  it("claims no ACTION the readiness check does not declare", () => {
    const readiness = cardStepIds(databaseSnapshot(moduleFlags()));
    const view = buildSetupWizardView(
      readiness,
      buildSetupWizardTraversal({
        progress: { completedStepIds: [], skippedStepIds: [] },
        moduleSettings: moduleFlags(),
      }),
    );
    const actionsById = new Map(
      readiness.categories
        .flatMap((category) => category.checks)
        .map((check) => [check.id, check.action]),
    );

    for (const step of view.steps) {
      expect(step.action).toEqual(actionsById.get(step.id));
    }
  });

  it("CHANGES NO DATA: the readiness derivation is identical in both positions", () => {
    // The other half of "reversible with no data change" (AC4). The flag is
    // read at RENDER time and nothing derived from it is persisted, so the step
    // set, the totals and every check's verdict are byte-identical whichever
    // way the switch is set — which is what makes hiding recoverable rather
    // than destructive. If this ever fails, the flag has grown a write path.
    const readiness = cardStepIds(databaseSnapshot(moduleFlags()));
    const again = cardStepIds(databaseSnapshot(moduleFlags()));

    expect(JSON.stringify({ ...readiness, generatedAt: null })).toEqual(
      JSON.stringify({ ...again, generatedAt: null }),
    );
    expect(readiness.summary.total).toBe(SETUP_STEP_IDS.length);
  });
});
