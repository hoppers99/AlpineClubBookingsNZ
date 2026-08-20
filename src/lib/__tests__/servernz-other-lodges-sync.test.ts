import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    otherLodge: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

const mockUploadOtherLodges = vi.fn();
const mockPullOtherLodges = vi.fn();

vi.mock("@/lib/servernz-api", () => ({
  uploadOtherLodges: (...args: unknown[]) => mockUploadOtherLodges(...args),
  pullOtherLodges: (...args: unknown[]) => mockPullOtherLodges(...args),
}));

const mockLoadSettings = vi.fn();
const mockRecordUpload = vi.fn();
const mockRecordDownload = vi.fn();

vi.mock("@/lib/servernz-settings", () => ({
  loadServerNzSettings: (...args: unknown[]) => mockLoadSettings(...args),
  recordOtherLodgesUpload: (...args: unknown[]) => mockRecordUpload(...args),
  recordOtherLodgesDownload: (...args: unknown[]) => mockRecordDownload(...args),
}));

import {
  uploadOtherClubsToServer,
  downloadOtherClubsFromServer,
} from "@/lib/servernz-other-lodges-sync";

// ── Fixtures ───────────────────────────────────────────────────────────────

const SETTINGS = {
  baseUrl: "https://central.test",
  otherLodgesEnabled: true,
  otherLodgesLastUploadAt: null as string | null,
  otherLodgesLastDownloadAt: null as string | null,
  otherLodgesCursor: null as string | null,
};

/** A row as the central server sends it. */
const REMOTE_UPDATED_AT = "2026-08-14T00:00:00.000Z";

function remoteLodge(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    updatedAt: REMOTE_UPDATED_AT,
    location: "Whakapapa",
    bookingOfficerName: "Ann Officer",
    bookingOfficerEmail: "bookings@club.test",
    bookingOfficerPhone: "+64 27 422 4115",
    bedCapacity: 24,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadSettings.mockResolvedValue({ ...SETTINGS });
  mockUpsert.mockResolvedValue({});
  mockUpdate.mockResolvedValue({});
  mockRecordUpload.mockResolvedValue(undefined);
  mockRecordDownload.mockResolvedValue(undefined);
});

// ── Upload ─────────────────────────────────────────────────────────────────

describe("uploadOtherClubsToServer", () => {
  it("sends nothing and leaves the watermark alone when no row changed", async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await uploadOtherClubsToServer();

    expect(mockUploadOtherLodges).not.toHaveBeenCalled();
    // A quiet day must not advance the watermark — doing so would skip a row
    // edited between this read and the next run.
    expect(mockRecordUpload).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  it("sends only rows changed since the watermark and advances it to the newest updatedAt", async () => {
    const older = new Date("2026-08-01T00:00:00.000Z");
    const newer = new Date("2026-08-14T00:00:00.000Z");
    mockLoadSettings.mockResolvedValue({
      ...SETTINGS,
      otherLodgesLastUploadAt: "2026-07-01T00:00:00.000Z",
    });
    mockFindMany.mockResolvedValue([
      { ...remoteLodge("Aorangi Ski Club"), updatedAt: older },
      { ...remoteLodge("Arlberg Ski Club"), updatedAt: newer },
    ]);
    mockUploadOtherLodges.mockResolvedValue({
      created: 1,
      updated: 1,
      unchanged: 0,
      skipped: 0,
      results: [],
    });

    const result = await uploadOtherClubsToServer();

    // Incremental: the query is bounded by the stored watermark, not the whole table.
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { updatedAt: { gt: new Date("2026-07-01T00:00:00.000Z") } },
      }),
    );
    expect(result.sent).toBe(2);
    // The watermark advances to the newest row actually sent, on the database's
    // own clock — never to wall-clock now(), which could outrun an uncommitted edit.
    expect(mockRecordUpload).toHaveBeenCalledWith(newer);
  });
});

// ── Download ───────────────────────────────────────────────────────────────

