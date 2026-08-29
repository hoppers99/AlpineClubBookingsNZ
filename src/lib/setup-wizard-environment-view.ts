import type { AdminPermissionArea } from "@/lib/admin-permissions";
import type { SetupReadiness } from "@/lib/setup-readiness";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardEnvironmentFact } from "@/lib/setup-wizard-entries";

/**
 * The SERVER-ENVIRONMENT half of the wizard's view model (epic #213, **D17**,
 * C15 #246).
 *
 * `setup-wizard-view.ts` marries a readiness result to a traversal. Since D17
 * that marriage produces TWO audiences — the operator's rail steps and the
 * deployment's environment facts — and this module owns the second one: the
 * remedy register, the row type the panel renders, and the one mapper that
 * turns a traversal fact plus its readiness check into a row.
 *
 * **Split out of `setup-wizard-view.ts` in C15's fix round, for size, and the
 * seam was chosen so that NOTHING was derived twice.** The traversal still
 * decides which entries are facts and which of them hold publish shut; the
 * readiness check still owns every word a person reads. This module holds the
 * types, the copy and the per-fact mapper — it makes no decision the layers
 * either side of it have already made.
 *
 * Pure: no React, no I/O, no `Date`. It is reachable from `"use client"`
 * modules, so it must stay that way — see the note on `auth-secret-strength`'s
 * remedy in `setup-wizard-view.ts` for the one way a plain string can break
 * that.
 */

/**
 * One readiness check. Declared structurally rather than imported, for the same
 * reason `setup-wizard-view.ts` declares its own: `setup-readiness.ts` exports
 * neither `SetupStepCheck` nor `SetupCategory`, and it is an epic watchpoint.
 * Deriving it here rather than importing the sibling's alias also keeps the
 * dependency between these two modules pointing ONE way — view -> environment
 * view — with no back edge, not even a type-only one.
 */
