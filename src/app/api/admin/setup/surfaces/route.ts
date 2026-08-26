import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  SETUP_SURFACE_SETTINGS_ID,
  loadSetupSurfaceSettings,
  normalizeSetupSurfaceSettings,
} from "@/lib/setup-surface-settings";

/**
 * The setup-surfaces settings section (setup wizard C8, #223; epic #213 D8).
 * Support `view` / `edit`, resolved through the `/api/admin/setup` prefix in
 * `ROUTE_AREA_PREFIXES` — the same area the readiness page and the wizard
 * already admit, because this decides what that page shows and nothing wider.
 *
 * NO ADVISORY LOCK, BUT A SERIALIZABLE TRANSACTION, and the two halves of that
 * are separate decisions. No lock: the row is a scalar preference with one
 * writer (this route) and it composes no capacity claim, no settlement money and
 * no lifecycle transition, which is what `CONCURRENCY_AND_LOCKING.md` reserves
 * the lock tiers for — introducing a key would be a new global site to register
 * (`INV-LOCK-003`) in exchange for nothing.
 *
 * The transaction is a different question, and the answer is the one
 * `/api/admin/club-time-zone` and `environment-safety-override-write.ts` already
 * reached for the same shape of singleton: THE AUDIT ROW NAMES A `from` VALUE,
 * so that value has to still be true when the write commits. At Prisma's default
 * READ COMMITTED the `findUnique` takes no row lock, so two administrators
 * saving at once could each read `false`, both write, and leave a trail claiming
 * two changes FROM shown — the intermediate value the trail exists to show
 * simply lost. Serializable aborts the loser, which writes nothing at all and is
 * answered a retryable 503. It also settles the create-arm race: the second
 * concurrent first-ever save used to surface a raw P2002 as a 500.
 *
 * An earlier version of this docblock claimed "ordinary guarded upsert, no
 * transaction" as THE precedent among the settings singletons, citing
 * maintenance reports, member guests, analytics and login security. That was
 * selective: THREE OF THOSE FOUR wrap read and write in one interactive
 * transaction — `member-guest-settings`, `integrations/analytics` and both
 * `security/*` routes all do — and the odd one out, `maintenance-reports/
 * settings`, is the only one of the four that records no before/after pair.
 * Recording one is what makes the transaction load-bearing, and this route
 * records one.
 *
 * SERIALIZABLE rather than the siblings' default READ COMMITTED, following
 * `club-time-zone` and the environment-safety override: those three siblings
 * take no isolation level, which keeps their `before` read unlocked and leaves
 * exactly the lost-intermediate-value hole described above. Their reasoning is
 * theirs; this route takes the stricter one, at no measurable cost on a
 * single-row save an operator makes once.
 *
 * THE AUDIT ROW IS `system`, matching the seven setup-progress writers beside
 * it rather than the `admin` that `CLUB_TIME_ZONE_UPDATED` and the
 * environment-safety override take. `INV-PRIV-012` files a row by its AFFECTED
 * DOMAIN, and `docs/guides/audit-log.md` files "Setup, backups, platform-level
 * events" under `system`: the affected domain here is the club's setup journey,
 * the same thing `setup_progress.steps_marked_stale` is about, not an
 * administrator's own settings and not the installation's identity. It widens
 * nobody's access — `system` is readable with `support:view` alone, which is
 * exactly who can already read the setup-progress rows this one sits among —
 * and the row names no member, no booking and no amount.
 *
 * NO NO-OP COMPARISON HERE, deliberately: `ARCHITECTURE.md` → "Admin/member
 * layer" puts the dirty gate at the FORM layer, through the hook's `isDirty`,
 * and states that routes keep no ad-hoc comparison of their own. The `from`/`to`
 * pair in the details makes a pristine write from a direct API caller
 * self-evident rather than invisible.
 */

const putSchema = z
  .object({
    legacySurfacesHidden: z.boolean(),
  })
  .strict();

