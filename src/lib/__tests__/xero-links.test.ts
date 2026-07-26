import { describe, expect, it } from "vitest";
import { buildXeroDashboardUrl, buildXeroReportsUrl } from "@/lib/xero-links";

// #2261: the "Go to Xero" buttons on the Xero Sync page and its Health
// Snapshot. Both forms must be live URLs — the short code only makes the link
// land in the RIGHT organisation, its absence must never produce a dead link.
describe("buildXeroDashboardUrl", () => {
  it("links to the session-scoped Xero dashboard without a short code", () => {
    expect(buildXeroDashboardUrl()).toBe("https://go.xero.com/Dashboard/");
  });

  it("treats a null/empty short code as absent (fallback link)", () => {
    expect(buildXeroDashboardUrl({ shortCode: null })).toBe(
      "https://go.xero.com/Dashboard/"
    );
    expect(buildXeroDashboardUrl({ shortCode: "" })).toBe(
      "https://go.xero.com/Dashboard/"
    );
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroDashboardUrl({ shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FDashboard%2F"
    );
  });
});

describe("buildXeroReportsUrl", () => {
  it("links to the session-scoped Xero report centre without a short code", () => {
    expect(buildXeroReportsUrl()).toBe("https://go.xero.com/Reports/");
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroReportsUrl({ shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FReports%2F"
    );
  });
});
