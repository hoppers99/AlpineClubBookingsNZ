import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { createAuditLog } from "@/lib/audit";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { uploadOtherClubsToServer } from "@/lib/servernz-other-lodges-sync";
import { respondToSyncError } from "@/lib/servernz-sync-response";

// POST /api/admin/alpine-server/other-lodges/upload — push this club's Other
// Clubs registry up to the central server using the stored API key.
export async function POST() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const settings = await loadServerNzSettings();
  if (!settings.otherLodgesEnabled) {
    return NextResponse.json(
      { error: "Other Clubs sync is disabled. Enable it first." },
      { status: 409 },
    );
  }

  try {
    const result = await uploadOtherClubsToServer();
    await createAuditLog({
      action: "alpine_server.other_lodges.upload",
      category: "lodge",
      severity: "info",
      outcome: "success",
      memberId: guard.session.user.id,
      summary: "Uploaded Other Clubs to Alpine Central Server",
      details: `created ${result.created}, updated ${result.updated}, skipped ${result.skipped}`,
    });
    return NextResponse.json(result);
  } catch (error) {
    return respondToSyncError(error, guard.session.user.id, "upload");
  }
}
