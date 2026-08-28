import { NextResponse } from "next/server";
import { resolveEnvironmentRole } from "@/lib/environment-role";

/**
 * The environment gate on MAKING THE PUBLIC SITE VISIBLE — `INV-CONFIG-006`
 * (epic #213, C16/#247), consuming `INV-CONFIG-003`'s canonical role.
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
 * forever, which is exactly what the wizard's launch panel already tells the
 * operator ("the two are independent"). The gate is on the role being UNKNOWN,
 * never on it being a copy.
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
 */
export async function refuseSiteVisibilityWhileEnvironmentUnknown(): Promise<NextResponse | null> {
  const { role } = await resolveEnvironmentRole();
  if (role !== "UNKNOWN") return null;
  return NextResponse.json(
    { error: SITE_VISIBILITY_UNKNOWN_ROLE_ERROR },
    { status: 409 },
  );
}
