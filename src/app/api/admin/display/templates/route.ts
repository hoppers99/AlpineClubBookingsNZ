import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  listBuiltInDisplayTemplates,
  validateDisplayTemplateDefinition,
} from "@/lib/lodge-display/template-registry";
import { resolveDisplayTemplate } from "@/lib/lodge-display/template-resolution";
import { nameField } from "@/lib/zod-helpers";

// Registry template list for the assignment UI (fork issue #33): built-ins
// merged with DB rows (overrides keep the built-in key; customs add theirs).
// LTV-009 (#34) extends template management; this is read-only.

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const rows = await prisma.displayTemplate.findMany({
    select: { key: true, name: true, source: true },
    orderBy: [{ name: "asc" }],
  });

  const byKey = new Map<string, { key: string; name: string; source: string }>();
  for (const builtIn of listBuiltInDisplayTemplates()) {
    byKey.set(builtIn.key, { key: builtIn.key, name: builtIn.name, source: "built-in" });
  }
  for (const row of rows) {
    byKey.set(row.key, {
      key: row.key,
      name: row.name,
      source: row.source === "CUSTOM" ? "custom" : "override",
    });
  }

  return NextResponse.json({ templates: [...byKey.values()] });
}

const copySchema = z.object({
  fromKey: z.string().min(1).max(80),
  key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Key must be a lower-case slug"),
  name: nameField(),
});

/** Copy-to-custom (fork issue #34 AC1): clone any registry template into a
 * CUSTOM row the club can edit without touching the code default (AC2). */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof copySchema>;
  try {
    body = copySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const source = await resolveDisplayTemplate(body.fromKey);
  if (!source) {
    return NextResponse.json({ error: "Source template not found" }, { status: 404 });
  }
  const existing = await prisma.displayTemplate.findUnique({
    where: { key: body.key },
    select: { key: true },
  });
  const isBuiltInKey = listBuiltInDisplayTemplates().some(
    (template) => template.key === body.key
  );
  if (existing || isBuiltInKey) {
    return NextResponse.json(
      { error: "A template with that key already exists" },
      { status: 409 }
    );
  }

  const definition = validateDisplayTemplateDefinition({
    ...source.definition,
    key: body.key,
    name: body.name,
  });
  const created = await prisma.displayTemplate.create({
    data: {
      key: body.key,
      name: body.name,
      source: "CUSTOM",
      definition: definition as object,
    },
    select: { key: true, name: true, source: true },
  });
  return NextResponse.json({ template: created }, { status: 201 });
}
