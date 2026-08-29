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
 * - **`seed-admin` is `installed-default`.** Its check is satisfied by a row
 *   the installer's own seed created in THIS CLUB'S database
 *   (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`), editable on the page it links
 *   to (`/admin/members`) — class A's own written rule, applied literally
 *   rather than by a heuristic about what "installed" tends to look like.
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
  "seed-admin": "installed-default",
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
 * WHAT TO DO ABOUT AN ENVIRONMENT FACT THAT IS NOT GREEN (epic #213, **D17**,
 * C15 #246) — the operator-first remedy register UAT round 2 finding R2-3 asked
 * for.
 *
 * R2-3's complaint was that the wizard told an administrator what was wrong with
 * a deployment and then offered them no way to act on it, as though they had
 * simply not got round to it. The fix is not softer wording: it is to answer the
 * question the reader actually has, in this order.
 *
 * - `who` — **who does this**, said first and said plainly. For every one of
 *   these it is not the person reading the screen, and saying so immediately is
 *   what turns "another thing I have failed to do" into "a message I need to
 *   send". It is the single most important line on the row.
 * - `send` — **the one line to send them.** Written to be copied into an email
 *   or a chat message and acted on by somebody who is not looking at this
 *   screen, so it names the variable, the file and the restart, and it assumes
 *   no knowledge of the wizard.
 * - `why` — **the consequence, collapsed.** Rendered behind a disclosure,
 *   because an operator forwarding a line to their deployer does not need it,
 *   and an operator deciding whether it is urgent does.
 */
export interface SetupEnvironmentRemedy {
  readonly who: string;
  readonly send: string;
  readonly why: string;
}

/**
 * The register itself, keyed by environment-fact id.
 *
 * A `Partial` Record rather than a total one, and this is the one place in this
 * file where that is the RIGHT shape rather than a shortcut. The other three
 * tables here (`SETUP_STEP_PERMISSION_AREA`, `SETUP_STEP_DEFAULTED_EVIDENCE`,
 * and `SETUP_STEP_PANES` next door) are total over `SetupStepId` because every
 * step needs an answer and a missing one is a decision nobody made. This table
 * is keyed over the same id union but is only ever consulted for entries whose
 * registry `kind` is `environment` — a remedy for `booking-policies` would be
 * meaningless, and a total Record would demand fifteen of them. The registry's
 * own `kind` field is what makes the partiality safe: it, not this table,
 * decides which ids reach here, and `environmentRegisterCoversEveryFact` in
 * `setup-wizard-view.test.ts` fails the build if an environment fact is ever
 * declared without a row.
 *
 * ## Where these words come from
 *
 * Each `send` line is the operator-facing restatement of what the readiness
 * check itself found, NOT a second source of truth about the deployment. The
 * check's own `details` still render beside it and still carry the specifics
 * (which variable, which fault) — `runtime-env`, for instance, already produces
 * one "Fix …" line per fault. So these sentences say who and roughly what;
 * the details say exactly what.
 *
 * `environment-role`'s remedy names THREE causes rather than one, and that is
 * deliberate rather than hedging. `environment-role.ts`'s own precedence rule
 * resolves BOTH "nothing declared it" and "declared, but the safer-override
 * record could not be read" to the same UNKNOWN answer — an unreadable override
 * fails closed even under a declared production. Telling the second operator to
 * set a variable that is already set sends them looking in the wrong place; the
 * launch panel's existing UNKNOWN block (`setup-wizard-launch-panel.tsx`) had
 * to learn the same lesson in #224's fix round, and this row is written to
 * agree with it. The third cause is the variable-name confusion the panel also
 * warns about.
 */
export const SETUP_ENVIRONMENT_REMEDY: Partial<
  Record<SetupStepId, SetupEnvironmentRemedy>
> = {
  "environment-role": {
    who: "Whoever runs your server sets this — it cannot be switched on from this screen, because a copy of the live database must never be able to declare itself the live site.",
    send: "Set APP_ENVIRONMENT_ROLE to production (the club's live site) or non-production (a copy) in this deployment's .env, then restart.",
    why: "Until it is declared, email to members and writes to the club's Xero organisation do not run at all — guessing wrong would mean emailing real members from a test copy, so it fails closed instead. If the variable is already set, the safer override's own database record may be unreadable instead: repair with prisma migrate deploy or restored database access. Note APP_RUNTIME_ROLE is a different variable — on the staging stack it holds the literal word \"staging\" — and changing it does not declare the environment role.",
  },
  "runtime-env": {
    who: "Whoever runs your server fixes this. Every one of these is a variable in the deployment's own configuration.",
    send: "One or more required variables are missing or malformed in this deployment's .env — the exact list is below. Set them and restart.",
    why: "These are the application's own contract with its deployment: the database connection, the site's own address, the cron secret the scheduled jobs authenticate with, and the seed administrator details. The site runs without some of them, which is why you can read this screen at all — but a club that opens with its cron secret unset has no scheduled jobs running, so nothing that happens overnight happens.",
  },
  "auth-secret-strength": {
    who: "Whoever runs your server fixes this.",
    send: "Generate a strong AUTH_SECRET for this deployment and restart. A good value: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    why: "Sign-in, two-factor authentication and the encryption of every stored credential all derive from this one secret. Until it is strong, this site refuses to store a Stripe or Xero credential at all — so the payment and accounting steps of this wizard cannot be completed.",
  },
  "email-ses": {
    who: "Whoever runs your server sets this up.",
    send: "This deployment has no working email transport — set EMAIL_FROM and either the SES or the SMTP relay settings, then restart.",
    why: "Nothing that needs to reach a member by email will: booking confirmations, membership applications, password resets. The club can still be set up and opened without it, which is why this does not hold the site shut, but it should be fixed before real members use it.",
  },
  sentry: {
    who: "Optional, and whoever runs your server sets it up if you want it.",
    send: "If you want error reports from this site, set SENTRY_DSN, NEXT_PUBLIC_SENTRY_DSN, SENTRY_ORG and SENTRY_PROJECT in this deployment's .env, then restart.",
    why: "Sentry collects the technical detail of an error when something goes wrong, so a fault can be diagnosed from the report rather than from a member's description of it. Nothing about running the club depends on it.",
  },
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

/**
 * One row of the Server-environment panel (epic #213, **D17**, C15 #246).
 *
 * The environment counterpart of {@link SetupWizardStepDetail}, and deliberately
 * NOT that type with fields blanked out. A step detail carries a journey state,
 * reachability, staleness, deferral and a defaulted flag — every one of which is
 * meaningless here, because nobody walks to a fact and nobody confirms one. A
 * row carrying them would invite a reader to ask what a "deferred" environment
 * fact is.
 *
 * What it does carry is what a person needs in order to get the fact FIXED, in
 * the shape R2-3 asked for: who does it, the one line to send them, then the
 * reasoning. `remedy` is the first two; `details` is the check's own list, which
 * is where the specifics already live.
 */
export interface SetupWizardEnvironmentRow {
  readonly id: SetupStepId;
  readonly title: string;
  readonly description: string;
  /** The readiness check's own verdict. `complete` is a green row. */
  readonly status: SetupReadinessCheck["status"];
  /** Whether this row is holding the publish button shut. */
  readonly blocksLaunch: boolean;
  /**
   * The check's message — the green sentence, or what is wrong. Rendered
   * whatever the status, so a healthy deployment reads as a statement of fact
   * rather than as an absence of complaint.
   */
  readonly message: string;
  /** The check's own detail list: the specific variables, the specific faults. */
  readonly details: readonly string[];
  /**
   * The OPERATOR-FIRST remedy, and `null` on a green row.
   *
   * Named separately from `details` because it answers a different question.
   * The check's details say what is wrong with the deployment; this says what
   * the person reading the wizard should DO about it, and the honest answer is
   * almost always "you cannot fix this from here — send this line to whoever
   * runs your server". See {@link SETUP_ENVIRONMENT_REMEDY}.
   */
  readonly remedy: SetupEnvironmentRemedy | null;
  readonly href?: string;
  /**
   * The fact's provider test, when its readiness check declares one.
   *
   * **This field is why D17 does not silently delete two controls.** `email-ses`
   * and `sentry` both declare a `provider-test` action ("Test Email", "Test
   * Sentry"), and until D17 those reached an operator through their wizard
   * STEP. Moving the fact off the rail without carrying its action here would
   * remove a live capability rather than relocate it — which is exactly the
   * regression `setup-surface-registry-parity.test.ts`'s ACTION guard was
   * written for in #223, and why that guard now spans both surfaces. It is also
   * the most useful control on the panel: it is how an operator finds out
   * whether the deployer's fix actually worked, without leaving the wizard.
   */
  readonly action?: SetupReadinessCheck["action"];
  readonly permissionArea: AdminPermissionArea;
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
  const environment = traversal.environmentFacts.map(
    (fact): SetupWizardEnvironmentRow => {
      const check = checksById.get(fact.id);
      return {
        id: fact.id,
        title: check?.title ?? fact.id,
        description: check?.description ?? "",
        status: check?.status ?? "not_started",
        blocksLaunch: fact.blocksLaunch,
        message: check?.message ?? "",
        details: check?.details ?? [],
        // A green row needs no remedy — there is nothing to remedy, and
        // printing "send this to your deployer" beside a working deployment is
        // how a panel trains its reader to stop reading it.
        remedy:
          check?.status === "complete"
            ? null
            : (SETUP_ENVIRONMENT_REMEDY[fact.id] ?? null),
        href: check?.href,
        action: check?.action,
        permissionArea: SETUP_STEP_PERMISSION_AREA[fact.id],
      };
    },
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