type SetupReadinessCheck =
  SetupReadiness["categories"][number]["checks"][number];

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
 * epic's view layer where that is the RIGHT shape rather than a shortcut. The
 * three tables in `setup-wizard-view.ts` and `setup-wizard-panes.tsx`
 * (`SETUP_STEP_PERMISSION_AREA`, `SETUP_STEP_DEFAULTED_EVIDENCE` and
 * `SETUP_STEP_PANES`) are total over `SetupStepId` because every step needs an
 * answer and a missing one is a decision nobody made. This table is keyed over
 * the same id union but is only ever consulted for entries whose registry `kind`
 * is `environment` — a remedy for `booking-policies` would be meaningless, and a
 * total Record would demand fifteen of them. The registry's own `kind` field is
 * what makes the partiality safe: it, not this table, decides which ids reach
 * here, and `environmentRegisterCoversEveryFact` in `setup-wizard-view.test.ts`
 * fails the build if an environment fact is ever declared without a row.
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
 * `environment-role`'s remedy names FOUR causes rather than one, and that is
 * deliberate rather than hedging. `environment-role.ts`'s own precedence rule
 * resolves BOTH "nothing declared it" and "declared, but the safer-override
 * record could not be read" to the same UNKNOWN answer — an unreadable override
 * fails closed even under a declared production. Telling the second operator to
 * set a variable that is already set sends them looking in the wrong place; the
 * launch panel's existing UNKNOWN block (`setup-wizard-launch-panel.tsx`) had
 * to learn the same lesson in #224's fix round, and this row is written to
 * agree with it. The third cause is the variable-name confusion the panel also
 * warns about. The FOURTH — a deployment that declares production and ALSO
 * declares a local capture mailbox (#3035) — reaches the gate through the
 * check's `warning` branch rather than its `blocked` one, and gets its own
 * `send` line through {@link SETUP_ENVIRONMENT_REMEDY_BY_STATUS} below: the
 * variable is already set correctly there, so "set APP_ENVIRONMENT_ROLE" would
 * be the wrong instruction.
 */
export const SETUP_ENVIRONMENT_REMEDY: Partial<
  Record<SetupStepId, SetupEnvironmentRemedy>
> = {
  "environment-role": {
    who: "Whoever runs your server sets this — it cannot be switched on from this screen, because a copy of the live database must never be able to declare itself the live site.",
    send: "Set APP_ENVIRONMENT_ROLE to production (the club's live site) or non-production (a copy) in this deployment's .env, then restart.",
    why: 'Until it is declared, email to members and writes to the club\'s Xero organisation do not run at all — guessing wrong would mean emailing real members from a test copy, so it fails closed instead. If the variable is already set, either the safer override\'s own database record is unreadable (repair with prisma migrate deploy or restored database access) or this deployment declares production while still capturing its mail, which holds every message back for a different reason. Note APP_RUNTIME_ROLE is a different variable — on the staging stack it holds the literal word "staging" — and changing it does not declare the environment role.',
  },
  "runtime-env": {
    who: "Whoever runs your server fixes this. Every one of these is a variable in the deployment's own configuration.",
    send: "One or more required variables are missing or malformed in this deployment's .env — the exact list is below. Set them and restart.",
    why: "These are the application's own contract with its deployment: the database connection, the site's own address, the cron secret the scheduled jobs authenticate with, and the seed administrator details. Every one of them must be set before the club opens, and that is exactly why this holds the site shut: the application RUNS without some of them — which is how you are reading this screen at all — so nothing else would ever catch it. A club that opened with its cron secret unset would look completely normal and have nothing scheduled running, so nothing that is supposed to happen overnight would happen.",
  },
  "auth-secret-strength": {
    who: "Whoever runs your server fixes this.",
    /*
      `openssl rand -base64 48` rather than the node one-liner `setup-readiness.ts`
      and `DEPLOYMENT.md` both print, and the reason is the SCANNER rather than
      the shell. This string is reachable from a "use client" module, and
      `client-server-boundary-census.test.ts` reads raw text: a literal
      containing the shape of a `require(...)` call is counted as an import edge
      to `crypto`, so the copy — which is only ever displayed — reported a Node
      built-in in the browser bundle. The remedy stays one line an operator can
      copy, and it is the same value DEPLOYMENT.md's own key-generation block
      names first for this variable.
    */
    send: "Generate a strong AUTH_SECRET for this deployment and restart. A good value: openssl rand -base64 48",
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
 * CAUSE-AWARE OVERRIDES, keyed by fact id and then by the readiness check's own
 * status (C15 #246 fix round, review finding F1).
 *
 * One entry today, and it exists because a gated check turned out to have more
 * branches than the remedy above was written for. `environment-role` reaches
 * this panel `blocked` when nothing has declared the role — which the base
 * remedy addresses — and also `warning` when the deployment DOES declare
 * production and simultaneously declares a local capture mailbox (#3035). Both
 * hold publish shut, because the gate is `!== "complete"`; only one of them is
 * fixed by setting `APP_ENVIRONMENT_ROLE`. Handing the second operator the
 * first one's line sends them to look at a variable that is already right.
 *
 * **Keyed on status rather than on the check's message**, so the coupling
 * between these two modules is a value the row already carries rather than a
 * sentence somebody might reword. That leaves one honest limit worth stating:
 * `environment-role` has a SECOND `warning` branch — "database state was not
 * checked" — which is reachable only when the caller supplies no database
 * snapshot. `npm run setup:check` without database access produces it and the
 * wizard's own route never can (`/api/admin/setup/wizard` always passes a
 * snapshot, and `resolveEnvironmentRole()` always answers), so no operator can
 * meet this override on that branch. `gatingStatusSets` in
 * `setup-wizard-view.test.ts` pins which branches really reach a gated fact, so
 * a future one that does not fit this shape fails loudly rather than quietly
 * collecting the wrong copy.
 */
export const SETUP_ENVIRONMENT_REMEDY_BY_STATUS: Partial<
  Record<
    SetupStepId,
    Partial<Record<SetupReadinessCheck["status"], SetupEnvironmentRemedy>>
  >
> = {
  "environment-role": {
    warning: {
      who: "Whoever runs your server fixes this. The environment role itself is already declared correctly — what is wrong is this deployment's mail transport.",
      send: "This deployment declares APP_ENVIRONMENT_ROLE=production but also USE_LOCAL_CAPTURE, so it is sending no member email at all. Set USE_AWS_SES or USE_SMTP_RELAY and remove USE_LOCAL_CAPTURE (or set it to false), then restart.",
      why: "A live site whose mail goes to a capture mailbox that forwards nothing is in a total mail outage: every message is refused rather than silently swallowed, because \"this is the club's live site\" and \"its mail goes nowhere\" cannot both be true. Messages whose contents are stored go out by themselves once the transport is fixed; ones carrying a sign-in link, a door code or a payment link keep no stored copy and are listed for a manual re-send under Admin -> Email.",
    },
  },
};

/**
 * One row of the Server-environment panel (epic #213, **D17**, C15 #246).
 *
 * The environment counterpart of `SetupWizardStepDetail`, and deliberately NOT
 * that type with fields blanked out. A step detail carries a journey state,
 * reachability, staleness, deferral and a defaulted flag — every one of which is
 * meaningless here, because nobody walks to a fact and nobody confirms one. A
 * row carrying them would invite a reader to ask what a "deferred" environment
 * fact is.
 *
 * What it does carry is what a person needs in order to get the fact FIXED, in
 * the shape R2-3 asked for: who does it, the one line to send them, then the
 * reasoning. `remedy` is the first two; `details` is the check's own list, which
 * is where the specifics already live.
 *
 * **What it deliberately does NOT carry: `links` and an inline pane.** A step
 * detail has both; a fact has neither, because there is nothing on this panel
 * for a per-lodge link to address and nothing for an operator to edit inline.
 * That is a silent-loss class rather than an omission — a check that grew a
 * `links` list, or a fact that acquired a pane, would simply not render — so
 * `setup-surface-registry-parity.test.ts` and `setup-wizard-panes.test.tsx`
 * each fail the build rather than leave it to be noticed.
 */
export interface SetupWizardEnvironmentRow {
  readonly id: SetupStepId;
  readonly title: string;
  readonly description: string;
  /**
   * The readiness check's own verdict. `complete` is a green row.
   *
   * This and {@link SetupWizardEnvironmentRow.blocksLaunch} come from ONE
   * source — the check's status — read once by the traversal for the gate and
   * once here for the badge, so a row can never say "Ready" and "Holds the site
   * shut" at the same time.
   */
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
  /**
   * The area governing the page this fact is REPORTED on, carried for the row's
   * "that page belongs to …" line. Not vestigial: it is read at runtime here
   * exactly as it is for a rail step.
   */
  readonly permissionArea: AdminPermissionArea;
}

/**
 * One fact, plus its readiness check, becomes one row.
 *
 * A pure mapper taking everything it needs, so it makes no lookup of its own:
 * the traversal already decided this entry is a fact and whether it holds
 * publish shut, and `buildSetupWizardView` already holds the check index and the
 * permission-area table. A `check` of `undefined` is the mismatched-fixture
 * case its caller documents — the row still renders, titled by its id.
 */
export function buildSetupWizardEnvironmentRow(
  fact: SetupWizardEnvironmentFact<SetupStepId>,
  check: SetupReadinessCheck | undefined,
  permissionArea: AdminPermissionArea,
): SetupWizardEnvironmentRow {
  const status = check?.status ?? "not_started";
  return {
    id: fact.id,
    title: check?.title ?? fact.id,
    description: check?.description ?? "",
    status,
    blocksLaunch: fact.blocksLaunch,
    message: check?.message ?? "",
    details: check?.details ?? [],
    remedy: resolveEnvironmentRemedy(fact.id, status),
    href: check?.href,
    action: check?.action,
    permissionArea,
  };
}

/**
 * The remedy for one fact in one state.
 *
 * A green row needs none — there is nothing to remedy, and printing "send this
 * to your deployer" beside a working deployment is how a panel trains its
 * reader to stop reading it. Otherwise the cause-aware override wins over the
 * base entry, which is what {@link SETUP_ENVIRONMENT_REMEDY_BY_STATUS} exists
 * for.
 */
function resolveEnvironmentRemedy(
  id: SetupStepId,
  status: SetupReadinessCheck["status"],
): SetupEnvironmentRemedy | null {
  if (status === "complete") return null;
  return (
    SETUP_ENVIRONMENT_REMEDY_BY_STATUS[id]?.[status] ??
    SETUP_ENVIRONMENT_REMEDY[id] ??
    null
  );
}
