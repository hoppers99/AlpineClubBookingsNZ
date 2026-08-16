import { describe, expect, it } from "vitest";
import {
  adminEmailDeliveryFailedTemplate,
  adminEmailWithheldTemplate,
  websiteContactTemplate,
} from "@/lib/email-templates/admin-ops";

const HTML_SPECIALS = `<probe&"'value>`;
const ESCAPED_HTML_SPECIALS = "&lt;probe&amp;&quot;&#39;value&gt;";

describe("admin operations email rendering", () => {
  it.each([
    [
      "website contact",
      websiteContactTemplate({
        name: HTML_SPECIALS,
        email: "contact@example.org",
        message: HTML_SPECIALS,
      }),
    ],
    [
      "permanent delivery failure",
      adminEmailDeliveryFailedTemplate({
        recipient: HTML_SPECIALS,
        templateName: HTML_SPECIALS,
        attemptCount: 3,
      }),
    ],
    [
      "fail-closed withhold",
      adminEmailWithheldTemplate({
        templateName: HTML_SPECIALS,
        bookingId: HTML_SPECIALS,
      }),
    ],
  ])("wraps the %s body in the standard club layout", (_name, html) => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Online Booking System");
  });

  it("escapes the recipient and template identifier in a delivery-failure alert", () => {
    const html = adminEmailDeliveryFailedTemplate({
      recipient: HTML_SPECIALS,
      templateName: HTML_SPECIALS,
      attemptCount: 3,
    });

    expect(html).not.toContain(HTML_SPECIALS);
    expect(html.match(new RegExp(ESCAPED_HTML_SPECIALS, "g"))).toHaveLength(2);
  });

  it("escapes the template and booking identifiers in a fail-closed withhold alert", () => {
    const html = adminEmailWithheldTemplate({
      templateName: HTML_SPECIALS,
      bookingId: HTML_SPECIALS,
    });

    expect(html).not.toContain(HTML_SPECIALS);
    expect(html.match(new RegExp(ESCAPED_HTML_SPECIALS, "g"))).toHaveLength(2);
  });
});
