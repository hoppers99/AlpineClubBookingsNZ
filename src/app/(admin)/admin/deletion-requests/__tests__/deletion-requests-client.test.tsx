// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// #1997: the client now derives view-only gating from the session matrix via
// useAdminAreaEditAccess. Mock an all-edit admin so the existing approve/reject
// action assertions (enabled buttons) hold.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import DeletionRequestsClient from "../deletion-requests-client";

interface LifecycleRow {
  id: string;
  status: string;
  reason: string;
  reviewNote: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  requestedByMemberId: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  targetName: string;
  member: { id: string; name: string; email: string } | null;
}

function buildFetchMock(
  lifecycleRequests: LifecycleRow[],
  lifecycleMeta: { total?: number; totalPages?: number } = {},
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/admin/member-lifecycle-action-requests")) {
      const params = new URL(url, "http://localhost").searchParams;
      return {
        ok: true,
        json: async () => ({
          requests: lifecycleRequests,
          total: lifecycleMeta.total ?? lifecycleRequests.length,
          page: Number(params.get("page") ?? "1"),
          pageSize: 25,
          totalPages: lifecycleMeta.totalPages ?? 1,
        }),
      };
    }
    // Self-service deletion-requests list: empty for these tests.
    return {
      ok: true,
      json: async () => ({
        requests: [],
        total: 0,
        page: 1,
        pageSize: 25,
        totalPages: 0,
      }),
    };
  });
}

function row(overrides: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    id: "del-1",
    status: "REQUESTED",
    reason: "Duplicate created in error",
    reviewNote: null,
    requestedAt: "2026-07-16T00:00:00.000Z",
    reviewedAt: null,
    requestedByMemberId: "admin-2",
    requestedBy: { id: "admin-2", name: "Other Admin", email: "o@a.test" },
    targetName: "Erroneous Record",
    member: null,
    ...overrides,
  };
}

describe("AdminInitiatedDeletionSection (#1938)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an admin-initiated DELETE request row", async () => {
    vi.stubGlobal("fetch", buildFetchMock([row()]));

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(screen.getByText("Erroneous Record")).not.toBeNull(),
    );
    expect(
      screen.getByText("Admin-initiated deletion requests"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeNull();
  });

  it("enables approve/reject for a request raised by a DIFFERENT admin", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock([row({ requestedByMemberId: "admin-2" })]),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(screen.getByText("Erroneous Record")).not.toBeNull(),
    );
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      screen.queryByText("A different admin must review this request"),
    ).toBeNull();
  });

  it("disables approve/reject with a note when the current admin is the requester", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock([row({ requestedByMemberId: "admin-1" })]),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(screen.getByText("Erroneous Record")).not.toBeNull(),
    );
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText("A different admin must review this request"),
    ).not.toBeNull();
  });

  it("sends a page param and shows pager controls when total exceeds one page", async () => {
    const fetchMock = buildFetchMock([row()], { total: 30, totalPages: 2 });
    vi.stubGlobal("fetch", fetchMock);

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(screen.getByText("Erroneous Record")).not.toBeNull(),
    );

    // Initial lifecycle fetch carries page=1.
    const lifecycleUrls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/admin/member-lifecycle-action-requests"));
    expect(lifecycleUrls.length).toBeGreaterThan(0);
    expect(lifecycleUrls[0]).toContain("page=1");

    // Pager renders both controls and the page indicator.
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).not.toBeNull();
    expect(screen.getByRole("button", { name: "Previous" })).not.toBeNull();
    expect(screen.getByText("Page 1 of 2")).not.toBeNull();

    // Advancing the page re-fetches with page=2.
    fireEvent.click(next);
    await waitFor(() => {
      const urls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) =>
          u.includes("/api/admin/member-lifecycle-action-requests"),
        );
      expect(urls.some((u) => u.includes("page=2"))).toBe(true);
    });
  });

  it("shows filter-aware empty copy for the admin-initiated section", async () => {
    // Default status filter is PENDING; no lifecycle rows returned.
    vi.stubGlobal("fetch", buildFetchMock([]));

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(
        screen.getByText(/No pending admin-initiated deletion requests\./),
      ).not.toBeNull(),
    );
  });
});

describe("self-service deletion partial recovery (#2597)", () => {
  const deletionRequest = {
    id: "request-1",
    status: "PENDING",
    reason: "Please remove my account",
    adminNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    member: {
      id: "member-1",
      firstName: "Riley",
      lastName: "Chen",
      email: "riley@example.test",
      role: "MEMBER",
      active: true,
    },
  };

  it("retains exact cleanup facts, focuses recovery, and replaces untouched approval with an explicit retry", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const blockingAlert = vi.spyOn(window, "alert").mockImplementation(() => {});
    let deletionReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/member-lifecycle-action-requests")) {
        return {
          ok: true,
          json: async () => ({
            requests: [],
            total: 0,
            page: 1,
            pageSize: 25,
            totalPages: 0,
          }),
        } as Response;
      }
      if (url === "/api/admin/deletion-requests/request-1" && init?.method === "POST") {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
            error: "private database detail",
            cancelledBookings: 2,
            cancellationPending: true,
            retryBookingId: "booking/pending",
            memberDataAnonymised: false,
            approvalReceiptSent: false,
          }),
        } as Response;
      }
      if (url.startsWith("/api/admin/deletion-requests?")) {
        deletionReads += 1;
        if (deletionReads === 1) {
          return {
            ok: true,
            json: async () => ({
              requests: [deletionRequest],
              total: 1,
              page: 1,
              pageSize: 25,
              totalPages: 1,
            }),
          } as Response;
        }
        return { ok: false, json: async () => ({}) } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch);

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    const alert = document.getElementById("deletion-requests-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & Delete Account" }),
    );

    await waitFor(() =>
      expect(alert?.textContent).toMatch(/2 future bookings were cancelled/i),
    );
    expect(alert?.textContent).toMatch(/one remaining booking still needs cancellation/i);
    expect(alert?.textContent).toMatch(/data was not anonymised/i);
    expect(alert?.textContent).toMatch(/no approval receipt was sent/i);
    expect(alert?.textContent).toMatch(/could not be refreshed/i);
    expect(alert?.textContent).not.toContain("private database detail");
    expect(document.activeElement).toBe(alert);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(blockingAlert).not.toHaveBeenCalled();

    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const openBooking = screen.getByRole("link", { name: "Open pending booking" });
    expect(openBooking.getAttribute("href")).toBe(
      "/admin/bookings/booking%2Fpending?returnTo=%2Fadmin%2Fdeletion-requests",
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry remaining cleanup" }));
    expect(
      await screen.findByRole("heading", { name: "Approve Deletion Request" }),
    ).not.toBeNull();
  });
});
