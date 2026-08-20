import "server-only";
import { NextResponse } from "next/server";
import { createAuditLog } from "@/lib/audit";
import {
  ServerNzApiError,
  ServerNzNotConfiguredError,
} from "@/lib/servernz-api";

/**
 * Map a ServerNZ sync failure to an audited HTTP response. Shared by the upload
 * and download routes. Not a route file, so it may export freely.
 */
export async function respondToSyncError(
  error: unknown,
  memberId: string,
  direction: "upload" | "download",
): Promise<NextResponse> {
  if (error instanceof ServerNzNotConfiguredError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  await createAuditLog({
    action: `alpine_server.other_lodges.${direction}`,
    category: "lodge",
    severity: "important",
    outcome: "failure",
    memberId,
    summary: `Alpine Central Server ${direction} failed`,
    details:
      error instanceof ServerNzApiError
        ? `server responded ${error.status}: ${error.message}`
        : "connection error",
  });
  if (error instanceof ServerNzApiError) {
    return NextResponse.json(
      { error: `Central server error: ${error.message}` },
      { status: 502 },
    );
  }
  return NextResponse.json(
    { error: "Could not reach the Alpine Central Server." },
    { status: 502 },
  );
}
