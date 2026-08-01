import type { AdultMemberHostingPolicy } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";
import {
  INACTIVE_ADULT_MEMBER_HOSTING_LODGE_MESSAGE,
  STALE_ADULT_MEMBER_HOSTING_POLICY_MESSAGE,
  lockAdultMemberHostingPolicySet,
} from "@/lib/adult-member-hosting-policy-set";

/**
 * Adult-member hosting policy administration (#2364).
 *
 * One row per scope, so this is a keyed singleton rather than the minimum-stay
 * LIST: `?lodgeId=` selects the club-wide row or one lodge's override, and the
 * GET synthesises the built-in default when that scope has no row yet. The
 * synthesised body carries `configured: false` so the card can tell "the club
 * has not set this" from "the club set it to Disabled" — without that flag the
 * draft would equal the snapshot and the dirty gate would make the FIRST save
 * unreachable (#2142/#2143, exactly as on the group-discount card).
 */

const CLUB_SCOPE_KEY = "club-wide";

const writeSchema = z.object({
  mode: z.enum(["INHERIT", "DISABLED", "ADMIN_REVIEW_REQUIRED"]),
  // Required on EVERY write, with no server-side default (epic decision D-R6:
  // capacity mode is per policy and explicit for new policies). The column has
  // no database default either, so there is nowhere for an unstated value to
  // come from.
  capacityMode: z.enum(["HOLD", "NO_HOLD"]),
  // The revision the editor loaded. Absent means "I believe no row exists yet";
  // present means "I am updating the row I read". Either belief being wrong is a
  // 409, never a blind overwrite of a concurrent admin or a configuration
  // import.
  version: z.number().int().min(1).optional(),
  lodgeId: z.string().min(1).optional(),
});

function scopeKeyFor(lodgeId: string | null): string {
  return lodgeId ?? CLUB_SCOPE_KEY;
}

class StalePolicyError extends Error {}
class InactivePolicyLodgeError extends Error {}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const lodgeId = request.nextUrl.searchParams.get("lodgeId");
  const policy = await prisma.adultMemberHostingPolicy.findUnique({
    where: { scopeKey: scopeKeyFor(lodgeId) },
  });

  if (policy) {
    return NextResponse.json({ ...policy, configured: true });
  }

  return NextResponse.json({
    scopeKey: scopeKeyFor(lodgeId),
    lodgeId: lodgeId ?? null,
    // An unconfigured LODGE inherits; an unconfigured CLUB has the requirement
    // off. Neither is a stored row, and `configured: false` says so.
    mode: lodgeId ? "INHERIT" : "DISABLED",
    // Deliberately null rather than a plausible-looking mode: the admin has to
    // choose one before the first save, and pre-filling the field would be the
    // hidden default D-R6 rules out.
    capacityMode: null,
    version: 0,
    configured: false,
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let data: z.infer<typeof writeSchema>;
  try {
    data = writeSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const lodgeId = data.lodgeId ?? null;
  if (lodgeId === null && data.mode === "INHERIT") {
    // The database CHECK refuses this too; refusing here as well means the
    // admin reads a sentence instead of a constraint-violation 500.
    return NextResponse.json(
      {
        error:
          "The club-wide setting cannot inherit — there is nothing above it to inherit from. Choose Disabled or Admin review required.",
      },
      { status: 400 },
    );
  }

  const scopeKey = scopeKeyFor(lodgeId);

  try {
    // Discriminated on purpose, exactly as `minimum-stay/[id]/route.ts` does.
    // Returning the row alone would make the unchanged branch indistinguishable
    // from a real write out here, and the audit entry and the ISR bust below
    // would still fire — which is the thing the guard inside exists to prevent.
    const result = await prisma.$transaction<
      | { kind: "unchanged"; policy: AdultMemberHostingPolicy }
      | { kind: "written"; policy: AdultMemberHostingPolicy }
    >(async (tx) => {
      // Before the first read, so the row this write compare-and-swaps against
      // cannot move underneath it. The migration's statement trigger re-enters
      // the same key when the DML below fires.
      await lockAdultMemberHostingPolicySet(tx);

      if (lodgeId) {
        const lodge = await tx.lodge.findUnique({
          where: { id: lodgeId },
          select: { id: true, active: true },
        });
        if (!lodge || !lodge.active) throw new InactivePolicyLodgeError();
      }

      const existing = await tx.adultMemberHostingPolicy.findUnique({
        where: { scopeKey },
      });

      if (!existing) {
        // The editor carried a version, so it believed it was updating a row
        // that has since been deleted (a configuration import can do that).
        // Creating one anyway would resurrect a policy the club removed.
        if (data.version !== undefined) throw new StalePolicyError();
        return {
          kind: "written",
          policy: await tx.adultMemberHostingPolicy.create({
            data: {
              scopeKey,
              lodgeId,
              mode: data.mode,
              capacityMode: data.capacityMode,
              version: 1,
            },
          }),
        };
      }

      if (data.version !== existing.version) throw new StalePolicyError();

      if (
        existing.mode === data.mode &&
        existing.capacityMode === data.capacityMode
      ) {
        // Nothing material changed. Return the row untouched rather than write
        // it: the revision trigger would hold the token anyway, but a no-op
        // UPDATE would still log an audit entry asserting a change that never
        // happened and bust the public-page cache (#2143). `kind` is what
        // carries that out of the transaction — see the caller.
        return { kind: "unchanged", policy: existing };
      }

      const updated = await tx.adultMemberHostingPolicy.updateMany({
        where: { scopeKey, version: existing.version },
        data: {
          mode: data.mode,
          capacityMode: data.capacityMode,
          version: existing.version + 1,
        },
      });
      if (updated.count !== 1) throw new StalePolicyError();

      const reloaded = await tx.adultMemberHostingPolicy.findUnique({
        where: { scopeKey },
      });
      if (!reloaded) throw new StalePolicyError();
      return { kind: "written", policy: reloaded };
    });

    const policy = result.policy;

    // Before the audit entry and before the revalidation, deliberately. An
    // admin who opened the card and saved without changing anything wrote
    // nothing, so the log must not name them as having changed the rule — an
    // operator asking "who changed this, and when" has to be able to trust the
    // answer — and the public page's cache must not be purged for a write that
    // did not happen (#2143).
    if (result.kind === "unchanged") {
      return NextResponse.json({ ...policy, configured: true });
    }

    logAudit({
      action: "adult-member-hosting-policy.update",
      memberId: session.user.id,
      targetId: policy.id,
      details: JSON.stringify({
        scopeKey,
        lodgeId,
        mode: policy.mode,
        capacityMode: policy.capacityMode,
        version: policy.version,
      }),
    });

    revalidatePublicPageContent();
    return NextResponse.json({ ...policy, configured: true });
  } catch (error) {
    if (error instanceof StalePolicyError) {
      return NextResponse.json(
        {
          error: STALE_ADULT_MEMBER_HOSTING_POLICY_MESSAGE,
          code: "POLICY_VERSION_CONFLICT",
        },
        { status: 409 },
      );
    }
    if (error instanceof InactivePolicyLodgeError) {
      return NextResponse.json(
        { error: INACTIVE_ADULT_MEMBER_HOSTING_LODGE_MESSAGE },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Failed to save the adult-member hosting policy" },
      { status: 500 },
    );
  }
}
