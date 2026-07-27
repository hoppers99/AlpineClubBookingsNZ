import { afterEach, describe, expect, it } from "vitest";
import { formatReferenceCacheLabel } from "../_components/shared";

// #2256: this label was built from bare `toLocaleString()` calls, so the Xero
// account/item cache stamps rendered in the admin's own browser locale and zone
// ("4/16/2026, 11:30 AM" for a US-locale admin, and the previous day for anyone
// behind New Zealand). Cache freshness is judged against the club's clock.
describe("formatReferenceCacheLabel (#2256)", () => {
  // 2026-04-15T23:30:00Z is 2026-04-16 11:30 in Pacific/Auckland.
  const CACHE = {
    source: "database" as const,
    lastRefreshedAt: "2026-04-15T23:30:00.000Z",
    expiresAt: "2026-04-16T11:30:00.000Z",
  };
  const RUNTIME_TZ = process.env.TZ;

  afterEach(() => {
    if (RUNTIME_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = RUNTIME_TZ;
  });

  it("renders both stamps as NZ date-times regardless of the runtime zone", () => {
    process.env.TZ = "UTC";
    const label = formatReferenceCacheLabel("Accounts", CACHE);
    expect(label).toContain("Accounts: shared cache");
    expect(label).toContain("refreshed 16 Apr 2026");
    expect(label).toContain("expires 16 Apr 2026");
    // The UTC calendar date at the refresh instant, which the old bare
    // toLocaleString() would have shown to a UTC-clocked browser.
    expect(label).not.toContain("15 Apr 2026");
  });

  it("degrades to 'unknown' on an unparseable stamp instead of throwing", () => {
    const label = formatReferenceCacheLabel("Accounts", {
      ...CACHE,
      expiresAt: "not-a-date",
    });
    expect(label).toContain("refreshed 16 Apr 2026");
    expect(label).toContain("expires unknown");
  });

  it("keeps the no-metadata message", () => {
    expect(formatReferenceCacheLabel("Items", null)).toBe(
      "Items: no cache metadata yet",
    );
  });
});
