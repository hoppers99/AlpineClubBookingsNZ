import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBookingDetailLinkToBuiltInHtml,
  finalizeBookingEmailHtml,
  hasBookingDetailHref,
} from "@/lib/booking-email-html";
import { bookingPolicyExceptionApprovedTemplate } from "@/lib/email-templates";
import { BOOKING_URL_TEMPLATE_NAMES } from "@/lib/booking-email-template-contract";
import { ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES } from "@/lib/booking-email-suppression";

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
      '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="https://bookings.example.nz/pay/bearer_secret">Pay now</a></td></tr></table>' +
      '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="https://bookings.example.nz/bookings/consent/consent_secret">Answer for this member</a></td></tr></table>';

    const rendered = applyBookingDetailLinkToBuiltInHtml(html, null);
    expect(rendered).not.toContain("/bookings/bk_private");
    expect(rendered).not.toContain("View booking");
    expect(rendered).toContain("/pay/bearer_secret");
    expect(rendered).toContain("Pay now");
    expect(rendered).toContain("/bookings/consent/consent_secret");
    expect(rendered).toContain("Answer for this member");
  });

  it("does not rewrite a bearer consent action for an authorized recipient", () => {
    const consentUrl =
      "https://bookings.example.nz/bookings/consent/consent_secret";
    const html = `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="${consentUrl}">Answer for this member</a></td></tr></table>`;

    const rendered = applyBookingDetailLinkToBuiltInHtml(
      html,
      "https://bookings.example.nz/bookings/bk_1",
    );
    expect(rendered).toContain(`href="${consentUrl}"`);
    expect(rendered).toContain('href="https://bookings.example.nz/bookings/bk_1"');
  });

  it("preserves a booking-page action fragment while canonicalizing the booking id", () => {
    const html =
      '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="https://bookings.example.nz/bookings/stale-id#consent">Answer this request</a></td></tr></table>';

    const rendered = applyBookingDetailLinkToBuiltInHtml(
      html,
      "https://bookings.example.nz/bookings/bk_1",
    );

    expect(rendered).toContain(
      'href="https://bookings.example.nz/bookings/bk_1#consent"',
    );
    expect(rendered).toContain("Answer this request");
  });

  it("detects authenticated detail hrefs but not bearer consent routes", () => {
    expect(
      hasBookingDetailHref(
        '<a href="https://bookings.example.nz/bookings/bk_1#consent">Answer</a>',
      ),
    ).toBe(true);
    expect(
      hasBookingDetailHref(
        '<a href="https://bookings.example.nz/bookings/consent/guest_1">Answer</a>',
      ),
    ).toBe(false);
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

  it("sanitizes only the unauthorized delivery copy of a stored override", () => {
    const storedOverride =
      '<p>Club-authored body</p><a href="https://bookings.example.nz/bookings/bk_private">Open booking</a>' +
      '<a href="https://old-bookings.example.nz/bookings/bk_private">Old origin</a>' +
      '<a href="/bookings/bk_private">Relative booking</a>' +
      '<a href="https://bookings.example.nz/bookings/consent/consent_secret">Answer consent</a>' +
      '<a href="https://bookings.example.nz/custom/help">Help</a>';

    const delivered = finalizeBookingEmailHtml({
      html: storedOverride,
      bookingUrl: null,
      bookingScoped: true,
      bodyOverrideApplied: true,
    });

    expect(delivered).not.toContain("/bookings/bk_private");
    expect(delivered).not.toContain("old-bookings.example.nz");
    expect(delivered).toContain("/bookings/consent/consent_secret");
    expect(delivered).toContain("/custom/help");
    expect(storedOverride).toContain("/bookings/bk_private");
  });

  it("preserves singly encoded consent bearer routes byte-for-byte", () => {
    const storedOverride =
      '<a href="https://bookings.example.nz/bookings/%63onsent/current-token?mode=answer#respond">https://bookings.example.nz/bookings/%63onsent/current-token?mode=answer#respond</a>' +
      '<a href="https://old-bookings.example.nz/bookings/%43ONSENT/legacy-token?mode=answer#respond">https://old-bookings.example.nz/bookings/%43ONSENT/legacy-token?mode=answer#respond</a>' +
      '<a href="/bookings/%63ONSENT/relative-token?mode=answer#respond">/bookings/%63ONSENT/relative-token?mode=answer#respond</a>';

    expect(
      finalizeBookingEmailHtml({
        html: storedOverride,
        bookingUrl: null,
        bookingScoped: true,
        bodyOverrideApplied: true,
      }),
    ).toBe(storedOverride);
    expect(hasBookingDetailHref(storedOverride)).toBe(false);
  });

  it("decodes only the first booking route segment once and fails closed", () => {
    const storedOverride =
      "Encoded detail: /bookings/%62k_private?tab=guests#summary. " +
      "Double encoded: /bookings/%2563onsent/token?mode=answer#respond. " +
      "Malformed: /bookings/%6Gonsent/token?mode=answer#respond. " +
      "Literal bearer: /bookings/consent/token?mode=answer#respond. " +
      "Unrelated malformed: /help/%6G?next=/bookings/bk_private#faq.";

    expect(
      finalizeBookingEmailHtml({
        html: storedOverride,
        bookingUrl: null,
        bookingScoped: true,
        bodyOverrideApplied: true,
      }),
    ).toBe(
      "Encoded detail: . Double encoded: . Malformed: . " +
        "Literal bearer: /bookings/consent/token?mode=answer#respond. " +
        "Unrelated malformed: /help/%6G?next=/bookings/bk_private#faq.",
    );
    expect(
      hasBookingDetailHref(
        '<a href="https://bookings.example.nz/bookings/%2563onsent/token">Double encoded</a>',
      ),
    ).toBe(true);
    expect(
      hasBookingDetailHref(
        '<a href="https://bookings.example.nz/bookings/%6Gonsent/token">Malformed</a>',
      ),
    ).toBe(true);
  });

  it("sanitizes text nodes without rewriting quoted attributes or comments", () => {
    const storedOverride =
      "<div data-double=\"> /bookings/bk_attribute\" data-single='> https://old-bookings.example.nz/bookings/bk_attribute'>Visible detail: /bookings/bk_visible.</div>" +
      "<!-- > /bookings/bk_comment -->" +
      "Literal bearer: /bookings/consent/token. " +
      "Unrelated: /help?next=/bookings/bk_visible#faq.";

    expect(
      finalizeBookingEmailHtml({
        html: storedOverride,
        bookingUrl: null,
        bookingScoped: true,
        bodyOverrideApplied: true,
      }),
    ).toBe(
      "<div data-double=\"> /bookings/bk_attribute\" data-single='> https://old-bookings.example.nz/bookings/bk_attribute'>Visible detail: .</div>" +
        "<!-- > /bookings/bk_comment -->" +
        "Literal bearer: /bookings/consent/token. " +
        "Unrelated: /help?next=/bookings/bk_visible#faq.",
    );
  });
});

