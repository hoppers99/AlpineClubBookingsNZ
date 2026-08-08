// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>()),
  useAdminAreaEditAccess: () => true,
}));

import { toast } from "sonner";
import { ManualRefundTaskQueue } from "@/components/admin/manual-refund-task-queue";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

const TASK = {
  id: "task-1",
  bookingId: "booking-1",
  amountCents: 12000,
  reason: "Cancelled after a cash payment",
  createdAt: "2026-08-01T00:00:00Z",
  memberName: "Ada Lovelace",
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * #2668 — the cash hand-back queue may not claim the ledger stood still.
 *
 * "Record as paid back" writes the refund allocation and the REFUNDED booking
 * event: it is the moment the ledger says the money went back. This control
 * used to answer a rejected `fetch` with "Could not reach the server. Nothing
 * was changed." `fetch` also rejects once the POST has landed and only its
 * answer is lost, in which case the refund IS recorded — and an officer told
 * nothing changed closes the task again, or worse, hands the money over twice.
 */
describe("ManualRefundTaskQueue — an outcome the browser never read (#2668)", () => {
  it("says what it could not verify rather than that nothing changed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // The queue's own initial load, which must succeed for there to be a task
      // to close in the first place.
      if (!init || init.method !== "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ tasks: [TASK] }),
        } as unknown as Response;
      }
      expect(String(input)).toContain("/api/admin/payments/manual-refund-tasks/");
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ManualRefundTaskQueue />);

    fireEvent.click(await screen.findByRole("button", { name: "Mark paid back" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Record as paid back" }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = String(vi.mocked(toast.error).mock.calls.at(-1)?.[0]);
    expect(message).toBe(
      unverifiedWriteMessage(
        "this refund task was closed",
        "Reload the page and check the queue before trying again.",
      ),
    );
    expect(message).not.toContain("Nothing was changed");
  });
});
