import type { AdminPermissionArea } from "@/lib/admin-permissions";
import type { EnvironmentRole, EnvironmentRoleDecidedBy } from "@/lib/environment-role";
import type { WithheldApplicationEmail } from "@/lib/environment-safety-withheld";
import type { SetupReadiness } from "@/lib/setup-readiness";
import type { SetupStepId } from "@/lib/setup-step-registry";
import {
  buildSetupWizardEnvironmentRow,
  type SetupWizardEnvironmentRow,
} from "@/lib/setup-wizard-environment-view";
import { SETUP_STEP_PERMISSION_AREA } from "@/lib/setup-wizard-step-tables";
import type {
  SetupWizardStepState,
  SetupWizardTraversal,
} from "@/lib/setup-wizard-traversal";

/**
 * The setup wizard's VIEW MODEL (epic #213, child C5).
 *
 * C4's traversal answers "what state is each step in and where may the operator
 * go". `buildSetupReadiness` answers "what does each step actually say". This
 * module is the ONE place the two are married, so the shell renders a prepared
 * structure and derives nothing of its own.
 *
 * Pure — no React, no I/O, no `Date` — which is what lets the rail's states, the
 * grouping and the permission mapping all be tested without a DOM.
 *
 * ## Two rules that are load-bearing
 *
 * 1. **THE PERCENTAGE IS NEVER RE-DERIVED HERE.** `percentComplete` is copied
 *    straight off the traversal (D7, and #219's own contract). A second
 *    derivation — counting `complete` states in the rail, say — would disagree
 *    with the traversal the moment a step is both stale and recorded complete,
 *    and the two would drift silently because both look plausible.
 * 2. **The rail is grouped by READINESS CATEGORY and ordered by REGISTRY
 *    ORDER.** Those are two different sources and they happen to agree today
 *    (the registry's declaration order walks foundation → booking →
 *    integrations → finance). If a later child interleaves them, this module
 *    keeps its stated behaviour: a step appears under the category its readiness
 *    check belongs to, steps within a group stay in journey order, and groups
 *    appear in the readiness result's own category order. Resume and the
 *    frontier always follow the FLAT journey order, never the grouped one,
 *    because that is the order D2's frontier is computed in. (Back/Continue
 *    used to walk it too — retired in #252; the rail is the navigation now.)
 *
 * ## The environment half lives next door
 *
 * D17 (C15 #246) gave this marriage a second audience — the Server-environment
 * panel's rows — and C15's fix round moved its types, its remedy register and
 * its per-fact mapper into `setup-wizard-environment-view.ts`, for size. The
 * dependency points one way only, and this module still assembles both halves
 * from the SAME check index, in the same call: nothing about a fact is derived
 * twice.
 */

type SetupReadinessCategory = SetupReadiness["categories"][number];

/**
 * One readiness check. Declared structurally rather than imported because
 * `setup-readiness.ts` exports neither `SetupStepCheck` nor `SetupCategory`, and
 * that file is an epic watchpoint (C3 rewires it) — a view model has no business
 * widening its export surface to be rendered.
 */
export type SetupReadinessCheck = SetupReadinessCategory["checks"][number];

/**
 * The three effective states `resolveEnvironmentRole()` can answer, aliased
 * from `environment-role.ts` rather than copied structurally.
 *
 * THIS IS `import type`, NOT a runtime import, and that distinction is exactly
 * what makes it safe here. `import type` is erased before a bundle exists —
 * `client-server-boundary-census.test.ts` treats it as a non-edge for that
 * reason (its `RUNTIME_IMPORT` regex explicitly excludes `type[\s{]`) — even
 * though `environment-role` sits in that same census's `FORBIDDEN_MODULES` set
 * for RUNTIME imports. `environment-role.ts` is itself deliberately not
 * `server-only` (see its own docblock: `setup-readiness-db.ts` needs it from
 * the `tsx` entrypoint `npm run setup`), so there is no boundary here for a
 * type-only reference to cross.
 *
 * A structural copy was tried first and its rationale was wrong: it claimed
 * `SetupReadinessCheck` above as precedent, but that one is genuinely derived
 * (`SetupReadiness["categories"][number]["checks"][number]`) from a module this
 * file may not import even for types, because `setup-readiness.ts` does not
 * export the type. `environment-role.ts` and `environment-safety-withheld.ts`
 * both export the real types and carry no such restriction, so aliasing them
 * buys compile-time drift protection for free: a renamed member or a widened
 * union in either source file fails this file's typecheck immediately, where a
 * hand-copied literal union would just quietly stop matching.
 */