/**
 * Retryable failures of the transaction below, answered 503 rather than 500 —
 * the same set and the same reasoning as `/api/admin/club-time-zone` and
 * `environment-safety-override-write.ts`. P2028 is a transaction API error
 * (an exhausted `maxWait`/`timeout` among them) and P2034 is the write
 * conflict, deadlock or serialisation failure Serializable deliberately
 * provokes.
 *
 * P2002 joins them because THIS transaction writes exactly one table, whose
 * primary key is the constant `"default"`: a unique violation here can only be
 * the upsert's create arm losing a race with another administrator recording
 * the preference for the first time, which is precisely what retrying fixes.
 * The audit row is written OUTSIDE the transaction (see below), so `AuditLog`
 * cannot contribute a P2002 either. Give this transaction a second table, or
 * `SetupSurfaceSettings` a second unique index, and P2002 stops meaning that —
 * so this set must be revisited if either changes.
 */
const TRANSACTION_CONTENTION_CODES = new Set(["P2002", "P2028", "P2034"]);

function isTransactionContentionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSACTION_CONTENTION_CODES.has(code);
}

export async function GET() {
  const admin = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!admin.ok) return admin.response;

  return NextResponse.json({ settings: await loadSetupSurfaceSettings() });
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!admin.ok) return admin.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose whether the legacy setup surfaces are shown or hidden." },
      { status: 400 },
    );
  }

  try {
    const { before, saved } = await prisma.$transaction(
      async (tx) => {
        // READ INSIDE THE TRANSACTION, and normalised through the same helper
        // the loader uses, so an absent row reads as the default rather than as
        // `undefined`. `loadSetupSurfaceSettings()` is deliberately NOT reused
        // here: it swallows its own errors to fail open, which is right for a
        // render path and wrong for the value an audit row is about to name.
        const existing = await tx.setupSurfaceSettings.findUnique({
          where: { id: SETUP_SURFACE_SETTINGS_ID },
        });

        const row = await tx.setupSurfaceSettings.upsert({
          where: { id: SETUP_SURFACE_SETTINGS_ID },
          // Lazily created, like every other settings singleton here: a club
          // that has never opened this section has no row and reads the default.
          create: {
            id: SETUP_SURFACE_SETTINGS_ID,
            ...parsed.data,
            updatedByMemberId: admin.session.user.id,
          },
          update: { ...parsed.data, updatedByMemberId: admin.session.user.id },
        });

        return {
          before: normalizeSetupSurfaceSettings(existing),
          saved: row,
        };
      },
      { isolationLevel: "Serializable" },
    );

    const ipAddress =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    // Fire-and-forget, matching the setup-progress writers: it runs AFTER the
    // transaction commits, so a failed audit write never fails the operator's
    // save and a rolled-back save records nothing. That placement is also what
    // keeps `AuditLog` out of the P2002 reasoning above.
    logAudit({
      action: "setup_surfaces.legacy_visibility_changed",
      category: "system",
      memberId: admin.session.user.id,
      entityType: "SetupSurfaceSettings",
      entityId: SETUP_SURFACE_SETTINGS_ID,
      details: JSON.stringify({
        from: before.legacySurfacesHidden,
        to: parsed.data.legacySurfacesHidden,
      }),
      ipAddress,
      outcome: "success",
    });

    return NextResponse.json({
      settings: normalizeSetupSurfaceSettings(saved),
    });
  } catch (err) {
    /*
      The loser of a real race, told to try again rather than handed a 500 — and
      it wrote nothing, so retrying is safe. Everything else stays a 500 with a
      generic message: the Prisma error is logged, never returned, so a database
      fault cannot leak a table or column name to the browser.
    */
    if (isTransactionContentionError(err)) {
      logger.warn({ err }, "Setup surface settings save hit write contention");
      return NextResponse.json(
        { error: "Another update is in progress — try again shortly." },
        { status: 503 },
      );
    }
    logger.error({ err }, "Failed to save setup surface settings");
    return NextResponse.json(
      { error: "Failed to save these settings" },
      { status: 500 },
    );
  }
}
