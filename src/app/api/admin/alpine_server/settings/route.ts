import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import { createAuditLog } from "@/lib/audit";
import { updateServerNzSettings } from "@/lib/servernz-settings";

// POST /api/admin/alpine_server/settings — save the NON-secret ServerNZ
// connection settings (base URL and per-shared-item enable flags). The API key
// itself goes through the encrypted-credential route, not here. Finance-area
// edit (same audience as the Integrations hub).

const bodySchema = z
  .object({
    baseUrl: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v === "" || /^https?:\/\//i.test(v), {
        message: "Base URL must start with http:// or https://",
      })
      .optional(),
    otherLodgesEnabled: z.boolean().optional(),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const settings = await updateServerNzSettings({
    baseUrl: parsed.data.baseUrl,
    otherLodgesEnabled: parsed.data.otherLodgesEnabled,
    updatedByMemberId: guard.session.user.id,
  });

  await createAuditLog({
    action: "alpine_server.settings.update",
    category: "admin",
    severity: "info",
    outcome: "success",
    memberId: guard.session.user.id,
    entityType: "ServerNzSettings",
    entityId: "default",
    summary: "Updated Alpine Central Server settings",
    details: `changed: ${Object.keys(parsed.data).join(", ") || "none"}`,
  });

  return NextResponse.json({
    baseUrl: settings.baseUrl,
    otherLodgesEnabled: settings.otherLodgesEnabled,
  });
}
