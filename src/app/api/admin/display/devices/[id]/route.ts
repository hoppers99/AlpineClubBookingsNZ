import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { resolveDisplayTemplate } from "@/lib/lodge-display/template-resolution";
import { nameField } from "@/lib/zod-helpers";

// Admin device update (fork issue #33; template binding extended in LTV-033):
// rename and template assignment. A device binds EITHER to a code built-in
// (`templateKey`, validated against the registry) OR to a v2 DisplayTemplate
// (`templateId`, validated to exist) — never both. Binding one clears the
// other, so the resolution order (templateId → templateKey → club default)
// stays unambiguous. Both are validated before persisting (never a dangling
// binding), and a binding change is audit-logged.

const patchSchema = z
  .object({
    name: nameField().optional(),
    templateKey: z.string().max(80).nullable().optional(),
    templateId: z.string().max(80).nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.templateKey !== undefined ||
      value.templateId !== undefined,
    { message: "Nothing to update" }
  )
  // A device binds to a built-in OR a v2 template, never both at once.
  .refine(
    (value) =>
      !(typeof value.templateKey === "string" && typeof value.templateId === "string"),
    { message: "Bind either a built-in or a template, not both" }
  );

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

  // Built-in key: must resolve against the code registry.
  if (typeof body.templateKey === "string") {
    const resolved = resolveDisplayTemplate(body.templateKey);
    if (!resolved) {
      return NextResponse.json(
        { error: "Unknown display template" },
        { status: 400 }
      );
    }
  }
  // v2 template id: must name an existing DisplayTemplate row.
  if (typeof body.templateId === "string") {
    const template = await prisma.displayTemplate.findUnique({
      where: { id: body.templateId },
      select: { id: true },
    });
    if (!template) {
      return NextResponse.json(
        { error: "Unknown display template" },
        { status: 400 }
      );
    }
  }

  // Binding is mutually exclusive: setting one clears the other so resolution
  // (templateId → templateKey → club default) is never ambiguous.
  const data: {
    name?: string;
    templateKey?: string | null;
    templateId?: string | null;
  } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.templateId !== undefined) {
    data.templateId = body.templateId;
    data.templateKey = null;
  }
  if (body.templateKey !== undefined) {
    data.templateKey = body.templateKey;
    data.templateId = null;
  }

  const updated = await prisma.lodgeDisplayDevice.update({
    where: { id },
    data,
    select: { id: true, name: true, templateKey: true, templateId: true },
  });

  if (body.templateKey !== undefined || body.templateId !== undefined) {
    const binding =
      typeof body.templateId === "string"
        ? `template ${body.templateId}`
        : typeof body.templateKey === "string"
          ? `built-in "${body.templateKey}"`
          : "club default";
    logAudit({
      action: "DISPLAY_DEVICE_TEMPLATE_ASSIGNED",
      entityType: "LodgeDisplayDevice",
      entityId: updated.id,
      targetId: updated.id,
      actorMemberId: guard.session.user.id,
      details: `Bound lobby display device "${updated.name}" to ${binding}`,
    });
  }

  return NextResponse.json({ device: updated });
}
