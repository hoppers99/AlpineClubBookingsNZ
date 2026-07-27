// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BookingWithheldEmailsBanner } from "@/components/admin/booking-withheld-emails-banner";
import { withheldEmailDisplayName } from "@/lib/booking-email-suppression";

/*
  #2259 — the persistent warning must list what was ACTUALLY withheld, from the
  audit records, and must keep stating the admin's obligation after the switch
  is cleared. A banner that only fired while the switch was on would quietly
  drop the case that matters most: emails back on, but the cancellation the
  member never heard about is still never sent.
*/

const ROWS = [
  {
    id: "e1",
    label: withheldEmailDisplayName("booking-cancelled"),
    subject: "Your booking has been cancelled",
    createdAt: "2026-07-20T02:00:00.000Z",
  },
  {
    id: "e2",
    label: withheldEmailDisplayName("xero-booking-invoice-email"),
    subject: "Invoice INV-0042 from the club",
    createdAt: "2026-07-19T21:30:00.000Z",
  },
];

describe("BookingWithheldEmailsBanner (#2259)", () => {
  it("names each withheld message and timestamps it", () => {
    render(<BookingWithheldEmailsBanner noEmails withheld={ROWS} />);

    expect(
      screen.getByText("Emails are turned off for this booking"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Telling the member about these is your responsibility/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Withheld so far (2 messages):")).toBeInTheDocument();

    // Display names, not raw slugs — including the Xero-sent invoice, which is
    // inside the same guarantee.
    expect(screen.getByText("Booking Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Xero invoice email")).toBeInTheDocument();
    expect(
      screen.getByText(/Your booking has been cancelled/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Invoice INV-0042 from the club/)).toBeInTheDocument();

    // Each row is timestamped, in NZ locale form.
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.textContent).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    }
  });

  it("keeps warning after the switch is cleared, because nothing is re-sent", () => {
    render(<BookingWithheldEmailsBanner noEmails={false} withheld={ROWS} />);

    expect(
      screen.getByText("Some emails for this booking were never sent"),
    ).toBeInTheDocument();
    expect(screen.getByText(/are not re-sent/i)).toBeInTheDocument();
    expect(screen.getByText("Booking Cancelled")).toBeInTheDocument();
  });

  it("says so plainly when the switch is on but nothing has been withheld yet", () => {
    render(<BookingWithheldEmailsBanner noEmails withheld={[]} />);

    expect(
      screen.getByText("Emails are turned off for this booking"),
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing has been withheld yet.")).toBeInTheDocument();
  });

  it("renders nothing at all on an ordinary booking", () => {
    const { container } = render(
      <BookingWithheldEmailsBanner noEmails={false} withheld={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("withheldEmailDisplayName (#2259)", () => {
  it("uses the registry label for a real template", () => {
    expect(withheldEmailDisplayName("booking-confirmed")).toBe(
      "Booking Confirmed",
    );
  });

  it("names both Xero pseudo-templates, which are not registry entries", () => {
    expect(withheldEmailDisplayName("xero-booking-invoice-email")).toBe(
      "Xero invoice email",
    );
    expect(
      withheldEmailDisplayName("xero-group-settlement-invoice-email"),
    ).toBe("Xero group settlement invoice email");
  });

  it("falls back to the raw name rather than inventing one", () => {
    expect(withheldEmailDisplayName("not-a-registered-template")).toBe(
      "not-a-registered-template",
    );
  });
});
