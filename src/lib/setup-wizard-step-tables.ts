import type { AdminPermissionArea, AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { SetupStepId } from "@/lib/setup-step-registry";

/**
 * The setup wizard's STEP TABLES (epic #213, split out of `setup-wizard-view.ts`
 * for size, issue #268).
 *
 * Two exhaustive `Record<SetupStepId, …>` mappings — which admin permission
 * area governs a step's settings page, and why a defaulted step's evidence
 * counts as defaulted — plus the two predicates that read them and read
 * nothing else, `canChangeSetupProgress` and `canViewSetupStepPane`. Nothing
 * here assembles a view: `setup-wizard-view.ts` still marries a readiness
 * result to a traversal and imports `SETUP_STEP_PERMISSION_AREA` from here to
 * stamp `permissionArea` onto each rail row and each environment fact.
 *
 * **Split for the same reason C15 split `setup-wizard-environment-view.ts` out
 * of the same file, and the seam runs the same way: nothing is derived
 * twice.** The tables and the two predicates that consume them are the part of
 * the file that grows every time a step is added or a mapping is argued
 * about — the growth `setup-wizard-view.ts`'s own 700-line budget kept
 * colliding with (#268) — while "assemble the payload" is a fixed shape that
 * does not grow with the step count. Keeping each table adjacent to the
 * predicate that reads it, rather than splitting predicate from table, is
 * also why both moved together rather than the tables alone.
 *
 * Pure — no React, no I/O, no `Date` — same as its sibling.
 */

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
 * That rule produces two correct mappings that look surprising: `seed-admin`
 * is **membership** (created and repaired on `/admin/members`), and
 * `membership-cancellation` is **membership** too, now mechanically since its
 * `href` was corrected (C22, #260) from `/admin/setup/cancellation` — a
 * link-out hub under the `support`-prefixed `/admin/setup`, unreachable to a
 * membership-only officer — to the real editor, `/admin/membership-cancellation`.
 *
 * …and it has five edges where "the page the work is done on" does not settle
 * the answer by itself. Each is assigned by judgement, and named here so a later
 * reader does not mistake one for a mechanical derivation:
 *
 * - **`runtime-env` links nowhere.** Its readiness check carries no `href` at
 *   all (the work is editing `.env` and restarting), so there is no destination
 *   page to read an area off. `support` is the deployment-health area every
 *   other environment-shaped step uses.
 * - **`feature-flags` links nowhere either.** Its readiness check carries
 *   neither an `href` nor `links` — the same shape as `runtime-env` — so there
 *   is likewise no destination page to read an area off, and it takes `support`
 *   for the same reason. Named here since #270: the enumeration said "four" for
 *   long enough that the contract test's own allowlist was the only place this
 *   edge was written down.
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
 *
 * **Its five ENVIRONMENT-fact entries are still read at runtime** (D17, C15
 * #246), unlike the other two tables keyed over this union: the panel's row
 * carries `permissionArea` and states "that page belongs to …" beneath its
 * link. Nothing here went vestigial when the facts left the rail.
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
  // the mechanical entries rather than one of the five judged edges above.
  lodges: "lodge",
  // Booking rules.
  "booking-policies": "bookings",
  "membership-cancellation": "membership",
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
 * **Its five ENVIRONMENT-fact entries are VESTIGIAL since D17 (C15 #246), and
 * are kept for type-totality only.** "Defaulted" means a check passed and nobody
 * confirmed it; nobody can confirm a fact, facts never reach the step frame, and
 * the frame is the only reader of this table. So `environment-role`,
 * `runtime-env`, `auth-secret-strength`, `email-ses` and `sentry` can no longer
 * be reached through it at runtime. They stay because this is a total `Record`
 * and deleting an entry would be a typecheck error — and because a fact
 * reclassified back to `operator` would need its answer again, from somebody who
 * had thought about it rather than from a default.
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
