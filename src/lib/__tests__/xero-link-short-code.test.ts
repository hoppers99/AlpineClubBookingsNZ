import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2314: the server-side twin of the `useXeroOrgShortCode` hook — the one place
 * a server producer reaches for the organisation short code that makes a Xero
 * deep link land in THIS club's books.
 *
 * Two contracts matter here. It must never take a caller down (a decoration
 * cannot break an alert or a list endpoint), and `confirmLive` must mean what
 * it says for the one surface that cannot re-render.
 */

const h = vi.hoisted(() => ({
  getXeroConnectedOrganisation: vi.fn(),
}));

vi.mock("@/lib/xero-organisation", () => ({
  getXeroConnectedOrganisation: h.getXeroConnectedOrganisation,
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    name: "Alpine Club",
    financialYearEndMonth: 3,
    shortCode: "!aBc12",
    readFailure: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getXeroConnectedOrganisation.mockResolvedValue(summary());
});

describe("getXeroOrgShortCode", () => {
  it("reads the shared cache by default", async () => {
    await expect(getXeroOrgShortCode()).resolves.toBe("!aBc12");
    expect(h.getXeroConnectedOrganisation).toHaveBeenCalledWith(false);
  });

  it("returns null rather than throwing when the read blows up", async () => {
    h.getXeroConnectedOrganisation.mockRejectedValue(new Error("boom"));

    await expect(getXeroOrgShortCode()).resolves.toBeNull();
  });

  // A screen re-renders, so a cached summary left over from a failed read is
  // the right trade there — it keeps a still-good short code rather than
  // blanking every link over one blip.
  it("keeps a cached short code through a failed read for ordinary callers", async () => {
    h.getXeroConnectedOrganisation.mockResolvedValue(
      summary({ readFailure: { kind: "UNAVAILABLE" } }),
    );

    await expect(getXeroOrgShortCode()).resolves.toBe("!aBc12");
  });

  // …but an email cannot re-render, and `organisationlogin?shortcode=` SWITCHES
  // the reader's Xero session, so a stale code is worse than none.
  it("confirms the organisation live when asked", async () => {
    await expect(getXeroOrgShortCode({ confirmLive: true })).resolves.toBe(
      "!aBc12",
    );
    expect(h.getXeroConnectedOrganisation).toHaveBeenCalledWith(true);
  });

  it("names no organisation when a confirmed read fails", async () => {
    // The failure path degrades to the LAST KNOWN summary, so the short code
    // here is the previous connection's. Confirming must not launder it.
    h.getXeroConnectedOrganisation.mockResolvedValue(
      summary({ shortCode: "!old99", readFailure: { kind: "UNAVAILABLE" } }),
    );

    await expect(getXeroOrgShortCode({ confirmLive: true })).resolves.toBeNull();
  });

  it("still returns null rather than throwing on a confirmed read", async () => {
    h.getXeroConnectedOrganisation.mockRejectedValue(new Error("boom"));

    await expect(getXeroOrgShortCode({ confirmLive: true })).resolves.toBeNull();
  });
});
