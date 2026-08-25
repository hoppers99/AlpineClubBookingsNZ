import type { AdminPermissionArea, AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { SetupReadiness } from "@/lib/setup-readiness";
import type { SetupStepId } from "@/lib/setup-step-registry";
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
 *    appear in the readiness result's own category order. Back/Continue always
 *    follow the FLAT journey order, never the grouped one, because that is the
 *    order D2's frontier is computed in.
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
 * Which admin permission area governs each step's **settings page** (epic #213
 * **D12**).
 *
 * ## What this map is NOT used for
 *
 * It does **not** gate the wizard's three progress transitions. Those call
 * `PATCH /api/admin/setup/progress`, which the server enforces at
 * `support: edit` through the `/api/admin/setup` prefix in `ROUTE_AREA_PREFIXES`
 * — so gating the buttons per-step-area was wrong in both directions at once,
 * with role bundles this product actually ships: a bookings-edit officer without
 * support saw an enabled "Mark this step done" that 403s, and a support-edit
 * officer without bookings saw a disabled button for a transition the server
 * would have accepted. `canChangeSetupProgress` is the gate; it asks the one
 * question the server asks.
 *
 * ## What it IS used for
 *
 * The step frame's **"Open the settings for this step"** link, whose destination
 * is an ordinary admin page governed by an ordinary area — and, when C6 (lodges)
 * and C7 (styling) grow in-frame editors, those editors, which really will write
 * through their own area's API.
 *
 * THE RULE, stated once: a step's area is the area that governs **the admin page
 * the step's work is actually done on** — the page its readiness check links to.
 * Not the area of the API that records the step's progress, and not the area of
 * `/admin/setup` itself.
 *
 * That rule produces two mappings that look surprising and are correct:
 *
 * - `seed-admin` is **membership**, because the administrator account is created
 *   and repaired on `/admin/members`.
 * - `membership-cancellation` is **support**, because its editor lives on
 *   `/admin/setup/cancellation`, and `/admin/setup` is a support-area prefix —
 *   a membership officer without support cannot open that page at all.
 *
 * …and it has four edges where "the page the work is done on" does not settle
 * the answer by itself. Each is assigned by judgement, and named here so a later
 * reader does not mistake one for a mechanical derivation:
 *
 * - **`runtime-env` links nowhere.** Its readiness check carries no `href` at
 *   all (the work is editing `.env` and restarting), so there is no destination
 *   page to read an area off. `support` is the deployment-health area every
 *   other environment-shaped step uses.
 * - **`finance-dashboard` points at `/finance`, which is not an admin route.**
 *   It is the member-facing finance surface, so `ROUTE_AREA_PREFIXES` has
 *   nothing to say about it; `finance` is the area whose officers read it.
 * - **`club-time-zone` points at `/admin/club-time`, which is registered under
 *   `support` but is Full-Admin-enforced IN ROUTE** — both verbs of
 *   `/api/admin/club-time-zone` use `requireAdmin({ permission: false })`, and
 *   the page itself refuses a non-full admin. So a support officer's `edit` on
 *   this map does not mean they can complete that step's work; the page tells
 *   them so on arrival, which is the honest place for a rule the area system
 *   cannot express.
 * - **`environment-role` points at `/admin/environment`, which is the same
 *   shape as `club-time-zone`** (ENV-SAFETY 1, #3034). The path is registered
 *   under `support` in `ROUTE_AREA_PREFIXES`, so `support` is the admission
 *   answer — but both the page and `/api/admin/environment-safety`'s write are
 *   Full-Admin-enforced IN ROUTE, so this entry is ADMISSION AREA ONLY and a
 *   support officer's `edit` here does not mean they can change the safer
 *   override. Reading the role is genuinely `support:view` (it travels on the
 *   readiness check), which is why `support` is right rather than merely
 *   convenient; the Full-Admin half is the page's to enforce and it does.
 *
 * A `Record` over the id union rather than a lookup with a fallback, on purpose:
 * a step added by a later child (C3 contributes module-owned steps) fails the
 * TYPECHECK here until somebody decides which officer owns it. A default would
 * quietly make that decision as "support", which is the widest area in the
 * product.
 */
export const SETUP_STEP_PERMISSION_AREA: Record<
  SetupStepId,
  AdminPermissionArea
> = {
  // Foundation — the install checklist, modules and system health are all
  // support surfaces.
  "club-config": "support",
  "club-time-zone": "support",
  "environment-role": "support",
  "runtime-env": "support",
  "auth-secret-strength": "support",
  "seed-admin": "membership",
  "feature-flags": "support",
  // Booking rules.
  "booking-policies": "bookings",
  "membership-cancellation": "support",
  "age-tiers": "bookings",
  "seasons-rates": "bookings",
  // Website styling (C7, #222). Its settings page, `/admin/site-style`, is
  // registered under `content` in `ROUTE_AREA_PREFIXES` — the same area that
  // governs page content and site chrome — so `content` is both the admission
  // answer and a genuine match for "the area that governs the page the work is
  // done on".
  "site-style": "content",
  // Operational integrations. Stripe and Xero setup live on the finance-area
  // Integrations hub (`/admin/stripe/setup`, `/admin/xero/setup`); email,
  // Sentry and the address-autocomplete module switch do not.
  stripe: "finance",
  "email-ses": "support",
  sentry: "support",
  "address-autocomplete": "support",
  "xero-operational": "finance",
  // Finance.
  "finance-dashboard": "finance",
  "xero-mappings": "finance",
};

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
}