/**
 * #2562 review — where the approval notice's "View Booking" button actually goes.
 *
 * The template writes `{BASE_URL}/bookings`, which reads like a list link on the
 * page, and a review took it for one. It is not: `booking-policy-exception-approved`
 * is a registered, always-booking-scoped template in the booking-URL set, so
 * `sendEmail` resolves the recipient's own authorized detail URL and
 * `applyBookingDetailLinkToBuiltInHtml` rewrites the CTA to it before delivery —
 * or strips the CTA entirely for a recipient with no route authority. Pinned here
 * because the delivered link is a property of the send pipeline, not of the
 * template source, and reading the template alone gives the wrong answer.
 */
describe("the approved-exception notice links to the booking, not the list", () => {
  const html = () =>
    bookingPolicyExceptionApprovedTemplate({
      firstName: "Ada",
      checkIn: new Date("2026-07-01T00:00:00.000Z"),
      checkOut: new Date("2026-07-03T00:00:00.000Z"),
      guestCount: 2,
      paymentNote: "There is $120.00 to pay on this booking.",
      adminNotesLine: "",
    });

  it("is classified so the canonical booking link is resolved for it at all", () => {
    expect(
      ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has(
        "booking-policy-exception-approved",
      ),
    ).toBe(true);
    expect(
      BOOKING_URL_TEMPLATE_NAMES.has("booking-policy-exception-approved"),
    ).toBe(true);
  });

  it("delivers the recipient's own booking-detail URL in the CTA", () => {
    const delivered = finalizeBookingEmailHtml({
      html: html(),
      bookingUrl: "https://bookings.example.nz/bookings/bk_approved",
      bookingScoped: true,
      bodyOverrideApplied: false,
    });
    expect(delivered).toContain(
      'href="https://bookings.example.nz/bookings/bk_approved"',
    );
    // The bare list href never survives to the wire.
    expect(delivered).not.toContain('href="https://bookings.example.nz/bookings"');
  });

  it("drops the CTA rather than leaking a booking id to an unauthorized recipient", () => {
    const delivered = finalizeBookingEmailHtml({
      html: html(),
      bookingUrl: null,
      bookingScoped: true,
      bodyOverrideApplied: false,
    });
    expect(delivered).not.toContain("View Booking");
    // The message itself still tells them what was approved and what is owing.
    expect(delivered).toContain("120.00");
  });
});
