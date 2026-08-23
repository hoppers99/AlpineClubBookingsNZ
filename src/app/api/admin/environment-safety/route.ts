import { NextResponse } from "next/server";
import { z } from "zod";

import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  ENVIRONMENT_SAFETY_SETTINGS_ID,
  ENVIRONMENT_SAFETY_SETTINGS_SELECT,
  decideEnvironmentRole,
  resolveEnvironmentRole,
} from "@/lib/environment-role";
import { readEnvironmentRoleDeclaration } from "@/lib/environment-role-declaration";
import {
  stateFromResolution,
  stateFromWrittenRow,
} from "@/lib/environment-safety-admin-state";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

/**
 * The environment-safety API (ENV-SAFETY 1, #3034; epic #2986). INV-CONFIG-003.
 *
 * FULL ADMIN ON BOTH VERBS, AND NOT BY AREA LEVEL. `requireAdmin({ permission:
 * false })` is the guard's "only a full administrator" shape (see
 * `RequireAdminOptions` in `src/lib/session-guards.ts`). The two other shapes are
 * both wrong here and both look right at a glance: an OMITTED `permission`
 * INFERS the requirement from the path, which for these prefixes is `support`,
 * so a support editor would be admitted; `"any-admin"` widens to every admitted
 * administrator. `/admin/environment` and `/api/admin/environment-safety` are
 * registered under `support` in `ROUTE_AREA_PREFIXES` only so the route-map drift
 * guard and the sidebar matrix resolve them to a concrete area instead of the
 * `overview` catch-all; that AREA decides who can reach the surface at all, and
 * the `permission: false` here is what enforces Full Admin.
 *
 * THE OVERRIDE CAN ONLY MAKE THIS INSTALLATION SAFER, and the API's shape says
 * so as plainly as the schema does. `PATCH` accepts one boolean,
 * `forceNonProduction`: no field could assert production and no field names a
 * role, so the request body cannot express "this is production" any more than the
 * table can. Production is declared by the DEPLOYMENT (`APP_ENVIRONMENT_ROLE`).
 * Turning the override OFF is equally privileged and equally audited, and it is
 * NOT an elevation — with it off the declaration decides, so a declared
 * non-production stays non-production and an undeclared installation goes back to
 * UNKNOWN.
 *
 * THE CONFIRMATION IS ENFORCED HERE, not only in the panel. A checkbox in a
 * browser is a courtesy to the operator, and the panel is not the only caller.
 *
 * THE TRANSACTION TOUCHES EXACTLY TWO TABLES — `EnvironmentSafetySettings` and
 * `AuditLog` — and that is a contract, not an implementation detail. Switching
 * the override changes how this installation BEHAVES from now on; it rewrites no
 * booking, no payment and no member. A write here reaching any of those would be
 * that promise broken, so the route's test enumerates the delegates and fails if
 * any other one is called.
 *
 * SERIALIZABLE, AND NO ADVISORY LOCK. A single-row configuration upsert composes
 * no capacity claim, no settlement money and no lifecycle transition, which is
 * what `docs/CONCURRENCY_AND_LOCKING.md` reserves the lock tiers for — but it
 * does need its recorded BEFORE value to be true. At Prisma's default READ
 * COMMITTED a `findUnique` takes no row lock, so two administrators saving at
 * once could each read "off", both write, and leave a trail claiming two changes
 * FROM off. Serializable aborts the loser instead, which writes nothing at all
 * and is answered a retryable 503.
 */

/**
 * Retryable failures of the transaction below, answered 503 rather than 500.
 * P2028 (transaction API error, including an exhausted `maxWait`/`timeout`) and
 * P2034 (write conflict, deadlock, or the serialisation failure Serializable
 * deliberately provokes) are the shared shape `/api/admin/club-time-zone` and
 * `/api/admin/site-style` use. P2002 joins them because on a one-row singleton
 * whose id is a constant, a primary-key collision can only be this upsert's
 * create arm losing a race with another administrator recording the setting for
 * the first time — and the only other table this transaction writes is
 * `AuditLog`, whose primary key is a per-row `cuid` with no other unique
 * constraint, so no P2002 can originate there today. Add a unique index to
 * `AuditLog` and this set must be revisited.
 */
const TRANSACTION_CONTENTION_CODES = new Set(["P2002", "P2028", "P2034"]);

function isTransactionContentionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSACTION_CONTENTION_CODES.has(code);
}

export async function GET() {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;

  const resolution = await resolveEnvironmentRole();
  return NextResponse.json({ state: await stateFromResolution(resolution) });
}

/**
 * `confirmed` is OPTIONAL in the schema and required by the check below, so an
 * absent flag and an explicit `false` get the same plain-English refusal rather
 * than one of them falling out as a generic "invalid body".
 *
 * `.strict()` is load-bearing: it is what makes an unknown key — `role`,
 * `forceProduction`, `isProduction` — a 400 rather than a silently ignored field
 * that a caller might believe had been honoured.
 */
const changeSchema = z
  .object({
    forceNonProduction: z.boolean(),
    confirmed: z.boolean().optional(),
  })
  .strict();