export interface SetupWizardRailStep {
  readonly id: SetupStepId;
  readonly title: string;
  readonly state: SetupWizardStepState;
  readonly isReachable: boolean;
  readonly isStale: boolean;
  readonly isDeferred: boolean;
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
  readonly required: boolean;
  readonly progress: SetupReadinessCheck["progress"];
  readonly status: SetupReadinessCheck["status"];
}

export interface SetupWizardView {
  /** Rail rows, grouped by readiness category. Empty groups are dropped. */
  readonly groups: readonly SetupWizardRailGroup[];
  /** Every applicable step in JOURNEY order — what Back/Continue walk. */
  readonly steps: readonly SetupWizardStepDetail[];
  /** D7's percentage, copied from the traversal and never recomputed. */
  readonly percentComplete: number;
  readonly currentStepId: SetupStepId | null;
  readonly navigationFrontierStepId: SetupStepId | null;
  /** D9's launch-panel unlock. Straight from the traversal (#219 F9). */
  readonly allResolved: boolean;
  /** Titles of everything not complete — mockup 6 states these plainly. */
  readonly outstanding: readonly { id: SetupStepId; title: string; deferred: boolean }[];
}

/**
 * Marry one readiness result to one traversal.
 *
 * The traversal's step set is a SUBSET of the readiness result's checks (it
 * excludes a disabled module's steps and readiness does not — until C8 wires the
 * cards to the registry too), so every traversal step normally finds its check.
 * A step with no matching check still renders, titled by its id: an operator
 * seeing a bare id is a bug report, whereas dropping the row silently would
 * shorten the journey and move the percentage's denominator without saying why.
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
      required: check?.required ?? false,
      progress: check?.progress ?? "open",
      status: check?.status ?? "not_started",
      state: step.state,
      isReachable: step.isReachable,
      isStale: step.isStale,
      isDeferred: step.isDeferred,
      permissionArea: SETUP_STEP_PERMISSION_AREA[step.id],
    };
  });

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

export interface SetupWizardNeighbours {
  readonly previous: SetupWizardStepDetail | null;
  readonly next: SetupWizardStepDetail | null;
}

/**
 * The Back/Continue targets for a step, in FLAT journey order.
 *
 * The two are deliberately ASYMMETRIC in what they return, because the caller
 * needs to distinguish different things at the two ends:
 *
 * - `next` is returned whether or not it is reachable; the caller disables
 *   Continue on `next.isReachable === false`, which is D2's "you cannot jump
 *   ahead past a step that is not done" expressed as a control rather than as a
 *   redirect. Returning `null` instead would make a blocked Continue and the end
 *   of the journey indistinguishable, and the end of the journey is where D9's
 *   launch panel lives.
 * - `previous` is the nearest EARLIER REACHABLE step, skipping over any that are
 *   not, and `null` when there is none — so Back is simply disabled. Handing back
 *   `steps[index - 1]` unconditionally was a silent teleport: the client's
 *   fallback resolves an unreachable target back to `currentStepId`, so pressing
 *   Back on a step whose immediate predecessor was locked moved the operator
 *   somewhere they did not ask to go, with nothing on screen saying so. Behind
 *   the frontier an unreachable predecessor is normally impossible — everything
 *   before the frontier is walkable — but a *stale* step re-caps the frontier
 *   under it (#219 F2), which puts later, already-reachable steps in front of a
 *   locked one, and that is not an exotic state: it is what an upgrade does.
 */
export function setupWizardNeighbours(
  view: SetupWizardView,
  stepId: SetupStepId | null,
): SetupWizardNeighbours {
  const index = view.steps.findIndex((step) => step.id === stepId);
  if (index === -1) return { previous: null, next: null };
  let previousIndex = index - 1;
  while (previousIndex >= 0 && !view.steps[previousIndex].isReachable) {
    previousIndex -= 1;
  }
  return {
    previous: previousIndex >= 0 ? view.steps[previousIndex] : null,
    next: view.steps[index + 1] ?? null,
  };
}

/**
 * Whether this admin may change a step's PROGRESS — mark it done, skip it, or
 * reopen it (D12).
 *
 * **This asks the question the server asks, and takes no step argument.** All
 * three transitions are one API — `PATCH /api/admin/setup/progress` — and every
 * route under `/api/admin/setup` resolves to the `support` area, so `support`
 * edit is the whole answer for every step in the journey. A per-step gate would
 * disagree with the server in both directions on role bundles this product
 * ships (see `SETUP_STEP_PERMISSION_AREA` above), and the readiness cards on
 * `/admin/setup` — the same transitions, the same API — already gate exactly
 * here.
 *
 * The JOURNEY gate is a separate question and stays separate: `isReachable` (D2)
 * says the wizard is not letting anybody jump ahead, whoever they are.
 * `setup-wizard-traversal.ts` is deliberately permission-agnostic and says so;
 * this is the other half it names.
 */
export function canChangeSetupProgress(matrix: AdminPermissionMatrix): boolean {
  return matrix.support === "edit";
}
