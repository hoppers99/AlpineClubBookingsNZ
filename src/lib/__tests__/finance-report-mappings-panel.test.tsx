// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The panel reads the merged permission matrix off the session for its view-only
// gating (#1940); a finance:view stub is enough here since these cases only
// exercise the 403-load hide-the-panel backstop (#1548), never a save.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "u1",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "view",
          membership: "view",
          finance: "view",
          lodge: "view",
          content: "view",
          support: "view",
        },
      },
    },
  }),
}));

import { FinanceReportMappingsPanel } from "@/components/admin/finance-report-mappings-panel";

// Route either load into a finance-area denial; the other succeeds. A 403 on
// EITHER initial load must hide the whole panel quietly (#1548).
function stubFetch(denied: "mappings" | "chart-of-accounts") {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    const isMappings = url.includes("/api/admin/setup/finance-report-mappings");
    const isDenied =
      denied === "mappings" ? isMappings : url.includes("/api/admin/xero/chart-of-accounts");
    if (isDenied) {
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: "Forbidden" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () =>
        isMappings
          ? {
              categories: [],
              unmappedLines: [],
              snapshotCoverage: {
                latestProfitAndLossSnapshot: null,
                inspectedSnapshotCount: 0,
              },
            }
          : { accounts: [] },
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

/** A successful load carrying one revenue category, so its row renders. */
function stubLoadedFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/admin/setup/finance-report-mappings")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          categories: [
            {
              id: "cat-1",
              kind: "REVENUE",
              name: "Lodge fees",
              subtype: null,
              sortOrder: 0,
              archived: false,
              mappings: [],
            },
          ],
          unmappedLines: [],
          snapshotCoverage: {
            latestProfitAndLossSnapshot: null,
            inspectedSnapshotCount: 0,
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ accounts: [] }) };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// #2257 — one of only two production users of `describedByFieldHint` (rows in a
// `.map()` cannot call a hook per row). The id is derived, not generated, so a
// typo would orphan the hint with nothing else failing.
describe("FinanceReportMappingsPanel — subtype field hint (#2257)", () => {
  it("names the Subtype field and points it at its example hint", async () => {
    stubLoadedFetch();
    render(<FinanceReportMappingsPanel />);

    // The Label used to carry no `htmlFor` and the Input no `id`, so the field
    // had no accessible NAME at all; getByLabelText is the regression guard.
    const subtype = await screen.findByLabelText("Subtype");
    expect(subtype).toHaveAttribute("id", "finance-subtype-cat-1");

    const describedBy = subtype.getAttribute("aria-describedby");
    expect(describedBy).toBe("finance-subtype-hint-cat-1");
    // Resolve it: an id that points at nothing is exactly the orphan defect.
    expect(document.getElementById(describedBy ?? "")).toHaveTextContent(
      "Example: Operating",
    );
  });

  it("no longer parks the example inside the field as a placeholder", async () => {
    stubLoadedFetch();
    render(<FinanceReportMappingsPanel />);

    const subtype = await screen.findByLabelText("Subtype");
    expect(subtype.getAttribute("placeholder")).toBeNull();
  });
});

describe("FinanceReportMappingsPanel — graceful cross-area 403 (#1548)", () => {
  it("renders nothing on a 403 from the mappings load and shows no error", async () => {
    stubFetch("mappings");
    render(<FinanceReportMappingsPanel />);

    await waitFor(() => {
      expect(screen.queryByText("Finance Report Mappings")).toBeNull();
    });
    expect(screen.queryByText("Failed to load finance mappings")).toBeNull();
  });

  it("renders nothing on a 403 from the chart-of-accounts load too", async () => {
    stubFetch("chart-of-accounts");
    render(<FinanceReportMappingsPanel />);

    await waitFor(() => {
      expect(screen.queryByText("Finance Report Mappings")).toBeNull();
    });
    expect(screen.queryByText("Failed to load Xero chart of accounts")).toBeNull();
  });
});
