import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  buildUniqueLodgeSlug,
  lodgeOrderBy,
  lodgeSelect,
  normalizeLodgeText,
  redactLodgeForAudit,
  serializeLodge,
} from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { invalidatePublicClubIdentity } from "@/lib/public-layout-cache";
import { primeClubIdentitySync } from "@/lib/club-identity-settings";
import { acquireConfigImportLock } from "@/lib/config-transfer-lock";

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300).nullable().optional(),
    doorCode: z.string().trim().max(80).nullable().optional(),
    travelNote: z.string().trim().max(2000).nullable().optional(),
    active: z.boolean().optional().default(true),
  })
  .strict();

/*
  Readable by ANY authenticated admin (#2887, owner decision).

  This list is the vocabulary every admin screen needs in order to say which
  lodge it is talking about — id, name, active — and gating that behind the
  `lodge` feature area is what produced blank pages. `ADMIN_MEMBERSHIP` and
  `FINANCE_ADMIN` hold no `lodge` entry, so this endpoint 403'd for them
  permanently, and surfaces that only ever needed the NAMES lost their content.

  Deliberately this endpoint alone. The other seventeen `lodge:view` reads and
  all twenty-five `lodge:edit` writes are untouched, and no role preset changed
  — widening the presets would have handed those two roles every one of those
  endpoints on upgrade.

  THE PAYLOAD NARROWS INSTEAD OF THE ACCESS. `lodgeSelect` carries `doorCode`,
  which this codebase already treats as a physical-access secret (see
  `redactLodgeForAudit`: it must never even reach audit metadata), plus the
  street address and travel notes. A finance admin has no business with the
  door code, so a caller without `lodge:view` gets identity only. The
  `/admin/lodges` management page, which does hold `lodge:view`, is unaffected.
*/
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const lodges = await prisma.lodge.findMany({
    orderBy: lodgeOrderBy(),
    select: lodgeSelect,
  });

  const mayReadLodgeDetail = hasAdminAreaAccess(
    { adminPermissionMatrix: guard.session.user.adminPermissionMatrix },
    { area: "lodge", level: "view" },
  );

  return NextResponse.json({
    lodges: lodges.map((lodge) =>
      mayReadLodgeDetail
        ? serializeLodge(lodge)
        : {
            id: lodge.id,
            name: lodge.name,
            slug: lodge.slug,
            active: lodge.active,
          },
    ),
  });
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    await acquireConfigImportLock(tx);
    const slug = await buildUniqueLodgeSlug(tx, parsed.data.name);
    const lodge = await tx.lodge.create({
      data: {
        name: parsed.data.name.trim(),
        slug,
        active: parsed.data.active,
        address: normalizeLodgeText(parsed.data.address),
        doorCode: normalizeLodgeText(parsed.data.doorCode),
        travelNote: normalizeLodgeText(parsed.data.travelNote),
      },
      select: lodgeSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "LODGE_CREATED",
        actor: { memberId: session.user.id },
        entity: { type: "Lodge", id: lodge.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Lodge created",
        metadata: { newLodge: redactLodgeForAudit(serializeLodge(lodge)) },
        request: getAuditRequestContext(request),
      }),
    );

    return lodge;
  });

  revalidatePublicPageContent();
  // A new (possibly default) lodge can change DB-first club identity (E3 #1929).
  invalidatePublicClubIdentity();
  await primeClubIdentitySync();

  return NextResponse.json(
    { lodge: serializeLodge(created) },
    { status: 201 },
  );
}
