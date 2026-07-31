import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBookingDetailLinkToBuiltInHtml,
  finalizeBookingEmailHtml,
} from "@/lib/booking-email-html";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.nz");
});

describe("built-in booking email HTML links", () => {
  it("rewrites a legacy booking CTA to the canonical encoded detail URL", () => {
    const html =
      '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="https://bookings.example.nz/bookings/raw/id">Confirm Booking</a></td></tr></table>';

    expect(
      applyBookingDetailLinkToBuiltInHtml(
        html,
        "https://bookings.example.nz/bookings/raw%2Fid",
      ),
    ).toContain('href="https://bookings.example.nz/bookings/raw%2Fid"');
  });

  it("removes authenticated booking buttons for a public contact but preserves bearer actions", () => {
    const html =
      '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="https://bookings.example.nz/bookings/bk_private">View booking</a></td></tr></table>' +
      '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="https://bookings.example.nz/pay/bearer_secret">Pay now</a></td></tr></table>';

    const rendered = applyBookingDetailLinkToBuiltInHtml(html, null);
    expect(rendered).not.toContain("/bookings/bk_private");
    expect(rendered).not.toContain("View booking");
    expect(rendered).toContain("/pay/bearer_secret");
    expect(rendered).toContain("Pay now");
  });

  it("adds one canonical CTA when the built-in has no booking link", () => {
    const rendered = applyBookingDetailLinkToBuiltInHtml(
      "<p>Your booking was changed.</p><!-- Footer -->",
      "https://bookings.example.nz/bookings/bk_1",
    );
    expect(rendered.match(/View Booking/g)).toHaveLength(1);
    expect(rendered).toContain('href="https://bookings.example.nz/bookings/bk_1"');
  });

  it("leaves a stored body override byte-for-byte unchanged", () => {
    const storedOverride =
      '<p>Club-authored body</p><a href="https://bookings.example.nz/custom/help">Help</a>';
    expect(
      finalizeBookingEmailHtml({
        html: storedOverride,
        bookingUrl: "https://bookings.example.nz/bookings/bk_1",
        bookingScoped: true,
        bodyOverrideApplied: true,
      }),
    ).toBe(storedOverride);
  });
});
