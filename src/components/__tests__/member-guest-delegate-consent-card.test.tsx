// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberGuestDelegateConsentCard } from "@/components/member-guest-delegate-consent-card";

// #2307 — the delegate's answer panel. The mockup's deliberate asymmetry is
// the thing under test: a delegate sees names, dates and the question — never
// money, and never a route into the booking page.

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
    <MemberGuestDelegateConsentCard
      bookingId={BOOKING_ID}
      guestId={GUEST_ID}
      guestFirstName="Tama"
      guestHeadingName="Tama Kaur (age 9)"
      bookerName="Dave Ngata"
      bookerFirstName="Dave"
      lodgeName="Silverpeak Lodge"
      stayLabel="Sat 8 Aug – Mon 10 Aug 2026 (2 nights)"
      nightsLabel="Sat 8 Aug, Sun 9 Aug"
      answerByLabel="Fri 7 Aug 2026"
      party={["Dave Ngata", "Marama Ngata", "Tama Kaur"]}
      refusalWarning={null}
      {...overrides}
    />,
  );
}

describe("MemberGuestDelegateConsentCard", () => {
  it("addresses the delegate, names the child, and asks in the third person", () => {
    renderCard();

    expect(screen.getByText("Waiting for an answer")).toBeInTheDocument();
    expect(
      screen.getByText("Dave Ngata has added Tama Kaur (age 9) to a booking"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not have a login of their own/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your name is recorded against it/),
    ).toBeInTheDocument();
    expect(screen.getByText("Tama's nights")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes, add Tama" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No thanks" })).toBeInTheDocument();
  });

  it("shows no money and no link into the booking page", () => {
    const { container } = renderCard();
    expect(container.textContent).not.toMatch(/\$|price|total/i);
    for (const link of container.querySelectorAll("a")) {
      expect(link.getAttribute("href")).not.toContain("/bookings/");
    }
  });

  it("withholds No thanks behind a predictable refusal", () => {
    renderCard({
      refusalWarning:
        "This booking was priced by hand, so guests cannot be taken off it here. Only the club can take Tama off — it will re-quote the request. Reply to the club and they will sort it.",
    });
    expect(screen.getByText(/Only the club can take Tama off/)).toBeInTheDocument();
    expect(screen.getByText("You can still say yes.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "No thanks" })).toBeNull();
  });

  it("records a yes for the child and says whose name it went down under", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ outcome: "APPROVED" }));

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Yes, add Tama" }));

    await waitFor(() =>
      expect(screen.getByText("Tama is on this booking")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/bookings/${BOOKING_ID}/guests/${GUEST_ID}/consent`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "APPROVE" }),
      }),
    );
    expect(screen.getByText(/recorded against your name/)).toBeInTheDocument();
  });

  it("records a no and confirms the release", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ outcome: "DECLINED" }),
    );

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "No thanks" }));

    await waitFor(() =>
      expect(screen.getByText("You've said no for Tama")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/The bed that was held for Tama has been released/),
    ).toBeInTheDocument();
  });

  it("repeats a server refusal verbatim and keeps both buttons", async () => {
    const serverSentence =
      "Cannot remove the last guest from a booking. Cancel the booking instead.";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: serverSentence }, 400),
    );

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "No thanks" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(serverSentence);
    expect(screen.getByRole("button", { name: "Yes, add Tama" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "No thanks" })).toBeEnabled();
  });
});
