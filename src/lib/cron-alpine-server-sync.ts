import "server-only";
import {
  uploadOtherClubsToServer,
  downloadOtherClubsFromServer,
  type UploadSummary,
  type DownloadSummary,
} from "@/lib/servernz-other-lodges-sync";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { ServerNzNotConfiguredError } from "@/lib/servernz-api";
import logger from "@/lib/logger";

/**
 * Daily bidirectional Other Clubs sync with the Alpine Central Server.
 *
 * Runs upload then download so a single pass reconciles both ends: the upload
 * pushes local rows changed since the last upload watermark, and the download
 * pulls the centrally-distributed rows changed since the last cursor. Both
 * directions are incremental (see servernz-other-lodges-sync), so a quiet day
 * makes at most one cheap request per direction and writes nothing.
 *
 * Scheduled at 03:00 daily by the cron leader (POST /api/cron/alpine-server-sync).
 */

export interface AlpineServerSyncResult {
  status: "synced" | "skipped";
  reason?: string;
  upload?: UploadSummary;
  download?: DownloadSummary;
}

export async function syncOtherClubsWithServer(): Promise<AlpineServerSyncResult> {
  // The module flag is checked HERE as well as on the admin routes, because this
  // path never passes through the route-feature gate: the cron endpoint is
  // authenticated with CRON_SECRET, not a session, so no prefix rule can cover
  // it. Without this check, switching the module off in Admin -> Modules would
  // 404 the setup page while the nightly job carried on uploading — which for a
  // feature that sends contact details to a third party is the failure that
  // matters most (INV-CONFIG-001).
  const flags = await loadEffectiveModuleFlags();
  if (!flags.alpineCentralServer) {
    return { status: "skipped", reason: "module-disabled" };
  }

  const settings = await loadServerNzSettings();

  // Only sync clubs that have opted in and pointed at a server. Missing API key
  // surfaces below as ServerNzNotConfiguredError and is treated the same way.
  if (!settings.otherLodgesEnabled) {
    return { status: "skipped", reason: "other-lodges-sync-disabled" };
  }
  if (!settings.baseUrl) {
    return { status: "skipped", reason: "central-server-not-configured" };
  }

  try {
    // Upload first so any local edits land centrally before we pull the merged
    // distributed set back down.
    const upload = await uploadOtherClubsToServer();
    const download = await downloadOtherClubsFromServer();
    logger.info(
      {
        job: "alpine-server-other-lodges-sync",
        uploadSent: upload.sent,
        uploadCreated: upload.created,
        uploadUpdated: upload.updated,
        downloadFetched: download.fetched,
        downloadCreated: download.created,
        downloadUpdated: download.updated,
      },
      "Alpine Central Server Other Clubs sync complete",
    );
    return { status: "synced", upload, download };
  } catch (err) {
    if (err instanceof ServerNzNotConfiguredError) {
      return { status: "skipped", reason: "central-server-not-configured" };
    }
    throw err;
  }
}
