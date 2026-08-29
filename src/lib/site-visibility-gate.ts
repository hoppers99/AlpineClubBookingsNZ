import { NextResponse } from "next/server";
import { resolveEnvironmentRole } from "@/lib/environment-role";
import { readWithheldApplicationEmail } from "@/lib/environment-safety-withheld";
import {
  buildAuthSecretStrengthCheck,
  buildEnvironmentRoleCheck,
  buildRuntimeEnvCheck,
  normalizeSetupProgress,
  type SetupStepCheck,
} from "@/lib/setup-readiness";
import { resolveEnvironmentRemedy } from "@/lib/setup-wizard-environment-view";

/**
 * The LAUNCH gate on MAKING THE PUBLIC SITE VISIBLE — `INV-CONFIG-006`
 * (epic #213, C16/#247; widened to all three facts by C15's fix round on the
 * same issue), consuming `INV-CONFIG-003`'s canonical role and the SAME three
 * registry-declared `launchGate: "blocks-until-complete"` facts the wizard's
 * launch panel gates on client-side (`environment-role`, `runtime-env`,
 * `auth-secret-strength` — see `SetupStepLaunchGate` in
 * `setup-step-registry.ts`).
 *
 * ## Why this widened at all (D17, review finding F4)
 *
 * #247 gated one fact: the environment role being UNKNOWN. D17 decided all
 * three registry-gating facts hold the wizard's OWN publish button shut
 * (`setup-wizard-launch-panel.tsx`'s `launchBlockedBy`), which left a real gap
 * this module alone could not see: a hand-rolled `POST
 * /api/admin/site-style/complete-setup` — or the legacy `PUT
 * /api/admin/site-style` with `completeSetup: true` — still published a site
 * whose runtime environment was missing required variables, or whose
 * AUTH_SECRET was weak, because the SERVER only ever asked about the role. The
 * client control and the server's own enforcement of it had quietly diverged.
 * This widening closes that gap by asking the server the SAME question the
 * client already renders an answer for.
 *
 * Publishing is the moment an installation stops showing the holding screen and
 * starts serving the club's public pages to anybody who visits it. Until #247
 * the only thing standing between a `curl` and that transition was
 * `content: edit`, so a copy restored from a production dump — the premise the
 * whole environment-safety epic (#2986) is built on — could be pointed at the
 * public by a content officer, or by a script, with nothing having said which
 * installation it is.
 *
 * ## The polarity, stated because it is the whole point
 *
 * `resolveEnvironmentRole()` NEVER THROWS and never guesses. Its third answer,
 * `UNKNOWN`, already IS the fail-closed one: an absent declaration, a
 * declaration it refuses to interpret, and an override it could not read from
 * the database all resolve to `UNKNOWN` rather than to a confident
 * `PRODUCTION`. So this gate needs no error handling of its own — it refuses on
 * `UNKNOWN` and that single branch covers "nobody said", "somebody typed it
 * wrong" and "the database did not answer" alike.
 *
 * That direction is deliberate and it is the cheap side to be wrong on. Refusing
 * an installation that really is the club's live site costs an operator one
 * environment variable and a retry; publishing from an undeclared copy puts a
 * second, wrong copy of the club's site in front of the public and there is no
 * transition back that the public did not already see.
 *
 * A declared `NON_PRODUCTION` installation PUBLISHES FREELY. That is not an
 * oversight: an internal staging site is legitimately visible and non-production
 * forever. The gate is on the role being UNKNOWN, never on it being a copy —
 * which is the precise form of D9's "two independent levers" that survives this
 * change. The levers are independent of each other's ANSWER; they were never
 * independent of there being one. The wizard's launch panel and
 * `docs/guides/setup.md` both state it that way, and both were corrected here
 * from the unqualified claim.
 *
 * ## Why it is a module and not two copies of four lines
 *
 * There are TWO REQUEST-PATH writers of `ClubTheme.completedAt` — two ways a
 * caller arriving over HTTP can publish — and the issue's own description of the
 * hazard ("a content officer, or curl, can publish the public site with the
 * environment role UNKNOWN") is true of both:
 *
 *  - `POST /api/admin/site-style/complete-setup`, the wizard launch panel's
 *    one-column transition; and
 *  - `PUT /api/admin/site-style` with `completeSetup: true`, which
 *    `saveClubTheme` still honours for the legacy site-style wizard's
 *    "Finish setup" button.
 *
 * Gating only the first would have left the second as a one-line bypass of the
 * gate, so both call this and the refusal cannot drift between them.
 * `site-visibility-gate-census.test.ts` scans `src/` for the completion writers
 * and fails a third route that reaches one of them without asking here, because
 * "both call it" is a claim that goes stale the moment somebody adds a route.
 *
 * ## The two DIRECT-DATABASE writers, which this gate deliberately does not see
 *
 * "Request-path" is a real qualification and not a hedge. Two paths outside the
 * application stamp `completedAt` by writing the row, and neither is in scope:
 *
 *  - `prisma/seed.ts` under `SEED_THEME_COMPLETE=1`, which stamps the default
 *    palette complete so a seeded stack renders the real public chrome; and
 *  - `e2e/helpers/setup-state.ts`, which flips it both ways on the staging
 *    database for the `pre-setup` Playwright project — the app can complete
 *    setup and can never un-complete it, so there is no route to drive.
 *
 * Both are deliberate operator/harness tools that run with database credentials
 * in hand, against a database they were pointed at on purpose. A gate here could
 * not stop either one and should not try: somebody who can write the row can
 * write the row, and the thing being defended against is a *request* — a content
 * officer or a `curl` — reaching the transition through the application.
 *
 * ## One derivation, deliberately NOT the full readiness snapshot
 *
 * The wizard's own `/api/admin/setup/wizard` route computes `launchBlockedBy`
 * from a FULL `SetupDatabaseSnapshot` — `getSetupDatabaseSnapshot()`, roughly
 * twenty parallel queries covering every readiness check in the registry,
 * because that route also renders the other seventeen. This gate does not: it
 * calls the SAME THREE CHECK FUNCTIONS (`buildEnvironmentRoleCheck`,
 * `buildRuntimeEnvCheck`, `buildAuthSecretStrengthCheck`, all exported from
 * `setup-readiness.ts` for exactly this) directly, over the narrow inputs each
 * one actually reads:
 *
 *  - `buildEnvironmentRoleCheck` needs `resolveEnvironmentRole()` (one
 *    env-var read plus one settings-row lookup) and
 *    `readWithheldApplicationEmail()` (two or three `emailLog` aggregates,
 *    fails soft to "not recorded" rather than throwing) — the same two calls
 *    `getSetupDatabaseSnapshot()` makes for this one field, pulled out on
 *    their own rather than behind the other nineteen queries that happen to
 *    live beside them there;
 *  - `buildRuntimeEnvCheck` and `buildAuthSecretStrengthCheck` read only
 *    `process.env` and touch no database at all.
 *
 * So a publish attempt costs at most a handful of lightweight reads rather
 * than the wizard's full snapshot, while producing IDENTICAL verdicts to it —
 * this is still one derivation, not a second one written by hand: every
 * `.status` this gate branches on is computed by the exact function the wizard
 * calls for the same fact, over the exact same inputs. What is skipped is
 * everything the wizard's other seventeen checks need and this gate's three
 * facts never read.
 */

