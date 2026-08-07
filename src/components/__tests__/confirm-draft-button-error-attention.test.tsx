// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmDraftButton } from "@/components/confirm-draft-button";
import { HOSTING_COVERAGE_RETRY_MESSAGE } from "@/lib/adult-member-hosting-queue-participants";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const fetchMock = vi.fn();
const scrollIntoView = vi.fn();

describe("ConfirmDraftButton error attention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  it("keeps a permanent alert and focuses the fixed participant retry", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        error: HOSTING_COVERAGE_RETRY_MESSAGE,
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
      }),
    });

    render(<ConfirmDraftButton bookingId="booking-1" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("");
    const confirm = screen.getByRole("button", { name: "Confirm Booking" });
    fireEvent.click(confirm);

    await screen.findByText(HOSTING_COVERAGE_RETRY_MESSAGE);
    expect(document.activeElement).toBe(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(confirm).toBeEnabled();
  });

  it("restores the action after an unknown network outcome and supports a safe retry", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network detail must stay private"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    render(<ConfirmDraftButton bookingId="booking-1" />);

    const confirm = screen.getByRole("button", { name: "Confirm Booking" });
    fireEvent.click(confirm);
    await screen.findByText(/could not verify whether this draft was confirmed/i);
    expect(confirm).toBeEnabled();
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(screen.queryByText(/network detail/i)).not.toBeInTheDocument();

    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(confirm).toBeEnabled();
  });

  it("handles an unreadable error response without stranding the control", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error("private parse detail");
      },
    });

    render(<ConfirmDraftButton bookingId="booking-1" />);

    const confirm = screen.getByRole("button", { name: "Confirm Booking" });
    fireEvent.click(confirm);

    await screen.findByText(/could not verify whether this draft was confirmed/i);
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(scrollIntoView).toHaveBeenCalled();
    expect(confirm).toBeEnabled();
    expect(screen.queryByText(/private parse detail/i)).not.toBeInTheDocument();
  });
});
