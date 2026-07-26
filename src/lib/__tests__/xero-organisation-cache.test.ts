import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getXeroConnectedOrganisation,
  resetXeroOrganisationCachesForTests,
} from "@/lib/xero-organisation";
import { invalidateXeroOrganisationCaches } from "@/lib/xero-organisation-cache-bus";

// CORRECTNESS-F1: the connected-org summary is cached in-process for hours. A
// disconnect → reconnect to a DIFFERENT org must not keep serving the OLD org's
// name (the exact mistake the wizard's right-org step exists to catch). The
// token store invalidates the cache via the bus; these pins prove the cache is
// honoured AND that invalidation forces a fresh read of the new org.
describe("xero-organisation cache invalidation (#2080 F1)", () => {
  const originalOrigin = process.env.XERO_MOCK_API_ORIGIN;

  function mockOrg(name: string, shortCode?: string | null) {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ name, financialYearEndMonth: 3, shortCode }),
    })) as unknown as typeof fetch;
  }

  beforeEach(() => {
    // Drive the mock-Xero organisation path (no live Xero / DB), non-production.
    vi.stubEnv("NODE_ENV", "test");
    process.env.XERO_MOCK_API_ORIGIN = "http://localhost:3000";
    resetXeroOrganisationCachesForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetXeroOrganisationCachesForTests();
    if (originalOrigin === undefined) delete process.env.XERO_MOCK_API_ORIGIN;
    else process.env.XERO_MOCK_API_ORIGIN = originalOrigin;
  });

  it("serves the cached org name until the cache is invalidated", async () => {
    mockOrg("Org A");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");

    // The org changed underneath, but without invalidation the cache still wins.
    mockOrg("Org B");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");
  });

  it("returns the NEW org name after a reconnect invalidates the cache", async () => {
    mockOrg("Org A");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");

    // Simulate the token store's reconnect-to-different-org invalidation.
    mockOrg("Org B");
    invalidateXeroOrganisationCaches();

    expect((await getXeroConnectedOrganisation()).name).toBe("Org B");
  });

  it("forceRefresh also bypasses the cache (belt-and-braces / ?refresh=1)", async () => {
    mockOrg("Org A");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");

    mockOrg("Org B");
    expect((await getXeroConnectedOrganisation(true)).name).toBe("Org B");
  });

  // #2261: the deep-link short code rides on the SAME cached summary, so it
  // must be cached and invalidated exactly like the name — a reconnect to a
  // different org must never keep pointing "Go to Xero" at the old org.
  describe("organisation short code (#2261)", () => {
    it("returns the short code when Xero reports one", async () => {
      mockOrg("Org A", "!aBc12");
      expect((await getXeroConnectedOrganisation()).shortCode).toBe("!aBc12");
    });

    it("is null when the short code is absent, blank, or not a string", async () => {
      mockOrg("Org A", undefined);
      expect((await getXeroConnectedOrganisation()).shortCode).toBeNull();

      resetXeroOrganisationCachesForTests();
      mockOrg("Org A", "   ");
      expect((await getXeroConnectedOrganisation()).shortCode).toBeNull();

      resetXeroOrganisationCachesForTests();
      global.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          name: "Org A",
          financialYearEndMonth: 3,
          shortCode: 42,
        }),
      })) as unknown as typeof fetch;
      expect((await getXeroConnectedOrganisation()).shortCode).toBeNull();
    });

    it("trims surrounding whitespace", async () => {
      mockOrg("Org A", "  !aBc12  ");
      expect((await getXeroConnectedOrganisation()).shortCode).toBe("!aBc12");
    });

    it("caches the short code and re-reads it after invalidation", async () => {
      mockOrg("Org A", "!orgA1");
      expect((await getXeroConnectedOrganisation()).shortCode).toBe("!orgA1");

      // Cached: the new org's short code is not picked up until invalidation.
      mockOrg("Org B", "!orgB2");
      expect((await getXeroConnectedOrganisation()).shortCode).toBe("!orgA1");

      invalidateXeroOrganisationCaches();
      const summary = await getXeroConnectedOrganisation();
      expect(summary.shortCode).toBe("!orgB2");
      expect(summary.name).toBe("Org B");
    });

    it("degrades to nulls when the organisation read fails with no cache", async () => {
      global.fetch = vi.fn(async () => ({
        ok: false,
        json: async () => ({}),
      })) as unknown as typeof fetch;

      const summary = await getXeroConnectedOrganisation();
      expect(summary.shortCode).toBeNull();
      expect(summary.name).toBeNull();
      expect(summary.financialYearEndMonth).toBeNull();
    });
  });
});
