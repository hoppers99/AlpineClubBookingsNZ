// @vitest-environment jsdom

// #2256: on /admin/family-groups the create/edit form renders ABOVE the groups
// table, so pressing a row's Edit button several screens down opened the editor
// entirely off-screen — the viewport never moved and the button looked dead.
// These cases pin the fix: opening edit mode moves focus and the viewport to
// the editor region, and the row that is being edited says so.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

const EDIT_EVERYTHING: AdminPermissionMatrix = {
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "edit",
  support: "edit",
};

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "u1", adminPermissionMatrix: EDIT_EVERYTHING } },
    status: "authenticated",
  }),
}));

const routerReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// Imported after the mocks are registered.
import FamilyGroupsPage from "@/app/(admin)/admin/family-groups/page";

const KEA = {
  id: "g1",
  name: "Kea Family",
  members: [],
  memberCount: 0,
  inactiveCount: 0,
  pendingRequests: 0,
  createdAt: "2026-04-15T23:30:00.000Z",
};
const TUI = { ...KEA, id: "g2", name: "Tui Family" };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("/api/admin/family-groups/requests")) {
        return jsonResponse({ requests: [] });
      }
      if (url.startsWith("/api/admin/family-groups/partner-invites")) {
        return jsonResponse({ invites: [] });
      }
      // The inline editor's own detail fetch returns the group directly.
      if (url.startsWith("/api/admin/family-groups/g")) {
        const id = url.includes("g2") ? "g2" : "g1";
        return jsonResponse({
          id,
          name: id === "g2" ? "Tui Family" : "Kea Family",
          createdAt: KEA.createdAt,
          members: [],
        });
      }
      if (url.startsWith("/api/admin/family-groups")) {
        return jsonResponse({ familyGroups: [KEA, TUI] });
      }
      if (url.startsWith("/api/admin/members")) {
        return jsonResponse({ members: [] });
      }
      throw new Error(`Unstubbed fetch in test: ${url}`);
    }),
  );
}

describe("FamilyGroupsPage edit focus (#2256)", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: unknown;

  beforeEach(() => {
    stubFetch();
    // jsdom does not implement scrollIntoView, so install a spy in its place
    // (the hook guards on `typeof … === "function"`, which is exactly why the
    // real defect could not be caught without one).
    originalScrollIntoView = (
      Element.prototype as unknown as { scrollIntoView?: unknown }
    ).scrollIntoView;
    scrollIntoView = vi.fn();
    (
      Element.prototype as unknown as { scrollIntoView: unknown }
    ).scrollIntoView = scrollIntoView;
  });

  afterEach(async () => {
    cleanup();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    (
      Element.prototype as unknown as { scrollIntoView?: unknown }
    ).scrollIntoView = originalScrollIntoView;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("moves focus and the viewport to the editor when a row's Edit is clicked", async () => {
    render(<FamilyGroupsPage />);

    const edit = await screen.findByRole("button", { name: /Edit Kea Family/i });
    // Nothing is being edited yet, so there is no named editor region.
    expect(
      screen.queryByRole("region", { name: /Editing Kea Family/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(edit);

    const region = await screen.findByRole("region", {
      name: /Editing Kea Family/i,
    });
    // Focus lands on the editor region rather than staying on the row button
    // that is now scrolled off the bottom of the page.
    await waitFor(() => expect(region).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView.mock.instances[0]).toBe(region);
    // scroll-mt-20 (5rem) keeps the region clear of the sticky admin header.
    expect(region).toHaveClass("scroll-mt-20");
  });

  it("marks the row being edited so edit mode is unmistakable", async () => {
    render(<FamilyGroupsPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Edit Kea Family/i }),
    );

    const badge = await screen.findByText("Editing");
    const row = badge.closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("Kea Family");
    expect(row).toHaveAttribute("aria-current", "true");
    // Only the edited row is marked.
    expect(screen.getAllByText("Editing")).toHaveLength(1);
    expect(
      screen.getByText("Tui Family").closest("tr"),
    ).not.toHaveAttribute("aria-current");
  });

  it("re-anchors when the admin switches straight to another group's Edit", async () => {
    render(<FamilyGroupsPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Edit Kea Family/i }),
    );
    await screen.findByRole("region", { name: /Editing Kea Family/i });
    const callsAfterFirst = scrollIntoView.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /Edit Tui Family/i }));

    const region = await screen.findByRole("region", {
      name: /Editing Tui Family/i,
    });
    await waitFor(() =>
      expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsAfterFirst),
    );
    await waitFor(() => expect(region).toHaveFocus());
  });

  it("renders family-group dates in the NZ calendar, never the browser locale", async () => {
    render(<FamilyGroupsPage />);

    // 2026-04-15T23:30Z is 16 April in New Zealand; a bare toLocaleDateString()
    // would render "4/16/2026" (US locale) or "15/04/2026" (behind NZ).
    const created = await screen.findAllByText("16 Apr 2026");
    expect(created.length).toBeGreaterThan(0);
  });
});
