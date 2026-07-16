// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function buildFetchMock(lifecycleRequests: LifecycleRow[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/admin/member-lifecycle-action-requests")) {
      return {
        ok: true,
        json: async () => ({
          requests: lifecycleRequests,
          total: lifecycleRequests.length,
          page: 1,
          pageSize: 25,
          totalPages: 1,
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
});