/**
 * The operator-facing refusal. THREE causes, THREE repairs — one each, because
 * the resolver's UNKNOWN covers three faults and only two of them are repaired
 * by touching a declaration:
 *
 *  - nothing declared the role, and
 *  - the declaration is a word the resolver will not interpret — both fixed by
 *    setting `APP_ENVIRONMENT_ROLE`, or by switching the safer override on for a
 *    copy; and
 *  - **the safer override could not be READ** — an un-migrated database, a
 *    Prisma client generated before the model existed, or the database refusing
 *    the query. This one is reachable on an installation that is otherwise
 *    serving, and neither of the first two repairs touches it: an operator who
 *    has already set `APP_ENVIRONMENT_ROLE` correctly, and is told only to set
 *    it, has been sent to check the one thing that is not wrong.
 *
 * An earlier version named two and said "which of the two is missing", which
 * `docs/guides/setup.md`'s own troubleshooting row had already got right. The
 * repair wording follows `environment-role.ts`'s `UNREADABLE_OVERRIDE_NOTE` so
 * an operator meets one instruction rather than two phrasings of it.
 *
 * It names the invariant it enforces, per AGENTS.md ("Guards should name the id
 * they enforce in their failure message") and after `INV-CONFIG-005`'s Xero
 * refusals, which do the same. This ONE constant is what both writers of
 * `ClubTheme.completedAt` return, so the id reaches both 409s.
 *
 * Secret-free by construction: it names an environment variable, a screen and a
 * migration command, never a value, a connection string or a provider
 * identifier.
 */
export const SITE_VISIBILITY_UNKNOWN_ROLE_ERROR =
  "The public site was not made visible and nothing was changed: this " +
  "installation has not been confirmed as production or non-production. Set " +
  "APP_ENVIRONMENT_ROLE in this deployment's environment, or switch the safer " +
  "override on at Admin › Environment if this is a copy. If that is already " +
  "done, the override itself could not be read: apply the pending migrations " +
  "(prisma migrate deploy) or restore database access. Then try again. " +
  "Admin › Environment reports which of the three it is (INV-CONFIG-006).";

/**
 * The operator-facing refusal for `runtime-env` or `auth-secret-strength`
 * blocking launch — the two facts D17 adds to this gate.
 *
 * Built from `SETUP_ENVIRONMENT_REMEDY` / `SETUP_ENVIRONMENT_REMEDY_BY_STATUS`
 * via `resolveEnvironmentRemedy` (the SAME lookup `setup-wizard-environment-view.ts`
 * uses for the Server-environment panel's own rows) rather than a second
 * hand-written paragraph, so the 409 body and the panel can never say two
 * different things about the same fault. `environment-role` deliberately does
 * NOT go through this path — see {@link SITE_VISIBILITY_UNKNOWN_ROLE_ERROR}
 * and its status-aware sibling below for why that one fact keeps its own
 * long-standing wording.
 *
 * `remedy` is asserted non-null with a fallback rather than a thrown error:
 * every id this is called for is a real key in `SETUP_ENVIRONMENT_REMEDY`
 * (pinned by `environmentRegisterCoversEveryFact` in
 * `setup-wizard-view.test.ts`), and `status` is never `"complete"` here — the
 * caller only reaches this on a blocking check. The fallback exists so a
 * narrowing gap in that guarantee degrades to a less specific 409 rather than
 * a 500 on the one path that most needs to answer.
 */
