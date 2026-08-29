import type { AdminPermissionArea, AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { EnvironmentRole, EnvironmentRoleDecidedBy } from "@/lib/environment-role";
import type { WithheldApplicationEmail } from "@/lib/environment-safety-withheld";
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
 *    appear in the readiness result's own category order. Resume and the
 *    frontier always follow the FLAT journey order, never the grouped one,
 *    because that is the order D2's frontier is computed in. (Back/Continue
 *    used to walk it too — retired in #252; the rail is the navigation now.)
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
  // support surfaces…
  //
  // …with `club-config` the exception, and it is one of the mechanical entries
  // rather than a judged edge once its `href` is read (#223 fix round). The
  // club's name, short name and hut-leader label are edited on
  // `/admin/appearance/identity`, which `ROUTE_AREA_PREFIXES` registers under
  // `content` and `/api/admin/club-identity` enforces at `content:view/edit`.
  // It read `support` while the check linked to `/admin/setup` — a page that
  // never held the editor, and holds no route to it at all once the legacy
  // surfaces are hidden.
  "club-config": "content",
  "club-time-zone": "support",
  "environment-role": "support",
  "runtime-env": "support",
  "auth-secret-strength": "support",
  "seed-admin": "membership",
  "feature-flags": "support",
  // The club's buildings (C6, #221). `/admin/lodges` — and the per-lodge setup
  // flow the step's per-lodge links point at — are registered under `lodge` in
  // `ROUTE_AREA_PREFIXES`, and `lodge` is also the area whose officers own the
  // buildings. Admission answer and editorial answer agree, so this is one of
  // the mechanical entries rather than one of the four judged edges above.
  lodges: "lodge",
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
 * WHERE A DEFAULTED STEP'S FACTS CAME FROM (D14/D15, #237 fix round).
 *
 * A step is `defaulted` when its readiness check passes and nobody confirmed it.
 * That is one state, and it has two completely different causes — which the
 * frame shipped one sentence for, and the sentence was false for half of them:
 *
 * > "…it was set when the site was installed, not chosen for your club. Check it
 * > below, change it if it is wrong…"
 *
 * True of a seeded timezone. FALSE of `environment-role`, where it called a
 * deliberate `APP_ENVIRONMENT_ROLE=production` declaration an unchosen installer
 * default — directly above the panel's own "declared PRODUCTION — the club's
 * live site". False again of `runtime-env`, which has no settings page at all,
 * so "change it below" pointed at a list of variable names.
 *
 * ## The two classes, and how a step joins one
 *
 * Read the step's readiness check and ask **what evidence satisfies it**:
 *
 * - `installed-default` — a row in THIS CLUB's database that the installer's
 *   seed filled in with a shipped value, editable on the page the step links to.
 *   The timezone, the age tiers, the cancellation tiers, the module switches, a
 *   bed count. "Set when the site was installed" is literally what happened.
 * - `read-from-deployment` — the deployment's environment variables, its
 *   committed configuration, or a provider connection whoever installed the site
 *   wired up. No seed invents a Stripe key or an `APP_ENVIRONMENT_ROLE`, the
 *   value may well have been chosen deliberately, and the wizard often cannot
 *   change it at all. So the copy asks the operator to REVIEW the facts rather
 *   than telling them nobody chose them.
 *
 * A `Record` over the id union rather than a substring heuristic on the step id
 * or a sniff at whether the check has an `href`, and for the same reason
 * {@link SETUP_STEP_PERMISSION_AREA} above is one: a step added by a later child
 * fails the TYPECHECK here until somebody decides which sentence it should show.
 * A heuristic would decide silently, and it decided wrongly for exactly the four
 * steps this fix exists for.
 *
 * It is also kept OFF `SetupWizardStepDetail`, unlike `permissionArea`. The
 * whole finding was a step being paired with the wrong copy, and a field on the
 * detail is a field a test fixture can set — so the pairing would then be
 * assertable only against itself. The frame reads this table by step id, so a
 * test naming `environment-role` exercises the real mapping and a swapped entry
 * here fails it.
 *
 * Two entries worth the sentence they cost:
 *
 * - **`club-config` is `read-from-deployment`.** Since this issue's own seed fix
 *   it can only pass through a committed primary `config/club.json` or a
 *   persisted identity row (a real edit, or a config-transfer import) — never a
 *   placeholder the installer invented. "Not chosen for your club" would be the
 *   false half of the old sentence again, about the club's own name.
 * - **`address-autocomplete` and `finance-dashboard` are `read-from-deployment`
 *   despite being module switches.** Neither can reach `complete` on the seeded
 *   switch alone: one also needs Addy credentials from the environment, the
 *   other a live operational Xero connection. The evidence that satisfies the
 *   check is the deployment's, so the copy is the deployment's.
 * - **`feature-flags` is `read-from-deployment`.** Its only reachable defaulted
 *   path is an administrator who has already saved Admin > Modules and never
 *   confirmed this step: the seed writes no `AdminModuleSettings` row at all,
 *   so a fresh install without one reads `warning`, not `defaulted`. The value
 *   was therefore chosen by a person — `environment-role`'s shape, not an
 *   installer placeholder. (The tail used to add "just not in the wizard",
 *   which C13 (#239) itself falsifies: its inline modules pane lets an
 *   operator save those same toggles from inside the wizard and never press
 *   "Mark this step done", reaching this exact `defaulted` state with the
 *   choice made IN the wizard. The clause is retired rather than amended,
 *   because the class was never decided by which screen wrote the value.)
 *   **The second half of this entry was retired by C13 (#239)**, and is
 *   recorded because it would otherwise read as a reason to reclassify: the
 *   class used to be argued partly from the step having no `href`, no `links`
 *   and therefore nothing for "check it below" to point at. There IS
 *   something below now — the module toggles themselves — and it changes
 *   nothing here, because the class is decided by where the evidence came
 *   from and that is unchanged.
 * - **`seed-admin` WAS `installed-default` and is now `read-from-deployment`
 *   (C20, #251, UAT R2-6).** The old entry read: "satisfied by a row the
 *   installer's own seed created in THIS CLUB'S database
 *   (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`), editable on the page it links
 *   to — class A's own written rule, applied literally". Its own parenthetical
 *   is what falsifies it. Class A is a row the seed filled in with a SHIPPED
 *   value; that admin's address and password are neither shipped nor invented
 *   by the installer — they are two environment variables of this deployment,
 *   supplied by whoever installed the site, which is class B's definition word
 *   for word. `club-config` is the same shape and was classified the same way
 *   for the same reason: a persisted row is still class B when the value in it
 *   came from the deployment rather than from a shipped default.
 *
 *   R2-6 found it from the other end — the `installed-default` banner promises
 *   "Check it below, change it if it is wrong", and this step had nothing
 *   below at all. C20 puts a pane there, and that does NOT rescue the old
 *   class: the pane CREATES a second administrator, so an operator told to
 *   "change it if it is wrong" still cannot see or change the seeded account
 *   the sentence is about (retiring it is deferred to its own decision). The
 *   `read-from-deployment` sentence asks them to check the facts are right for
 *   the club and then confirm, which is exactly what the pane supports. The
 *   class did not change because a pane arrived — it was misapplied from the
 *   start, and the pane is only what made the misapplication visible.
 */
export type SetupStepDefaultedEvidence =
  | "installed-default"
  | "read-from-deployment";

export const SETUP_STEP_DEFAULTED_EVIDENCE: Record<
  SetupStepId,
  SetupStepDefaultedEvidence
> = {
  "club-config": "read-from-deployment",
  "club-time-zone": "installed-default",
  "environment-role": "read-from-deployment",
  "runtime-env": "read-from-deployment",
  "auth-secret-strength": "read-from-deployment",
  "seed-admin": "read-from-deployment",
  "feature-flags": "read-from-deployment",
  lodges: "installed-default",
  "booking-policies": "installed-default",
  "membership-cancellation": "installed-default",
  "age-tiers": "installed-default",
  "seasons-rates": "installed-default",
  "site-style": "installed-default",
  stripe: "read-from-deployment",
  "email-ses": "read-from-deployment",
  sentry: "read-from-deployment",
  "address-autocomplete": "read-from-deployment",
  "xero-operational": "read-from-deployment",
  "finance-dashboard": "read-from-deployment",
  "xero-mappings": "installed-default",
};

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

/**
 * Whether this admin may see the step's INLINE PANE at all (C12, #238 fix
 * round F1).
 *
 * A pane is the step's own settings section, embedded — so it is gated on the
 * same area `SETUP_STEP_PERMISSION_AREA` already names for the "Open the
 * settings for this step" link, at `view`, the level every pane's own banner
 * already requires to render anything at all (`content: view` can inspect
 * `ClubIdentityPanel`; `edit` is what unlocks its Save).
 *
 * **Why the gate lives here and not on the pane component itself.** A viewer
 * who lacks even VIEW on the step's area — the shipped shape for
 * `ADMIN_BOOKINGS`, `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN`, none of which
 * carry `content` — was never offered a route to `/admin/appearance/identity`
 * in the first place, so `/api/admin/club-identity`'s GET 403s the instant
 * the pane mounts and asks for it. `ClubIdentityPanel` cannot save itself
 * from that: it has no `permissionMatrix` to read, only the session-derived
 * `useAdminAreaEditAccess`, which answers the EDIT question and never the
 * VIEW one this gate needs. The wizard client already holds `permissionMatrix`
 * from the server, so the mount site is where the answer is cheaply
 * available, and checking it there runs before the pane's own fetch ever
 * fires. Not mounting the pane leaves the step frame exactly as it rendered
 * before C12 — its own link-out and its own copy, unchanged.
 */
export function canViewSetupStepPane(
  matrix: AdminPermissionMatrix,
  stepId: SetupStepId,
): boolean {
  return matrix[SETUP_STEP_PERMISSION_AREA[stepId]] !== "none";
}
