import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  InvalidDisplayTemplateError,
  listBuiltInDisplayTemplates,
  validateDisplayTemplateDefinition,
} from "@/lib/lodge-display/template-registry";
import { resolveDisplayTemplate } from "@/lib/lodge-display/template-resolution";

// Admin display-template detail/save/delete (fork issue #34, ADR-002 §2).
// Saving validates against the closed module/condition registries — a broken
// definition is rejected with the offending detail, never persisted (AC8).
// Deleting an override/custom row restores the code default (if any).

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { key } = await params;
  const resolved = await resolveDisplayTemplate(key).catch((error) => {
    if (error instanceof InvalidDisplayTemplateError) return null;
    throw error;
  });
  if (!resolved) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  return NextResponse.json({
    template: resolved.definition,
    source: resolved.source,
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { key } = await params;
  let definition;
  try {
    const raw = (await req.json()) as { definition?: unknown };
    definition = validateDisplayTemplateDefinition(raw.definition);
  } catch (error) {
    const detail =
      error instanceof InvalidDisplayTemplateError
        ? error.message
        : "Invalid request";
    return NextResponse.json({ error: detail }, { status: 400 });
  }
  if (definition.key !== key) {
    return NextResponse.json(
      { error: "Definition key must match the URL key" },
      { status: 400 }
    );
  }

  const isBuiltIn = listBuiltInDisplayTemplates().some(
    (template) => template.key === key
  );
  const saved = await prisma.displayTemplate.upsert({
    where: { key },
    create: {
      key,
      name: definition.name,
      source: isBuiltIn ? "BUILT_IN_OVERRIDE" : "CUSTOM",
      definition: definition as object,
    },
    update: { name: definition.name, definition: definition as object },
    select: { key: true, source: true },
  });
  return NextResponse.json({ ok: true, saved });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { key } = await params;
  const row = await prisma.displayTemplate.findUnique({
    where: { key },
    select: { key: true },
  });
  if (!row) {
    return NextResponse.json({ error: "No stored template" }, { status: 404 });
  }
  // A device bound to a deleted CUSTOM key falls back to the club default at
  // resolution time; deleting an override restores the built-in.
  await prisma.displayTemplate.delete({ where: { key } });
  return NextResponse.json({ ok: true });
}