export async function PATCH(request: Request) {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;
  const actingMemberId = guard.session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = changeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (parsed.data.confirmed !== true) {
    return NextResponse.json(
      {
        error:
          "Changing how this installation is treated has to be confirmed before it is saved.",
      },
      { status: 400 },
    );
  }

  const forceNonProduction = parsed.data.forceNonProduction;

  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const before = await tx.environmentSafetySettings.findUnique({
          where: { id: ENVIRONMENT_SAFETY_SETTINGS_ID },
          select: ENVIRONMENT_SAFETY_SETTINGS_SELECT,
        });

        /*
          DIRTY GATING (docs/ARCHITECTURE.md -> "Admin/member layer"). Re-saving
          the value already stored writes nothing at all: no row, no `updatedAt`
          bump and no audit row. A trail recording changes that never happened is
          worse than no trail, because the next reader cannot tell the
          difference. The isolation level above — not the fact that this read sits
          inside the transaction — is what keeps `before` true at commit time.
        */
        /*
          ABSENT COUNTS AS `false` HERE, and that is the fix for a real hole
          (#3034 review). The first version gated on `before &&`, so saving
          `forceNonProduction: false` with NO row created one and wrote an audit
          row summarised "switched off" — for an override that had never been on.
          The effective role does not change either way, so that row claimed a
          change that did not happen, which is exactly what the paragraph above
          argues against.

          Treating absent as `false` is the right resolution rather than merely
          the cheaper one, for two reasons. An absent row and `false` ARE the same
          answer — that is what the schema's `@default(false)` and the migration's
          decision not to seed a row both rest on, and what lets every read path
          avoid ever creating one. And the panel never offers this: with the
          override off the button reads "Switch the override on", so a `false`
          against an absent row can only arrive from a direct API call. The
          "provenance of a deliberate confirmation" it would preserve is
          provenance nobody asked for — and it would go on to make the panel say
          "last changed <date> by <name>" for a change that never occurred, which
          is the same untruth one layer up.
        */
        const beforeValue = before?.forceNonProduction ?? false;
        if (beforeValue === forceNonProduction) {
          return { changed: false as const, row: before };
        }

        const row = await tx.environmentSafetySettings.upsert({
          where: { id: ENVIRONMENT_SAFETY_SETTINGS_ID },
          update: { forceNonProduction, updatedByMemberId: actingMemberId },
          create: {
            id: ENVIRONMENT_SAFETY_SETTINGS_ID,
            forceNonProduction,
            updatedByMemberId: actingMemberId,
          },
          select: ENVIRONMENT_SAFETY_SETTINGS_SELECT,
        });

        await tx.auditLog.create(
          buildStructuredAuditLogCreateArgs({
            action: "ENVIRONMENT_SAFETY_OVERRIDE_UPDATED",
            actor: { memberId: actingMemberId },
            entity: {
              type: "EnvironmentSafetySettings",
              id: ENVIRONMENT_SAFETY_SETTINGS_ID,
            },
            // Installation configuration, like CLUB_TIME_ZONE_UPDATED and
            // CLUB_IDENTITY_SETTINGS_UPDATED. Not `security`: this changes what
            // the installation DOES, not who may sign in or what they may reach.
            category: "admin",
            severity: "important",
            outcome: "success",
            summary: forceNonProduction
              ? "Environment safety override switched on (forced non-production)"
              : "Environment safety override switched off",
            /*
              THE BEFORE AND AFTER FLAG, AND NOTHING ELSE. `before: null` means
              nothing was stored yet. No request echo, no environment values, and
              nothing about the actor beyond the id the row already carries — in
              particular NOT the deployment declaration, which is configuration
              this row has no business copying and which the resolver reads live
              anyway.
            */
            metadata: {
              before: before?.forceNonProduction ?? null,
              after: forceNonProduction,
            },
            request: getAuditRequestContext(request),
          }),
        );

        return { changed: true as const, row };
      },
      { isolationLevel: "Serializable" },
    );

    /*
      The role AFTER the write, computed from the row this request wrote and the
      declaration read live — never from a fresh database round trip, which could
      pick up a concurrent administrator's change and report it as this one's
      result. This is also what lets the response tell the operator the honest
      consequence of switching the override OFF on an undeclared installation:
      UNKNOWN, not production.
    */
    const resolution = decideEnvironmentRole(
      readEnvironmentRoleDeclaration(),
      outcome.row?.forceNonProduction
        ? {
            kind: "force-non-production",
            updatedAt: outcome.row.updatedAt,
            updatedByMemberId: outcome.row.updatedByMemberId,
          }
        : { kind: "none" },
    );

    return NextResponse.json({
      changed: outcome.changed,
      state: await stateFromWrittenRow(resolution, outcome.row),
    });
  } catch (error) {
    /*
      The loser of a real race, told to try again rather than handed a 500 — and
      it wrote nothing, so retrying is safe. Anything else rethrows: this route
      cannot tell what a broken database means, and dressing that up as a
      friendly "try again shortly" would hide it from whoever has to fix it.
    */
    if (!isTransactionContentionError(error)) throw error;
    logger.warn(
      { err: error },
      "Environment safety override save hit write contention",
    );
    return NextResponse.json(
      { error: "Another update is in progress — try again shortly." },
      { status: 503 },
    );
  }
}
