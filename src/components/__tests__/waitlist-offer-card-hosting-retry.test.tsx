// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WaitlistOfferCard } from "@/components/waitlist-offer-card";

const RETRY_MESSAGE =
  "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.";

describe("WaitlistOfferCard participant retry attention (#2597)", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
  });

  it("keeps the offer available and focuses the permanently mounted retry alert", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: RETRY_MESSAGE,
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
      }),
    }) as unknown as typeof fetch;

    render(
      <WaitlistOfferCard
        bookingId="booking-1"
        expiresAt="2026-08-01T00:00:00.000Z"
        finalPriceCents={12500}
      />,
    );

    const alert = document.getElementById("waitlist-confirm-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toBeEmptyDOMElement();
    expect(alert).toHaveClass("sr-only");

    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));

    await waitFor(() => expect(alert).toHaveTextContent(RETRY_MESSAGE));
    expect(document.activeElement).toBe(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(
      screen.getByText(
        /a spot has become available for your waitlisted booking/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm Booking" }),
    ).toBeEnabled();
  });

  it("recovers the confirm button after a network failure", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network unavailable")) as unknown as typeof fetch;

    render(
      <WaitlistOfferCard
        bookingId="booking-1"
        expiresAt="2026-08-01T00:00:00.000Z"
        finalPriceCents={12500}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));

    expect(
      await screen.findByText(/the service could not be reached/i),
    ).toHaveTextContent("Your offer is still here; try again.");
    expect(
      screen.getByRole("button", { name: "Confirm Booking" }),
    ).toBeEnabled();
  });
});
