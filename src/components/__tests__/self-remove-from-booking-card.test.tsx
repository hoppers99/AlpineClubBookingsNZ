// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelfRemoveFromBookingCard } from "@/components/self-remove-from-booking-card";

// #2250 — the member's own way off somebody else's booking, surfaced on the
// booking they are actually looking at. Eligibility arrives already decided by
// the server; the card must never invent its own rule, must HIDE (not disable)
// the action when ineligible, must say why, and must not strand a keyboard user
// when the outcome replaces what they were looking at.

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

function removeButton() {
  return screen.getByRole("button", { name: "Remove me from this booking" });
}

describe("SelfRemoveFromBookingCard", () => {
  it("explains whose booking it is and offers the removal when the server says it is allowed", () => {
    renderCard();

    expect(
      screen.getByText(/Bob made this booking and added you to it/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/you can take your own place off it/),
    ).toBeInTheDocument();
    expect(removeButton()).toBeInTheDocument();
  });

  it("hides the action entirely and states the reason when the server says no", () => {
    renderCard({
      canSelfRemove: false,
      blockedReason:
        "This booking is no longer in a state you can take yourself off. Ask the person who made the booking, or the club, if you need to come off it.",
    });

    expect(
      screen.queryByRole("button", { name: "Remove me from this booking" }),
    ).toBeNull();
    // The reason is in the reading order, not stranded on a disabled button
    // whose title never fires (disabled:pointer-events-none).
    expect(
      screen.getByText(/no longer in a state you can take yourself off/),
    ).toBeInTheDocument();
  });

  it("does not promise an action it has just refused", () => {
    // The intro used to offer "…but you can take your own place off it" above a
    // blocker saying the opposite, to the one member this card exists for.
    renderCard({
      canSelfRemove: false,
      blockedReason: "This booking is no longer in a state you can take yourself off.",
    });

    expect(
      screen.queryByText(/you can take your own place off it/),
    ).toBeNull();
    expect(
      screen.getByText(/It is not your booking to change\./),
    ).toBeInTheDocument();
  });

  it("confirms before removing, and does not call the API until confirmed", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET" });
      return jsonResponse({ booking: { id: BOOKING_ID } });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard();

    fireEvent.click(removeButton());
    expect(
      await screen.findByText("Take yourself off this booking?"),
    ).toBeInTheDocument();
    // The consequences are stated in the dialog the member must read to act.
    expect(
      screen.getByText(/Bob is emailed about the change and their total is updated/),
    ).toBeInTheDocument();
    expect(fetchCalls).toHaveLength(0);

    // Backing out leaves the booking untouched.
    fireEvent.click(screen.getByRole("button", { name: "Keep my place" }));
    await waitFor(() => {
      expect(screen.queryByText("Take yourself off this booking?")).toBeNull();
    });
    expect(fetchCalls).toHaveLength(0);

    fireEvent.click(removeButton());
    fireEvent.click(
      await screen.findByRole("button", { name: "Yes, take me off" }),
    );

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

  it("promises the owner email as an attempt, not as a delivered fact", async () => {
    // The notification is fire-and-forget and is legitimately skipped for a
    // placeholder .invalid address or a suppressed recipient, so "has been told"
    // was a claim the code cannot make.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ booking: { id: BOOKING_ID } })),
    );

    renderCard();
    fireEvent.click(removeButton());
    fireEvent.click(
      await screen.findByRole("button", { name: "Yes, take me off" }),
    );

    const outcome = await screen.findByRole("status");
    expect(outcome).toHaveTextContent(/Bob will be emailed about the change/);
    expect(outcome).not.toHaveTextContent(/has been told/);
    // The rest of the page is server-rendered and deliberately not refreshed
    // (a refresh would fail the route guard), so the card says it is stale.
    expect(outcome).toHaveTextContent(/still show the party and total as they were/);
  });

  it("moves focus to the outcome so a keyboard user is not dropped to the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ booking: { id: BOOKING_ID } })),
    );

    renderCard();
    fireEvent.click(removeButton());
    fireEvent.click(
      await screen.findByRole("button", { name: "Yes, take me off" }),
    );

    const outcome = await screen.findByRole("status");
    await waitFor(() => {
      expect(outcome).toHaveFocus();
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  it("surfaces the server's own refusal verbatim, announces it, and lets the member retry", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse(
            {
              error:
                "This booking has a settled payment, so a refund or account credit must be chosen. Ask the booking owner or an admin to remove this guest.",
            },
            400,
          )
        : jsonResponse({ booking: { id: BOOKING_ID } });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard();

    fireEvent.click(removeButton());
    fireEvent.click(
      await screen.findByRole("button", { name: "Yes, take me off" }),
    );

    // role="alert" so the refusal is announced, and focused so a keyboard user
    // lands on it rather than on <body>.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/This booking has a settled payment/);
    await waitFor(() => {
      expect(alert).toHaveFocus();
    });
    expect(screen.queryByText("You are off this booking")).toBeNull();

    // The action stays available — no dead end.
    fireEvent.click(removeButton());
    fireEvent.click(
      await screen.findByRole("button", { name: "Yes, take me off" }),
    );
    await waitFor(() => {
      expect(screen.getByText("You are off this booking")).toBeInTheDocument();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
