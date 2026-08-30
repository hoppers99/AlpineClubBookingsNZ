import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The report-mapping editor's new home (D-C8-1; epic #213 C8, #223).
 *
 * It used to render only inside `/admin/setup/finance`, one of the four hubs
 * the legacy-surfaces switch hides — so retiring the checklist would have left
 * the club's revenue and expense report groups with no editor at all. This
 * suite is the destination half of that move; the origin half (the hub no
 * longer rendering it, and redirecting here) is in `admin-setup-hubs.test.tsx`
 * and `setup-hub-page-redirect.test.ts`.
 *
 * SCOPE: this file is about WHERE the panel is and how it is presented, not
 * about the dashboard. `FinanceDashboardClient` and the page model are stubbed
 * — both have their own suites — so a failure here means the relocation broke
 * rather than that finance reporting did.
 */

const mockRequireFinanceViewer = vi.fn();
vi.mock("@/lib/finance-auth", () => ({
  requireFinanceViewer: (...args: unknown[]) =>
    mockRequireFinanceViewer(...args),
}));

const mockBuildModel = vi.fn();
vi.mock("@/lib/finance-dashboard-page", () => ({
  buildFinanceDashboardPageModel: (...args: unknown[]) =>
    mockBuildModel(...args),
}));

vi.mock(
  "@/app/(finance)/finance/_components/finance-dashboard-client",
  () => ({
    FinanceDashboardClient: () => <div>Finance dashboard</div>,
  }),
);

// The panel is a client component whose view-only gate reads `useSession`, and
// this suite renders a SERVER page to static markup with no SessionProvider.
// Stubbed for the same reason `admin-setup-hubs.test.tsx` stubs it; the panel's
// own behaviour is covered by `finance-report-mappings-panel.test.tsx`.
vi.mock("@/components/admin/finance-report-mappings-panel", () => ({
  FinanceReportMappingsPanel: () => <div>Finance mappings editor</div>,
}));

import FinancePage from "@/app/(finance)/finance/page";

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireFinanceViewer.mockResolvedValue({ id: "member1" });
  mockBuildModel.mockResolvedValue({});
});

describe("the finance dashboard page (#223, D-C8-1)", () => {
  it("carries the report-mapping editor, under an anchor the sync-health link targets", async () => {
    const html = renderToStaticMarkup(await FinancePage({}));

    expect(html).toContain("Finance dashboard");
    expect(html).toContain("Finance Report Mappings");
    // `finance-sync-health.ts` links at `/finance#finance-report-mappings`; an
    // id that moved would leave that link scrolling nowhere.
    expect(html).toContain('id="finance-report-mappings"');
  });

  it("keeps it collapsed, so the dashboard's own load costs nothing extra", async () => {
    const html = renderToStaticMarkup(await FinancePage({}));

    expect(html).toContain('aria-expanded="false"');
    // The accordion does not mount its content until it is opened — which is
    // what makes "collapsed by default" a saved fetch rather than just a saved
    // scroll, and is exactly how it behaved on the hub it came from.
    expect(html).not.toContain("Finance mappings editor");
  });

  it("admits nobody the finance area does not already admit", async () => {
    // No widening: the page's own guard is unchanged and still runs first, so
    // relocating the editor gave no one access they did not have.
    await FinancePage({});
    expect(mockRequireFinanceViewer).toHaveBeenCalledWith("/finance");
  });
});
