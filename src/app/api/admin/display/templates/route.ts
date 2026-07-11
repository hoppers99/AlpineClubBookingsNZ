import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { listBuiltInDisplayTemplates } from "@/lib/lodge-display/template-registry";

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
