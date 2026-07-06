import { beforeEach, describe, expect, it, vi } from "vitest";

const { getXeroSyncCursor } = vi.hoisted(() => ({
  getXeroSyncCursor: vi.fn(),
}));

vi.mock("@/lib/xero-sync-cursors", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/xero-sync-cursors")
  >("@/lib/xero-sync-cursors");
  return { ...actual, getXeroSyncCursor };
});

import { getXeroContactGroupCacheLastRefreshedAt } from "@/lib/xero-contact-groups";
import { DEFAULT_XERO_SYNC_SCOPE } from "@/lib/xero-sync-cursors";
import { CONTACT_GROUP_CACHE_CURSOR_RESOURCE } from "@/lib/xero-contact-cache";

describe("getXeroContactGroupCacheLastRefreshedAt", () => {
  beforeEach(() => {
    getXeroSyncCursor.mockReset();
  });

  it("reads the contact-group cache cursor with the same resource and scope the refresh writes", async () => {
    getXeroSyncCursor.mockResolvedValue({
      lastSuccessfulSyncAt: new Date("2026-07-05T09:30:00.000Z"),
    });

    const result = await getXeroContactGroupCacheLastRefreshedAt();

    expect(getXeroSyncCursor).toHaveBeenCalledWith(
      CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
      DEFAULT_XERO_SYNC_SCOPE
    );
    expect(result).toBe("2026-07-05T09:30:00.000Z");
  });

  it("returns null when the cache has never been refreshed", async () => {
    getXeroSyncCursor.mockResolvedValue(null);

    expect(await getXeroContactGroupCacheLastRefreshedAt()).toBeNull();
  });

  it("returns null when the cursor exists but has no successful sync timestamp", async () => {
    getXeroSyncCursor.mockResolvedValue({ lastSuccessfulSyncAt: null });

    expect(await getXeroContactGroupCacheLastRefreshedAt()).toBeNull();
  });
});
