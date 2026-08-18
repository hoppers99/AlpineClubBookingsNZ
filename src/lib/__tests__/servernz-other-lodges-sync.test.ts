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
function remoteLodge(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
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
      { name: "Aorangi Ski Club", updatedAt: older, ...remoteLodge("x") },
      { name: "Arlberg Ski Club", updatedAt: newer, ...remoteLodge("y") },
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
    mockPullOtherLodges.mockResolvedValue({ lodges: [], count: 0, cursor: "c-200" });

    const result = await downloadOtherClubsFromServer();

    expect(mockPullOtherLodges).toHaveBeenCalledWith("c-100");
    expect(mockRecordDownload).toHaveBeenCalledWith("c-200");
    expect(result).toEqual({ fetched: 0, created: 0, updated: 0, unchanged: 0 });
  });

  it("upserts a row it has not seen, so a concurrent writer cannot break the merge", async () => {
    // The read-then-write is not atomic: an admin pressing Download while the
    // 03:00 cron runs can insert the same unique `name` in the gap. A plain
    // create would raise P2002 and abandon the merge before the cursor advanced.
    mockPullOtherLodges.mockResolvedValue({
      lodges: [remoteLodge("Ngauruhoe Ski Club")],
      count: 1,
      cursor: "c-201",
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
    });
    mockFindUnique.mockResolvedValue({
      id: "ol_1",
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
    });
    mockFindUnique.mockResolvedValue({
      id: "ol_2",
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
