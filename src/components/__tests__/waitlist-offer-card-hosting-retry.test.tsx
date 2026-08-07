// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WaitlistOfferCard } from "@/components/waitlist-offer-card";

const RETRY_MESSAGE =
  "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.";

describe("WaitlistOfferCard participant retry attention (#2597)", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const originalLocation = window.location;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
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
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
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
    await waitFor(() => expect(document.activeElement).toBe(alert));
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
      }),
    );
    expect(
      screen.getByText(
        /a spot has become available for your waitlisted booking/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm Booking" }),
    ).toBeEnabled();
  });

  it("suppresses another confirm after a network failure until status is reloaded", async () => {
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
      await screen.findByText(/could not verify whether this offer was confirmed/i),
    ).toHaveTextContent(/Reload the booking and check its current status before trying again/i);
    expect(screen.queryByRole("button", { name: "Confirm Booking" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reload booking status" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("treats an unreadable successful response as status-unconfirmed", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("invalid json");
      },
    }) as unknown as typeof fetch;

    render(
      <WaitlistOfferCard
        bookingId="booking-1"
        expiresAt="2026-08-01T00:00:00.000Z"
        finalPriceCents={12500}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));

    expect(
      await screen.findByRole("button", { name: "Reload booking status" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Confirm Booking" })).not.toBeInTheDocument();
  });
});
