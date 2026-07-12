import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveDisplayTemplate } from "@/lib/lodge-display/template-resolution";
import { nameField } from "@/lib/zod-helpers";

// Admin device update (fork issue #33): rename and template assignment.
// templateKey binds a code built-in and is validated against the registry
// before persisting (never a dangling key).

const patchSchema = z
  .object({
    name: nameField().optional(),
    templateKey: z.string().max(80).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.templateKey !== undefined, {
    message: "Nothing to update",
  });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { id } = await params;
  const device = await prisma.lodgeDisplayDevice.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  if (typeof body.templateKey === "string") {
    const resolved = resolveDisplayTemplate(body.templateKey);
    if (!resolved) {
      return NextResponse.json(
        { error: "Unknown display template" },
        { status: 400 }
      );
    }
  }

  const updated = await prisma.lodgeDisplayDevice.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.templateKey !== undefined ? { templateKey: body.templateKey } : {}),
    },
    select: { id: true, name: true, templateKey: true },
  });
  return NextResponse.json({ device: updated });
}