export type SetupWizardEnvironmentRole = EnvironmentRole;

/** Aliased from `EnvironmentRoleDecidedBy` in `environment-role.ts` — see above. */
export type SetupWizardEnvironmentDecidedBy = EnvironmentRoleDecidedBy;

/**
 * How much application email this installation has held back for
 * environment-safety reasons, aliased from `WithheldApplicationEmail` in
 * `environment-safety-withheld.ts` — see {@link SetupWizardEnvironmentRole} for
 * why a type-only alias is safe and preferred over a structural copy here.
 *
 * `available: false` is deliberately its own case and not a zero — see that
 * module for why no property of the count can stand in for "we could not ask".
 */
export type SetupWizardWithheldEmail = WithheldApplicationEmail;

/**
 * The environment-role facts C9 (#224) carries to the wizard — the launch
 * panel's role lever, and nothing the step's own readiness check does not
 * already say. Deliberately narrower than `/admin/environment`'s full payload
 * (`EnvironmentSafetyState` in `environment-safety-admin-state.ts`): this view
 * has no business carrying the override's raw declaration string, the Xero
 * containment detail or the audit name of who last changed the override — the
 * launch panel names role, source and the withheld count, and links to
 * `/admin/environment` for the rest, rather than duplicating that screen.
 */
export interface SetupWizardEnvironmentSafety {
  readonly role: SetupWizardEnvironmentRole;
  readonly decidedBy: SetupWizardEnvironmentDecidedBy;
  readonly withheldEmail: SetupWizardWithheldEmail;
}

/**
 * What `GET /api/admin/setup/wizard` answers with — declared HERE, in the pure
 * module both ends already import, so the route and the shell cannot drift into
 * two different readings of the same response. Neither could import the other's
 * copy without dragging a server route into a client bundle or vice versa.
 *
 * **This is the WHOLE response, not a subset of it.** The route's own test pins
 * the exact key set, because a key the route sends and this interface does not
 * declare is a key no client can read and nobody is told about — the route
 * shipped a `progress` one in exactly that condition.
 */
export interface SetupWizardPayload {
  readonly readiness: SetupReadiness;
  readonly traversal: SetupWizardTraversal<SetupStepId>;
  /**
   * Whether the public site is live — the club theme's `completedAt`, which D9's
   * launch panel reports and publishes.
   *
   * It rides on the wizard's read rather than being fetched by the panel itself
   * because the shell already refetches this whole payload on focus, so the
   * panel's answer stays current instead of being whatever it was when the panel
   * happened to mount.
   */
  readonly isSiteVisible: boolean;
  /**
   * The SAME resolution `environment-role` readiness step and `/admin/environment`
   * read — see `resolveEnvironmentRole()` and `readWithheldApplicationEmail()`
   * in `setup-readiness-db.ts`, carried through rather than re-derived (C9,
   * #224). It rides on this payload for the same reason `isSiteVisible` does:
   * the shell's focus refetch keeps it current for whichever administrator has
   * the launch panel open when another one declares the role or the safer
   * override changes.
   */
  readonly environmentSafety: SetupWizardEnvironmentSafety;
}

export interface SetupWizardRailStep {
  readonly id: SetupStepId;
  readonly title: string;
  readonly state: SetupWizardStepState;
  readonly isReachable: boolean;
  readonly isStale: boolean;
  readonly isDeferred: boolean;
  /**
   * The step's check passes and nobody confirmed it (D14, #237). Carried
   * alongside `state` for the same reason `isStale` and `isDeferred` are: the
   * state machine's precedence is lossy, and the rail's label rebuilds the full
   * picture from these flags.
   */
  readonly isDefaulted: boolean;
  readonly permissionArea: AdminPermissionArea;
}

