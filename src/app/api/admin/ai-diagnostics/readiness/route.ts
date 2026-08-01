import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getDiagnosticsReadiness } from "@/lib/ai-diagnostics-config";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

// GET /api/admin/ai-diagnostics/readiness — metadata-only setup readiness for the
// AI Diagnostics product (AID-2, #2371).
//
// DELIBERATELY REACHABLE WHILE THE MODULE IS OFF: this endpoint is exempted from
// the aiDiagnostics feature-route gate (config/feature-routes.ts) so an admin can
// see what still needs configuring — the module being off, no dedicated Anthropic
// key stored, or no monthly budget set — and complete setup BEFORE enabling the
// paid product. It spends nothing, exposes NO secret value, and enforces its own
// support-area admin permission.
//
// Fail-closed: getDiagnosticsReadiness returns ready:false with a resolve_error
// blocker on any DB fault rather than throwing, so a diagnostics surface never
// treats an unknown state as ready.
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const flags = await loadEffectiveModuleFlags();
  const readiness = await getDiagnosticsReadiness({
    aiDiagnostics: flags.aiDiagnostics,
  });

  return NextResponse.json(readiness);
}
