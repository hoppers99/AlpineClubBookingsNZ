// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #2261 review: the button and the hook each had their own unit tests, but
// nothing pinned the WIRING between the panel and the button. Without this,
// hardcoding the link's state (or dropping the short code prop) stayed green
// while the Health Snapshot header told a disconnected admin that Xero was
// connected, or sent a connected admin to the wrong organisation.

const mockFetchJson = vi.fn();
const mockPostJson = vi.fn();
vi.mock("../api", () => ({
  fetchJson: (...a: unknown[]) => mockFetchJson(...a),
  postJson: (...a: unknown[]) => mockPostJson(...a),
}));

import { HealthAndDiagnosticsPanels } from "../health-diagnostics-panel";

function renderPanels(
  overrides: Partial<
    Parameters<typeof HealthAndDiagnosticsPanels>[0]
  > = {},
) {
  return render(
    <HealthAndDiagnosticsPanels
      connected
      currentXeroPath="/admin/xero"
      orgShortCode="!aBc12"
      healthOpen={false}
      contactGroupMismatchesOpen={false}
      contactLinkMismatchesOpen={false}
      onToggle={vi.fn()}
      onMessage={vi.fn()}
      onRefreshOperations={vi.fn()}
      refreshToken={0}
      scrollToSection={vi.fn()}
      {...overrides}
    />,
  );
}

function goToXeroLink() {
  return screen
    .getAllByRole("link")
    .find((el) => /Xero$/.test(el.textContent ?? "")) as HTMLAnchorElement;
}

describe("Health Snapshot 'Go to Xero' wiring (#2261)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchJson.mockResolvedValue({});
  });

  it("deep-links the Health Snapshot header into THIS organisation", () => {
    renderPanels({ orgShortCode: "!aBc12" });

    const link = goToXeroLink();
    expect(link.getAttribute("href")).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FDashboard%2F",
    );
    expect(link.textContent).toContain("Go to Xero");
  });

  it("falls back to the generic Xero link when no short code is known", () => {
    renderPanels({ orgShortCode: null });

    const link = goToXeroLink();
    expect(link.getAttribute("href")).toBe("https://go.xero.com/Dashboard/");
    expect(link.textContent).toContain("Go to Xero");
  });

  it("keeps the title neutral while the short code is still loading", () => {
    renderPanels({ orgShortCode: null, orgShortCodeLoading: true });

    expect(goToXeroLink().getAttribute("title")).toBe(
      "Opens Xero in a new tab.",
    );
  });

  // The panel takes a `connected` prop and defends on it everywhere else, so
  // the link must derive its promise from that prop rather than assume the
  // parent only renders this while connected.
  it("does not promise a connected organisation when it is not connected", () => {
    renderPanels({ connected: false, orgShortCode: null });

    const link = goToXeroLink();
    expect(link.textContent).toContain("Log in to Xero");
    expect(link.getAttribute("title")).toMatch(/not connected to this site/i);
  });
});
