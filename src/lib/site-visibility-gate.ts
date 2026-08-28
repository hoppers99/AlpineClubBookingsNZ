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
 * There are TWO writers of `ClubTheme.completedAt`, and the issue's own
 * description of the hazard ("a content officer, or curl, can publish the public
 * site with the environment role UNKNOWN") is true of both:
 *
 *  - `POST /api/admin/site-style/complete-setup`, the wizard launch panel's
 *    one-column transition; and
 *  - `PUT /api/admin/site-style` with `completeSetup: true`, which
 *    `saveClubTheme` still honours for the legacy site-style wizard's
 *    "Finish setup" button.
 *
 * Gating only the first would have left the second as a one-line bypass of the
 * gate, so both call this and the refusal cannot drift between them.
 */

/**
 * The operator-facing refusal. Names both repairs because the resolver's UNKNOWN
 * covers both faults, and names the screen that can tell them apart rather than
 * restating the resolver's own notes — the wizard's launch panel already renders
 * those beneath this error, and `/admin/environment` renders them in full.
 *
 * Secret-free by construction: it names an environment variable and a screen,
 * never a value, a connection string or a provider identifier.
 */
export const SITE_VISIBILITY_UNKNOWN_ROLE_ERROR =
  "The public site was not made visible and nothing was changed: this " +
  "installation has not been confirmed as production or non-production. Set " +
  "APP_ENVIRONMENT_ROLE in this deployment's environment, or switch the safer " +
  "override on at Admin › Environment if this is a copy, then try again. " +
  "Admin › Environment reports which of the two is missing.";

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
