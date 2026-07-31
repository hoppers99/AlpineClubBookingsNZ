// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberGuestConsentCard } from "@/components/member-guest-consent-card";

// #2307 — the member's own consent card on the booking page. The signed-off
// mockup pack is the spec: the facts table, the full party listing with
// "that's you", the lapse sentence, and the three honest-refusal behaviours —
// a predictable refusal warns BEFORE the click and withholds "No thanks"; an
// unpredictable refusal keeps both buttons and repeats the server's 400
// verbatim (the #2250 pattern).

const BOOKING_ID = "bk-2307";
const GUEST_ID = "bg-2307";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function renderCard(overrides: Record<string, unknown> = {}) {
  return render(
    <MemberGuestConsentCard
      bookingId={BOOKING_ID}
      guestId={GUEST_ID}
      bookerName="Dave Ngata"
      bookerFirstName="Dave"
      lodgeName="Silverpeak Lodge"
      stayLabel="Sat 8 Aug – Mon 10 Aug 2026 (2 nights)"
      nightsLabel="Sat 8 Aug, Sun 9 Aug"
      nightsCountLabel="two nights"
      answerByLabel="Fri 7 Aug 2026"
      lapseByLabel="Fri 7 Aug"
      party={[
        { name: "Dave Ngata", isViewer: false },
        { name: "Marama Ngata", isViewer: false },
        { name: "Priya Kaur", isViewer: true },
      ]}
      quotePriced={false}
      refusalWarning={null}
      {...overrides}
    />,
  );
}

describe("MemberGuestConsentCard", () => {
  it("renders the ask with the facts, the party listing, and the lapse sentence", () => {
    renderCard();

    expect(screen.getByText("Waiting for your answer")).toBeInTheDocument();
    expect(
      screen.getByText("Dave Ngata has added you to this booking"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/You have been put down for two nights at/),
    ).toBeInTheDocument();
    expect(screen.getByText("Booked by")).toBeInTheDocument();
    expect(
      screen.getByText("Sat 8 Aug – Mon 10 Aug 2026 (2 nights)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Your nights")).toBeInTheDocument();
    expect(screen.getByText("Fri 7 Aug 2026")).toBeInTheDocument();
    expect(screen.getByText("Everyone on the booking:")).toBeInTheDocument();
    expect(screen.getByText(/Priya Kaur — that's you/)).toBeInTheDocument();
    expect(
      screen.getByText(/the request lapses on its own/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/You do not have to do anything to decline/),
    ).toBeInTheDocument();
    // The release is stated as the usual case, never as a promise: a lapse runs
    // the same removal path a decline does, so the same blockers can leave the
    // member on the booking (B5).
    expect(
      screen.getByText(/In most cases the held bed is released at the same time/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes, add me" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No thanks" })).toBeInTheDocument();
  });

  it("names the booking request in the heading for a quote-priced booking", () => {
    renderCard({ quotePriced: true });
    expect(
      screen.getByText("Dave Ngata has added you to a booking request"),
    ).toBeInTheDocument();
  });

  it("shows no prices anywhere", () => {
    const { container } = renderCard();
    expect(container.textContent).not.toMatch(/\$|price|total/i);
  });

  it("warns before the click and withholds No thanks for a predictable refusal", () => {
    renderCard({
      refusalWarning:
        "You are the only guest on this booking, so taking you off would leave it empty. Only Dave or the club can cancel it. Ask Dave to cancel the booking if you do not want to go.",
    });

    expect(
      screen.getByText(/Ask Dave to cancel the booking if you do not want to go/),
    ).toBeInTheDocument();
    expect(screen.getByText("You can still say yes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes, add me" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "No thanks" })).toBeNull();
  });

  it("posts APPROVE and confirms without unmounting the confirmation", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ outcome: "APPROVED" }));

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Yes, add me" }));

    await waitFor(() =>
      expect(screen.getByText("You're on this booking")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/bookings/${BOOKING_ID}/guests/${GUEST_ID}/consent`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "APPROVE" }),
      }),
    );
    expect(screen.getByText(/your place is confirmed/)).toBeInTheDocument();
  });

  it("posts DECLINE and offers the way out once the place is released", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ outcome: "DECLINED" }),
    );

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "No thanks" }));

    await waitFor(() =>
      expect(screen.getByText("You've said no")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/The bed that was held for you has been released/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to my bookings" }),
    ).toBeInTheDocument();
  });

  it("repeats an unpredictable server refusal word for word and keeps both buttons", async () => {
    const serverSentence =
      "This booking has already been paid, and taking a guest off it needs the owner or an admin to choose between a refund and account credit.";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          outcome: "BLOCKED",
          consentStatus: "DECLINED",
          reason: "OTHER",
          error: serverSentence,
        },
        400,
      ),
    );

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "No thanks" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(serverSentence);
    // Both actions survive the refusal — the member can still say yes, or
    // retry once the state changes.
    expect(screen.getByRole("button", { name: "Yes, add me" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "No thanks" })).toBeEnabled();
  });

  it("fails soft when the network does", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Yes, add me" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "We could not record your answer. Please try again.",
    );
  });
});
