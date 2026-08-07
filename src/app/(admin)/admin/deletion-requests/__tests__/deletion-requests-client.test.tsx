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

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  function buildPartialRecoveryFetch(responseBody: Record<string, unknown>) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      if (
        url === "/api/admin/deletion-requests/request-1" &&
        init?.method === "POST"
      ) {
        return {
          ok: false,
          status: 409,
          json: async () => responseBody,
        } as Response;
      }
      if (url.startsWith("/api/admin/deletion-requests?")) {
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
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  it.each([
    {
      action: "approve" as const,
      finalDecision: "APPROVED",
      memberAnonymised: true,
      submitButton: "Approve & Delete Account",
      expectedDecision: /another administrator approved/i,
      expectedMember: /latest member record is anonymised/i,
    },
    {
      action: "reject" as const,
      finalDecision: "REJECTED",
      memberAnonymised: false,
      submitButton: "Reject and email member",
      expectedDecision: /another administrator rejected/i,
      expectedMember: /latest member record is not anonymised/i,
    },
  ])(
    "shows final $finalDecision facts without a cleanup retry",
    async ({
      action,
      finalDecision,
      memberAnonymised,
      submitButton,
      expectedDecision,
      expectedMember,
    }) => {
      vi.stubGlobal(
        "fetch",
        buildPartialRecoveryFetch({
          error: "private database detail",
          decisionFinal: true,
          finalDecision,
          cancelledBookings: 1,
          memberAnonymised,
          memberDataAnonymised: memberAnonymised,
          retryAllowed: false,
        }) as typeof fetch,
      );

      render(<DeletionRequestsClient sessionMemberId="admin-1" />);
      await screen.findByText("Riley Chen");
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "approve" ? "Approve" : "Reject",
        }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: submitButton }),
      );

      const alert = document.getElementById("deletion-requests-recovery");
      await waitFor(() =>
        expect(alert?.textContent).toMatch(expectedDecision),
      );
      expect(alert?.textContent).toMatch(expectedMember);
      expect(alert?.textContent).toMatch(/1 future booking cancellation completed/i);
      expect(alert?.textContent).toMatch(/decision is final/i);
      expect(alert?.textContent).not.toContain("private database detail");
      expect(
        screen.queryByRole("button", { name: "Retry remaining cleanup" }),
      ).toBeNull();
      expect(document.activeElement).toBe(alert);
    },
  );

  it("uses ordinary partial-cleanup facts to retain recovery and replace untouched approval with an explicit retry", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const blockingAlert = vi.spyOn(window, "alert").mockImplementation(() => {});
    let deletionReads = 0;
    let deletionWrites = 0;
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
        deletionWrites += 1;
        if (deletionWrites > 1) {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: "The remaining cleanup changed; reload it." }),
          } as Response;
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({
            error: "private database detail",
            cancelledBookings: 2,
            cancellationPending: true,
            retryBookingId: "booking/pending",
            remainingCleanupPending: true,
            memberAnonymised: false,
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
    const recoveryAlert = document.getElementById("deletion-requests-recovery");
    const actionAlert = document.getElementById("deletion-requests-error");
    expect(recoveryAlert?.getAttribute("role")).toBe("alert");
    expect(recoveryAlert?.textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & Delete Account" }),
    );

    await waitFor(() =>
      expect(recoveryAlert?.textContent).toMatch(/2 future bookings were cancelled/i),
    );
    expect(recoveryAlert?.textContent).toMatch(/one remaining booking still needs cancellation/i);
    expect(recoveryAlert?.textContent).toMatch(/data was not anonymised/i);
    expect(recoveryAlert?.textContent).toMatch(/no approval receipt was sent/i);
    expect(recoveryAlert?.textContent).toMatch(/could not be refreshed/i);
    expect(recoveryAlert?.textContent).not.toContain("private database detail");
    expect(document.activeElement).toBe(recoveryAlert);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(blockingAlert).not.toHaveBeenCalled();

    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const openBooking = screen.getByRole("link", { name: "Open pending booking" });
    expect(openBooking.getAttribute("href")).toBe(
      "/bookings/booking%2Fpending?returnTo=%2Fadmin%2Fdeletion-requests",
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry remaining cleanup" }));
    expect(
      await screen.findByRole("heading", { name: "Approve Deletion Request" }),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Approve & Delete Account" }),
    );
    await waitFor(() =>
      expect(actionAlert?.textContent).toContain("The remaining cleanup changed; reload it."),
    );
    expect(document.activeElement).toBe(actionAlert);
    expect(recoveryAlert?.textContent).toMatch(/2 future bookings were cancelled/i);
  });

  it("shows a committed cancellation with unconfirmed post-processing without calling it pending", async () => {
    vi.stubGlobal(
      "fetch",
      buildPartialRecoveryFetch({
        cancelledBookings: 1,
        cancellationPending: false,
        retryBookingId: null,
        cancellationPostProcessingUnconfirmed: true,
        reviewBookingId: "booking/committed",
        remainingCleanupPending: true,
        memberAnonymised: false,
        memberDataAnonymised: false,
        approvalReceiptSent: false,
      }) as typeof fetch,
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & Delete Account" }),
    );

    const alert = document.getElementById("deletion-requests-recovery");
    await waitFor(() =>
      expect(alert?.textContent).toMatch(/cancellation committed/i),
    );
    expect(alert?.textContent).toMatch(/post-cancellation processing could not be confirmed/i);
    expect(alert?.textContent).not.toMatch(/still needs cancellation/i);
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("link", { name: "Open booking for review" })
        .getAttribute("href"),
    ).toBe(
      "/bookings/booking%2Fcommitted?returnTo=%2Fadmin%2Fdeletion-requests",
    );
  });

  it("retains cancellation facts and the last-admin remedy while suppressing a fresh approval", async () => {
    vi.stubGlobal(
      "fetch",
      buildPartialRecoveryFetch({
        cancelledBookings: 2,
        cancellationPending: false,
        retryBookingId: null,
        remainingCleanupPending: true,
        memberAnonymised: false,
        memberDataAnonymised: false,
        approvalReceiptSent: false,
        blocker: {
          code: "LAST_FULL_ADMIN_GUARD",
          message: "This is the last Full Admin account.",
          remedy:
            "Give another active account Full Admin access, then retry only the remaining deletion cleanup.",
        },
      }) as typeof fetch,
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & Delete Account" }),
    );

    const alert = document.getElementById("deletion-requests-recovery");
    await waitFor(() =>
      expect(alert?.textContent).toMatch(/2 future bookings were cancelled/i),
    );
    expect(alert?.textContent).toMatch(/last Full Admin/i);
    expect(alert?.textContent).toMatch(/another active account Full Admin access/i);
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Retry remaining cleanup" }),
    ).not.toBeNull();
  });
});

