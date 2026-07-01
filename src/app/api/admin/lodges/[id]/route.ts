import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  buildUniqueLodgeSlug,
  lodgeSelect,
  normalizeLodgeText,
  serializeLodge,
  syncSoleActiveLodgeIdentity,
} from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    doorCode: z.string().trim().max(80).nullable().optional(),
    travelNote: z.string().trim().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid lodge id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.lodge.findUnique({
    where: { id: parsedParams.data.id },
    select: lodgeSelect,
  });
  if (!existing) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  // Every deployment keeps at least one active lodge: booking flows and the
  // ADR-002 presentation rule both assume one exists.
  if (parsed.data.active === false && existing.active) {
    const otherActive = await prisma.lodge.count({
      where: { active: true, id: { not: existing.id } },
    });
    if (otherActive === 0) {
      return NextResponse.json(
        { error: "At least one lodge must remain active." },
        { status: 409 },
      );
    }
  }

  const data: {
    name?: string;
    slug?: string;
    doorCode?: string | null;
    travelNote?: string | null;
    active?: boolean;
  } = {};

  if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    data.name = parsed.data.name.trim();
    data.slug = await buildUniqueLodgeSlug(prisma, data.name, existing.id);
  }
  if (parsed.data.doorCode !== undefined) {
    data.doorCode = normalizeLodgeText(parsed.data.doorCode);
  }
  if (parsed.data.travelNote !== undefined) {
    data.travelNote = normalizeLodgeText(parsed.data.travelNote);
  }
  if (parsed.data.active !== undefined) {
    data.active = parsed.data.active;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ lodge: serializeLodge(existing) });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const lodge = await tx.lodge.update({
      where: { id: existing.id },
      data,
      select: lodgeSelect,
    });

    await syncSoleActiveLodgeIdentity(tx);

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action:
          data.active === undefined
            ? "LODGE_UPDATED"
            : data.active
              ? "LODGE_ACTIVATED"
              : "LODGE_DEACTIVATED",
        actor: { memberId: session.user.id },
        entity: { type: "Lodge", id: lodge.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary:
          data.active === undefined
            ? "Lodge updated"
            : data.active
              ? "Lodge activated"
              : "Lodge deactivated",
        metadata: {
          changedFields: Object.keys(data),
          previousLodge: serializeLodge(existing),
          newLodge: serializeLodge(lodge),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return lodge;
  });

  return NextResponse.json({ lodge: serializeLodge(updated) });
}
