import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { listBuiltInDisplayTemplates } from "@/lib/lodge-display/template-registry";

// Built-in template list for the device-assignment picker (LTV-024). During the
// v2 rebuild the admin CRUD surface is gone (replaced by LTV-032/033); this
// read-only list keeps screens assignable against the code built-ins.

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const templates = listBuiltInDisplayTemplates().map((template) => ({
    key: template.key,
    name: template.name,
  }));
  return NextResponse.json({ templates });
}