function launchGateRefusalMessage(check: SetupStepCheck): string {
  const remedy = resolveEnvironmentRemedy(check.id, check.status);
  if (!remedy) {
    return (
      "The public site was not made visible and nothing was changed: " +
      `${check.title} is not ready. The setup wizard's About this server ` +
      "panel (Admin › Setup › Open the setup wizard) reports the detail " +
      "(INV-CONFIG-006)."
    );
  }
  return (
    `The public site was not made visible and nothing was changed: ${remedy.send} ` +
    `${remedy.why} The setup wizard's About this server panel (Admin › Setup › ` +
    `Open the setup wizard) reports this deployment's status (INV-CONFIG-006).`
  );
}

/**
 * `null` when the site may be published, or the refusal response when it may
 * not.
 *
 * 409 rather than 403: the caller has the privilege, and the request will
 * succeed unchanged once the installation is declared. It is a conflict with the
 * state of the installation, not a permission failure — and the two clients
 * distinguish them (`site-style-wizard.tsx` renders the admin forbidden notice
 * on a 403 and the server's message on anything else).
 *
 * REFUSE BEFORE WRITING. Both callers invoke this before their first write, so a
 * refusal leaves no row, no cache invalidation and no audit trail behind it —
 * the same no-write refusal shape C2 (#217) settled for the progress route.
 *
 * ## Ordering is deterministic and load-bearing (D17, C15 fix round on #247)
 *
 * `environment-role` is asked first, always: every other fact is a claim about
 * THIS deployment's own configuration, and nothing about that is worth
 * reporting accurately to an operator who does not yet know whether this
 * installation is the club's live site or a copy. `runtime-env` is asked
 * second — a deployment missing its database URL or seed-admin contract is not
 * one whose auth-secret strength is the most useful thing to say next — and
 * `auth-secret-strength` last. The first fact that is not `"complete"` decides
 * the whole response; the other two are never even computed once one refuses,
 * which is why `runtime-env`/`auth-secret-strength` are read from `process.env`
 * only after the role check passes.
 *
 * This is a single-cause response by design, not an aggregated one. The
 * wizard's own launch panel already lists every blocking fact at once for an
 * operator who has it open — see `setup-wizard-launch-panel.tsx`'s
 * `launchBlockedBy` — so this gate's job is to be a correct SAFETY NET for a
 * caller that skipped that screen, not to duplicate its multi-fact display.
 * Naming one true blocker and its one remedy keeps the 409 body short enough
 * to read in a terminal, and a caller that fixes it and retries is told about
 * the next one in the same deterministic order.
 */
export async function refuseSiteVisibilityWhileLaunchBlocked(): Promise<NextResponse | null> {
  const progress = normalizeSetupProgress(null);

  const [environmentRole, withheldEmail] = await Promise.all([
    resolveEnvironmentRole(),
    readWithheldApplicationEmail(),
  ]);
  const roleCheck = buildEnvironmentRoleCheck(
    { environmentRole, withheldEmail },
    progress,
  );
  if (roleCheck.status !== "complete") {
    // `"blocked"` is the ONLY status `buildEnvironmentRoleCheck` returns for a
    // role that resolved UNKNOWN (undeclared, unrecognised, or an unreadable
    // safer-override read) — see its own docblock's "THE STATES" list. Every
    // other non-complete status reaching this branch is `"warning"`, and with
    // a real `environmentRole` always supplied above (never `undefined`) the
    // only warning branch reachable is the declared-production-while-
    // capturing-mail one, which needs its OWN remedy: telling that operator to
    // set `APP_ENVIRONMENT_ROLE` sends them to check a variable that is
    // already right.
    const error =
      roleCheck.status === "blocked"
        ? SITE_VISIBILITY_UNKNOWN_ROLE_ERROR
        : launchGateRefusalMessage(roleCheck);
    return NextResponse.json({ error }, { status: 409 });
  }

  const runtimeEnvCheck = buildRuntimeEnvCheck(process.env, progress);
  if (runtimeEnvCheck.status !== "complete") {
    return NextResponse.json(
      { error: launchGateRefusalMessage(runtimeEnvCheck) },
      { status: 409 },
    );
  }

  const authSecretCheck = buildAuthSecretStrengthCheck(process.env, progress);
  if (authSecretCheck.status !== "complete") {
    return NextResponse.json(
      { error: launchGateRefusalMessage(authSecretCheck) },
      { status: 409 },
    );
  }

  return null;
}
