import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getXeroConnectedOrganisation: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () => ({ ok: true as const, session: null }),
}));

vi.mock("@/lib/xero-organisation", () => ({
  getXeroConnectedOrganisation: mocks.getXeroConnectedOrganisation,
}));

import { GET } from "@/app/api/admin/xero/organisation/route";

// #2261: the organisation route is where the deep-link SHORT CODE is surfaced —
// not /api/admin/xero/status, which is a pure token-row read hit by every admin
// surface that gates on Xero and must stay free of live Xero calls.
describe("GET /api/admin/xero/organisation", () => {
  beforeEach(() => {
    mocks.getXeroConnectedOrganisation.mockReset();
  });

  it("returns the name, year-end month, and short code", async () => {
    mocks.getXeroConnectedOrganisation.mockResolvedValue({
      name: "Alpine Club",
      financialYearEndMonth: 3,
      shortCode: "!aBc12",
    });

    const res = await GET(
      new NextRequest("https://club.example.org/api/admin/xero/organisation"),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      name: "Alpine Club",
      financialYearEndMonth: 3,
      shortCode: "!aBc12",
    });
    // No forced refresh, so the 12-hour in-process cache still serves the read.
    expect(mocks.getXeroConnectedOrganisation).toHaveBeenCalledWith(false);
  });

  it("returns a null short code when Xero did not report one", async () => {
    mocks.getXeroConnectedOrganisation.mockResolvedValue({
      name: null,
      financialYearEndMonth: null,
      shortCode: null,
    });

    const res = await GET(
      new NextRequest("https://club.example.org/api/admin/xero/organisation"),
    );

    await expect(res.json()).resolves.toEqual({
      name: null,
      financialYearEndMonth: null,
      shortCode: null,
    });
  });

  it("honours ?refresh=1 so a reconnect cannot serve the old org's short code", async () => {
    mocks.getXeroConnectedOrganisation.mockResolvedValue({
      name: "Alpine Club",
      financialYearEndMonth: 3,
      shortCode: "!aBc12",
    });

    await GET(
      new NextRequest(
        "https://club.example.org/api/admin/xero/organisation?refresh=1",
      ),
    );

    expect(mocks.getXeroConnectedOrganisation).toHaveBeenCalledWith(true);
  });
});
