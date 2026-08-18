import "server-only";
import { prisma } from "@/lib/prisma";
import {
  uploadOtherLodges,
  pullOtherLodges,
  type OtherLodgesUploadResult,
} from "@/lib/servernz-api";
import {
  loadServerNzSettings,
  recordOtherLodgesUpload,
  recordOtherLodgesDownload,
} from "@/lib/servernz-settings";

/**
 * Sync the local "Other lodges" registry (the club's Other Clubs details) with
 * the Alpine Central Server. Upload pushes this club's entries up; download
 * pulls the centrally-distributed set down and merges it into the local
 * registry, keyed by the unique lodge name.
 */

export interface UploadSummary extends OtherLodgesUploadResult {
  /** Local rows considered for upload (changed since the last upload). */
  sent: number;
}

// The contact/capacity columns that carry a lodge's data. Kept in one place so
// the upload projection and the download diff stay in step.
const LODGE_DATA_SELECT = {
  location: true,
  bookingOfficerName: true,
  bookingOfficerEmail: true,
  bookingOfficerPhone: true,
  bedCapacity: true,
} as const;

/**
 * Push the club's changed Other Clubs entries to the central server.
 *
 * Incremental: only rows whose `updatedAt` is newer than the last upload
 * watermark (`otherLodgesLastUploadAt`) are sent — new and edited rows, never
 * the whole table. On the first upload (no watermark) every row is sent. When
 * nothing has changed, no request is made and the watermark is left untouched.
 */
export async function uploadOtherClubsToServer(): Promise<UploadSummary> {
  const settings = await loadServerNzSettings();
  const since = settings.otherLodgesLastUploadAt
    ? new Date(settings.otherLodgesLastUploadAt)
    : null;

  const lodges = await prisma.otherLodge.findMany({
    where: since ? { updatedAt: { gt: since } } : {},
    select: { name: true, updatedAt: true, ...LODGE_DATA_SELECT },
    orderBy: { name: "asc" },
  });

  if (lodges.length === 0) {
    // Nothing changed since the last upload — skip the round-trip entirely.
    return { created: 0, updated: 0, unchanged: 0, skipped: 0, results: [], sent: 0 };
  }

  const result = await uploadOtherLodges(
    lodges.map((l) => ({
      name: l.name,
      location: l.location,
      bookingOfficerName: l.bookingOfficerName,
      bookingOfficerEmail: l.bookingOfficerEmail,
      bookingOfficerPhone: l.bookingOfficerPhone,
      bedCapacity: l.bedCapacity,
    })),
  );

  // Advance the watermark to the newest `updatedAt` we just sent. Any row edited
  // after this read has a larger `updatedAt` and is caught on the next upload.
  const watermark = lodges.reduce(
    (max, l) => (l.updatedAt > max ? l.updatedAt : max),
    lodges[0].updatedAt,
  );
  await recordOtherLodgesUpload(watermark);
  return { ...result, sent: lodges.length };
}

export interface DownloadSummary {
  fetched: number;
  created: number;
  updated: number;
  /** Fetched rows already identical locally — left untouched (no `updatedAt` bump). */
  unchanged: number;
}

/**
 * Pull the distributed Other Clubs set and merge it into the local registry.
 * Incremental in two ways: the stored cursor means only entries the server
 * changed since last time are fetched, and a fetched row is only written when
 * its data actually differs from the local copy — so an unchanged row keeps its
 * `updatedAt` and is never needlessly re-uploaded. Keyed by unique lodge name.
 */
export async function downloadOtherClubsFromServer(): Promise<DownloadSummary> {
  const settings = await loadServerNzSettings();
  const pull = await pullOtherLodges(settings.otherLodgesCursor);

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const lodge of pull.lodges) {
    const existing = await prisma.otherLodge.findUnique({
      where: { name: lodge.name },
      select: { id: true, ...LODGE_DATA_SELECT },
    });
    const data = {
      location: lodge.location,
      bookingOfficerName: lodge.bookingOfficerName,
      bookingOfficerEmail: lodge.bookingOfficerEmail,
      bookingOfficerPhone: lodge.bookingOfficerPhone,
      bedCapacity: lodge.bedCapacity,
    };
    if (!existing) {
      // Upsert, not create: `name` is unique and this read-then-write is not
      // atomic, so a concurrent writer (an admin pressing Download while the
      // 03:00 cron runs, or the two directions of a manual double-click) can
      // insert the same name in the gap and turn a plain create into a P2002
      // that aborts the whole merge part-way — after some rows were written and
      // before the cursor advanced, so the next run re-fetches from the old
      // cursor. The upsert lets the loser of that race fall through to the same
      // update it would have made, and stays correct when it wins.
      await prisma.otherLodge.upsert({
        where: { name: lodge.name },
        create: { name: lodge.name, ...data },
        update: data,
      });
      created++;
    } else if (
      existing.location !== data.location ||
      existing.bookingOfficerName !== data.bookingOfficerName ||
      existing.bookingOfficerEmail !== data.bookingOfficerEmail ||
      existing.bookingOfficerPhone !== data.bookingOfficerPhone ||
      existing.bedCapacity !== data.bedCapacity
    ) {
      // Prisma's `@updatedAt` stamps the row's Last Updated on this write.
      await prisma.otherLodge.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      unchanged++;
    }
  }

  await recordOtherLodgesDownload(pull.cursor);
  return { fetched: pull.count, created, updated, unchanged };
}
