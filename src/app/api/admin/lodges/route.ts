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
  `lodge:view`, inferred from the request path (#2925).

  `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` hold no `lodge` entry, so this 403s for
  them permanently, and the admin surfaces that need only the lodge NAMES lose
  their content as a result. That is a real defect and it is tracked in #2925,
  not fixed here.

  It was attempted in this PR and reverted, because the attempt was INERT and
  the revert is the honest state. `requireAdmin()` with no options does not mean
  "any admin": `inferAdminAccessRequirement` reads the `x-pathname` and
  `x-request-method` headers that `proxy.ts` sets for this route and resolves
  them through `getAdminRouteRequirement`, which maps `/api/admin/lodges` to
  `area: "lodge"`. Dropping the explicit `permission` therefore changed nothing
  at all — the same requirement came back by inference — while the tests written
  for it passed against a mock whose absent-options fallback used
  `hasAdminPortalAccess`, which the real guard has never had.
*/
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const lodges = await prisma.lodge.findMany({
    orderBy: lodgeOrderBy(),
    select: lodgeSelect,
  });

  return NextResponse.json({ lodges: lodges.map(serializeLodge) });
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
