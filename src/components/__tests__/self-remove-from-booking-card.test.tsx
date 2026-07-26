// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelfRemoveFromBookingCard } from "@/components/self-remove-from-booking-card";

// #2250 — the member's own way off somebody else's booking, surfaced on the
// booking they are actually looking at. Eligibility arrives already decided by
// the server; the card must never invent its own rule, must HIDE (not disable)
// the action when ineligible, and must say why.

const BOOKING_ID = "bk-2250";
const GUEST_ID = "guest-2250";

let fetchCalls: Array<{ url: string; method: string }>;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderCard(overrides: Record<string, unknown> = {}) {
  return render(
    <SelfRemoveFromBookingCard
      bookingId={BOOKING_ID}
      guestId={GUEST_ID}
      ownerFirstName="Bob"
      canSelfRemove
      blockedReason={null}
      {...overrides}
    />,
  );
}

describe("SelfRemoveFromBookingCard", () => {
  it("explains whose booking it is and offers the removal when the server says it is allowed", () => {
    renderCard();

    expect(
      screen.getByText(/Bob made this booking and added you to it/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove me from this booking" }),
    ).toBeInTheDocument();
  });

  it("hides the action entirely and states the reason when the server says no", () => {
    renderCard({
      canSelfRemove: false,
      blockedReason:
        "This stay starts today or has already started, so you can no longer take yourself off it here.",
    });

    expect(
      screen.queryByRole("button", { name: "Remove me from this booking" }),
    ).toBeNull();
    // The reason is in the reading order, not stranded on a disabled button
    // whose title never fires (disabled:pointer-events-none).
    expect(
      screen.getByText(/This stay starts today or has already started/),
    ).toBeInTheDocument();
  });

  it("confirms before removing, and does not call the API until confirmed", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET" });
      return jsonResponse({ booking: { id: BOOKING_ID } });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove me from this booking" }),
    );
    expect(
      screen.getByText("Take yourself off this booking?"),
    ).toBeInTheDocument();
    expect(fetchCalls).toHaveLength(0);

    // Backing out leaves the booking untouched.
    fireEvent.click(screen.getByRole("button", { name: "Keep my place" }));
    expect(fetchCalls).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove me from this booking" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes, take me off" }));

    await waitFor(() => {
      expect(screen.getByText("You are off this booking")).toBeInTheDocument();
    });
    expect(fetchCalls).toEqual([
      { url: `/api/bookings/${BOOKING_ID}/guests/${GUEST_ID}`, method: "DELETE" },
    ]);
    expect(
      screen.getByRole("link", { name: "Back to my bookings" }),
    ).toHaveAttribute("href", "/bookings");
  });

  it("surfaces the server's own refusal verbatim and lets the member retry", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error:
            "This booking has a settled payment, so a refund or account credit must be chosen. Ask the booking owner or an admin to remove this guest.",
        },
        400,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderCard();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove me from this booking" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes, take me off" }));

    await waitFor(() => {
      expect(
        screen.getByText(/This booking has a settled payment/),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("You are off this booking")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      screen.getByRole("button", { name: "Remove me from this booking" }),
    ).toBeInTheDocument();
  });
});