export interface SetupWizardRailGroup {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly SetupWizardRailStep[];
}

export interface SetupWizardStepDetail extends SetupWizardRailStep {
  readonly categoryId: string;
  readonly categoryTitle: string;
  readonly description: string;
  readonly message: string;
  readonly details: readonly string[];
  readonly href?: string;
  /**
   * Extra destinations beside `href` (C6, #221) — the lodges step's one link
   * per lodge. Always an array, empty for every other step, so the frame can
   * render it without a null check.
   */
  readonly links: readonly { label: string; href: string }[];
  /**
   * The step's provider test, when its readiness check declares one (C8, #223).
   *
   * Four checks carry one — Stripe, Email, Sentry and Operational Xero — and it
   * is a real CAPABILITY rather than decoration: it pings the live service and
   * writes the answer back into the check. It reached the readiness cards and
   * nowhere else, so hiding the cards (D8) would have taken it away instead of
   * relocating it. Carried through structurally, from the same check every
   * other field on this detail comes from, so a fifth provider test needs no
   * change here.
   */
  readonly action?: SetupReadinessCheck["action"];
  readonly required: boolean;
  readonly progress: SetupReadinessCheck["progress"];
  readonly status: SetupReadinessCheck["status"];
}

export interface SetupWizardView {
  /** Rail rows, grouped by readiness category. Empty groups are dropped. */
  readonly groups: readonly SetupWizardRailGroup[];
  /** Every applicable step in JOURNEY order — what resume and the frontier walk. */
  readonly steps: readonly SetupWizardStepDetail[];
  /**
   * The Server-environment panel's rows, in registry order (D17, C15 #246) —
   * the facts the operator is TOLD, as against the steps they walk.
   */
  readonly environment: readonly SetupWizardEnvironmentRow[];
  /**
   * Rows holding the publish button shut, straight from the traversal's
   * `launchBlockedBy` (never re-derived here — same rule as `percentComplete`).
   * A subset of `environment`, carried resolved so the launch panel can name
   * them without a second pass.
   */
  readonly launchBlockedBy: readonly SetupWizardEnvironmentRow[];
  /** D7's percentage, copied from the traversal and never recomputed. */
  readonly percentComplete: number;
  readonly currentStepId: SetupStepId | null;
  readonly navigationFrontierStepId: SetupStepId | null;
  /** D9's launch-panel unlock. Straight from the traversal (#219 F9). */
  readonly allResolved: boolean;
  /**
   * Titles of everything not CONFIRMED — mockup 6 states these plainly. Since
   * D14 (#237) that includes defaulted steps.
   *
   * **`deferred` rides on each entry because the reader must partition on it,
   * and an earlier version of this note said it need not.** That note argued the
   * launch panel is the only reader and renders only once `allResolved` is true,
   * which no defaulted step permits — so every entry would be a deferral and its
   * "by your own choice" heading was safe. True of the UNPINNED panel only. The
   * shell's `launchPinned` keeps the panel mounted across a refetch on purpose
   * (unmounting mid-publish would discard the answer), and inside that window a
   * step can go stale or a newly-enabled module can contribute one — neither
   * chosen by anybody. The panel therefore partitions on this flag rather than
   * relying on a guarantee it only has some of the time.
   */
  readonly outstanding: readonly { id: SetupStepId; title: string; deferred: boolean }[];
}

/**
 * Marry one readiness result to one traversal.
 *
 * The two step sets are now IDENTICAL, not merely overlapping: C8 (#223) wired
 * `buildSetupReadiness` to the same registry filter the traversal uses, and
 * `setup-surface-registry-parity.test.ts` pins that they agree across eight
 * named module states. So through the real routes every traversal step finds
 * its check, and the fallback below is unreachable.
 *
 * IT STAYS ANYWAY, and is not dead code in the sense that matters: this is a
 * pure function taking two arguments, and nothing in its signature makes a
 * caller hand it a matched pair. `setup-wizard-view.test.ts` calls it with
 * mismatched fixtures on purpose. A step with no matching check still renders,
 * titled by its id: an operator seeing a bare id is a bug report, whereas
 * dropping the row silently would shorten the journey and move the percentage's
 * denominator without saying why.
 */