describe("downloadOtherClubsFromServer", () => {
  it("passes the stored cursor up and records the one the server returns", async () => {
    mockLoadSettings.mockResolvedValue({ ...SETTINGS, otherLodgesCursor: "c-100" });
    mockPullOtherLodges.mockResolvedValue({ lodges: [], count: 0, cursor: "c-200", dropped: 0 });

    const result = await downloadOtherClubsFromServer();

    expect(mockPullOtherLodges).toHaveBeenCalledWith("c-100");
    expect(mockRecordDownload).toHaveBeenCalledWith("c-200");
    expect(result).toEqual({
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      keptLocal: 0,
      dropped: 0,
    });
  });

  it("upserts a row it has not seen, so a concurrent writer cannot break the merge", async () => {
    // The read-then-write is not atomic: an admin pressing Download while the
    // 03:00 cron runs can insert the same unique `name` in the gap. A plain
    // create would raise P2002 and abandon the merge before the cursor advanced.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Ngauruhoe Ski Club")],
      count: 1,
      cursor: "c-201",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue(null);

    const result = await downloadOtherClubsFromServer();

    expect(mockUpsert).toHaveBeenCalledWith({
      where: { name: "Ngauruhoe Ski Club" },
      create: expect.objectContaining({ name: "Ngauruhoe Ski Club", bedCapacity: 24 }),
      update: expect.objectContaining({ bedCapacity: 24 }),
    });
    expect(result.created).toBe(1);
  });

  it("writes a row whose data differs", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "c-202",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue({
      id: "ol_1",
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 24,
    });

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "ol_1" },
      data: expect.objectContaining({ bedCapacity: 30 }),
    });
    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
  });

  it("leaves an identical row untouched so updatedAt is not bumped and it is not re-uploaded", async () => {
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Arlberg Ski Club")],
      count: 1,
      cursor: "c-203",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue({
      id: "ol_2",
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 24,
    });

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });
});

// ── Keeping `updatedAt` honest ─────────────────────────────────────────────
//
// The upload watermark is derived from `updatedAt`, so anything that writes a
// misleading value there corrupts the next upload's idea of "changed locally".

describe("sync loop hygiene", () => {
  it("stamps a downloaded row with the SERVER's updatedAt, not now()", async () => {
    // Otherwise Prisma's @updatedAt marks a row we merely RECEIVED as edited
    // right now, and the next upload sends it straight back as this club's work.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "c-300",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue({
      id: "ol_1",
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 24,
    });

    await downloadOtherClubsFromServer();

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "ol_1" },
      data: expect.objectContaining({
        bedCapacity: 30,
        updatedAt: new Date(REMOTE_UPDATED_AT),
      }),
    });
  });

  it("does not overwrite a local edit that is newer than the server's copy", async () => {
    // Upload runs before download in one pass, so an admin editing a row in
    // between would otherwise have it clobbered by the copy the server already
    // held — and the stale value would then be uploaded as authoritative.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Aorangi Ski Club", { bedCapacity: 30 })],
      count: 1,
      cursor: "c-301",
      dropped: 0,
    });
    mockFindUnique.mockResolvedValue({
      id: "ol_1",
      // Edited locally AFTER the timestamp the server is reporting.
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
      location: "Whakapapa",
      bookingOfficerName: "Ann Officer",
      bookingOfficerEmail: "bookings@club.test",
      bookingOfficerPhone: "+64 27 422 4115",
      bedCapacity: 24,
    });

    const result = await downloadOtherClubsFromServer();

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, keptLocal: 1 });
  });

  it("holds the upload watermark below a row the server rejected", async () => {
    // Advancing past a skipped row is how a rejection becomes permanent: it is
    // never re-sent, so it silently never reaches the registry (INV-INT-004).
    const rejected = new Date("2026-08-10T00:00:00.000Z");
    const accepted = new Date("2026-08-14T00:00:00.000Z");
    mockFindMany.mockResolvedValue([
      { ...remoteLodge("Rejected Club"), updatedAt: rejected },
      { ...remoteLodge("Accepted Club"), updatedAt: accepted },
    ]);
    mockUploadOtherLodges.mockResolvedValue({
      created: 1,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      results: [
        { name: "Rejected Club", status: "skipped", reason: "duplicate" },
        { name: "Accepted Club", status: "created" },
      ],
    });

    await uploadOtherClubsToServer();

    // Strictly BELOW the rejected row, even though a newer row was accepted, so
    // the next run re-sends it rather than stepping over it forever.
    const [watermark] = mockRecordUpload.mock.calls[0];
    expect(watermark.getTime()).toBeLessThan(rejected.getTime());
  });

  it("does not advance the watermark when every row was rejected", async () => {
    const only = new Date("2026-08-10T00:00:00.000Z");
    mockFindMany.mockResolvedValue([{ ...remoteLodge("Rejected Club"), updatedAt: only }]);
    mockUploadOtherLodges.mockResolvedValue({
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      results: [{ name: "Rejected Club", status: "skipped", reason: "duplicate" }],
    });

    await uploadOtherClubsToServer();

    expect(mockRecordUpload).not.toHaveBeenCalled();
  });
});