describe("deletion review outcome that never came back legibly (#2597)", () => {
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

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  /**
   * `post` decides what the review POST does: reject the fetch outright
   * (transport failure) or answer with a body that cannot be parsed.
   */
  function buildFetch(post: () => Promise<Response>, listRows = [deletionRequest]) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      if (
        url === "/api/admin/deletion-requests/request-1" &&
        init?.method === "POST"
      ) {
        return post();
      }
      if (url.startsWith("/api/admin/deletion-requests?")) {
        return {
          ok: true,
          json: async () => ({
            requests: listRows,
            total: listRows.length,
            page: 1,
            pageSize: 25,
            totalPages: 1,
          }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  const unreadableBody = (ok: boolean, status: number) =>
    ({
      ok,
      status,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    }) as unknown as Response;

  it.each([
    {
      name: "the connection drops",
      post: () => Promise.reject(new TypeError("Failed to fetch")),
      expectedCause: /server could not be reached/i,
    },
    {
      name: "an error response body cannot be parsed",
      post: () => Promise.resolve(unreadableBody(false, 502)),
      expectedCause: /response could not be read/i,
    },
    {
      name: "a success response body cannot be parsed",
      post: () => Promise.resolve(unreadableBody(true, 200)),
      expectedCause: /accepted it but its confirmation could not be read/i,
    },
  ])(
    "suppresses the destructive controls and refuses a retry when $name",
    async ({ post, expectedCause }) => {
      const fetchMock = buildFetch(post);
      vi.stubGlobal("fetch", fetchMock);

      render(<DeletionRequestsClient sessionMemberId="admin-1" />);
      await screen.findByText("Riley Chen");
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Approve & Delete Account" }),
      );

      const alert = document.getElementById("deletion-requests-recovery");
      await waitFor(() => expect(alert?.textContent).toMatch(expectedCause));

      // The admin is told the outcome is unknown, not that nothing happened.
      expect(alert?.textContent).toMatch(/may already have been recorded/i);
      expect(alert?.textContent).toMatch(/may already have cancelled future bookings/i);
      expect(alert?.textContent).toMatch(/do not retry/i);

      // No retry affordance, and the row's own Approve/Reject are inert.
      expect(
        screen.queryByRole("button", { name: "Retry remaining cleanup" }),
      ).toBeNull();
      expect(
        (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);

      // The authoritative queue was re-read rather than trusted from memory.
      const listReads = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/admin/deletion-requests?"));
      expect(listReads.length).toBeGreaterThan(1);
    },
  );

  it("keeps the warning active and says so when the queue re-read also fails", async () => {
    let seenList = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        if (
          url === "/api/admin/deletion-requests/request-1" &&
          init?.method === "POST"
        ) {
          throw new TypeError("Failed to fetch");
        }
        if (url.startsWith("/api/admin/deletion-requests?")) {
          // First (mount) read succeeds so the row renders; the recovery
          // re-read then fails.
          if (seenList) return { ok: false, status: 503 } as Response;
          seenList = true;
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
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & Delete Account" }),
    );

    const alert = document.getElementById("deletion-requests-recovery");
    await waitFor(() =>
      expect(alert?.textContent).toMatch(/could not be refreshed either/i),
    );
    expect(alert?.textContent).toMatch(/stays active until you reload/i);
  });

  it("offers only a resume on an APPROVAL_IN_PROGRESS row, never a reject", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetch(
        () => {
          throw new Error("no review should be submitted in this test");
        },
        [{ ...deletionRequest, status: "APPROVAL_IN_PROGRESS" }],
      ),
    );

    render(<DeletionRequestsClient sessionMemberId="admin-1" />);
    await screen.findByText("Riley Chen");

    // Rejection can no longer win this request server-side, so the button that
    // could only fail is not offered at all.
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Resume approval" }),
    ).not.toBeNull();

    // And it is not mislabelled as a finished rejection.
    expect(screen.getByText("Approval in progress")).not.toBeNull();
    expect(screen.queryByText("Rejected")).toBeNull();
    expect(
      screen.getByText(/can only be completed, not rejected/i),
    ).not.toBeNull();
  });
});