export function buildSetupWizardView(
  readiness: SetupReadiness,
  traversal: SetupWizardTraversal<SetupStepId>,
): SetupWizardView {
  const checksById = new Map<string, SetupReadinessCheck>();
  const categoryByStepId = new Map<string, SetupReadinessCategory>();
  for (const category of readiness.categories) {
    for (const check of category.checks) {
      checksById.set(check.id, check);
      categoryByStepId.set(check.id, category);
    }
  }

  const steps = traversal.steps.map((step): SetupWizardStepDetail => {
    const check = checksById.get(step.id);
    const category = categoryByStepId.get(step.id);
    return {
      id: step.id,
      title: check?.title ?? step.id,
      categoryId: category?.id ?? "other",
      categoryTitle: category?.title ?? "Other",
      description: check?.description ?? "",
      message: check?.message ?? "",
      details: check?.details ?? [],
      href: check?.href,
      links: check?.links ?? [],
      action: check?.action,
      required: check?.required ?? false,
      progress: check?.progress ?? "open",
      status: check?.status ?? "not_started",
      state: step.state,
      isReachable: step.isReachable,
      isStale: step.isStale,
      isDeferred: step.isDeferred,
      isDefaulted: step.isDefaulted,
      permissionArea: SETUP_STEP_PERMISSION_AREA[step.id],
    };
  });

  /*
    THE PANEL'S ROWS (D17, C15 #246) — a second small pass over the SAME two
    maps the steps above were built from, so a fact's title, message and details
    are the readiness check's, exactly as a step's are. The traversal already
    decided which entries these are and which of them hold publish shut; this
    reads those decisions rather than making them again.
  */
  const environment = traversal.environmentFacts.map((fact) =>
    buildSetupWizardEnvironmentRow(
      fact,
      checksById.get(fact.id),
      SETUP_STEP_PERMISSION_AREA[fact.id],
    ),
  );

  const groups = readiness.categories
    .map((category) => ({
      id: category.id,
      title: category.title,
      description: category.description,
      steps: steps.filter((step) => step.categoryId === category.id),
    }))
    // A category whose every step belongs to a disabled module contributes no
    // rail rows, so it contributes no heading either (D4).
    .filter((group) => group.steps.length > 0);

  return {
    groups,
    steps,
    environment,
    // Resolved against the rows rather than re-derived: the traversal owns the
    // rule, and a `find` that missed would be a silent unlock, so an id with no
    // row is dropped only because the traversal cannot produce one — every id
    // in `launchBlockedBy` came from `environmentFacts`, which `environment` is
    // a total mapping of.
    launchBlockedBy: traversal.launchBlockedBy.flatMap((id) => {
      const row = environment.find((candidate) => candidate.id === id);
      return row ? [row] : [];
    }),
    percentComplete: traversal.percentComplete,
    currentStepId: traversal.currentStepId,
    navigationFrontierStepId: traversal.navigationFrontierStepId,
    allResolved: traversal.allResolved,
    outstanding: steps
      .filter((step) => !checkIsComplete(step))
      .map((step) => ({
        id: step.id,
        title: step.title,
        deferred: step.isDeferred,
      })),
  };
}

/**
 * Complete for the OUTSTANDING list only. The traversal already decided this —
 * `state === "complete"` is its verdict, stale and current included — so this
 * reads the decision rather than making a second one.
 */
function checkIsComplete(step: SetupWizardStepDetail): boolean {
  return step.state === "complete";
}

/** The step an operator lands on: the current one, else the first applicable. */
export function resolveInitialStepId(
  view: SetupWizardView,
  requested?: string | null,
): SetupStepId | null {
  if (requested) {
    const match = view.steps.find(
      (step) => step.id === requested && step.isReachable,
    );
    if (match) return match.id;
  }
  return view.currentStepId ?? view.steps[0]?.id ?? null;
}
