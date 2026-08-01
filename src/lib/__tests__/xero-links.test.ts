import { describe, expect, it } from "vitest";
import {
  applyXeroOrgShortCode,
  buildXeroContactUrl,
  buildXeroCreditNoteUrl,
  buildXeroDashboardUrl,
  buildXeroInvoiceUrl,
  buildXeroObjectUrl,
  buildXeroReportsUrl,
} from "@/lib/xero-links";

// #2261: the "Go to Xero" button in the Xero Sync page header. Both forms must
// be live URLs — the short code only makes the link land in the RIGHT
// organisation, its absence must never produce a dead link.
describe("buildXeroDashboardUrl", () => {
  it("links to the session-scoped Xero dashboard without a short code", () => {
    expect(buildXeroDashboardUrl()).toBe("https://go.xero.com/Dashboard/");
  });

  it("treats a null/empty short code as absent (fallback link)", () => {
    expect(buildXeroDashboardUrl({ shortCode: null })).toBe(
      "https://go.xero.com/Dashboard/"
    );
    expect(buildXeroDashboardUrl({ shortCode: "" })).toBe(
      "https://go.xero.com/Dashboard/"
    );
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroDashboardUrl({ shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FDashboard%2F"
    );
  });
});

// #2283: every admin "open in Xero" link now flows through these object
// builders (enforced by xero-links-guard.test.ts), so their two contractual
// properties get pinned here. (1) A null/absent short code DEGRADES the link
// to the session-scoped classic path — never a dead new-app path, never a
// hidden link. (2) With a short code the link routes through Xero's
// organisation-login redirect, so an admin signed in to several Xero
// organisations lands in THIS club's books rather than whichever organisation
// their session last used.
describe("buildXeroContactUrl", () => {
  it("links to the session-scoped contact page without a short code", () => {
    expect(buildXeroContactUrl("contact-1")).toBe(
      "https://go.xero.com/Contacts/View/contact-1"
    );
    expect(buildXeroContactUrl("contact-1", { shortCode: null })).toBe(
      "https://go.xero.com/Contacts/View/contact-1"
    );
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroContactUrl("contact-1", { shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FContacts%2FView%2Fcontact-1"
    );
  });

  it("URL-encodes the contact id", () => {
    expect(buildXeroContactUrl("a/b c")).toBe(
      "https://go.xero.com/Contacts/View/a%2Fb%20c"
    );
  });
});

describe("buildXeroInvoiceUrl", () => {
  it("links to the session-scoped invoice page without a short code", () => {
    expect(buildXeroInvoiceUrl("inv-1")).toBe(
      "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1"
    );
    expect(buildXeroInvoiceUrl("inv-1", { shortCode: null })).toBe(
      "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1"
    );
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroInvoiceUrl("inv-1", { shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FAccountsReceivable%2FView.aspx%3FInvoiceID%3Dinv-1"
    );
  });
});

describe("buildXeroCreditNoteUrl", () => {
  it("links to the session-scoped credit note page without a short code", () => {
    expect(buildXeroCreditNoteUrl("cn-1")).toBe(
      "https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=cn-1"
    );
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroCreditNoteUrl("cn-1", { shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FAccountsReceivable%2FViewCreditNote.aspx%3FcreditNoteID%3Dcn-1"
    );
  });
});

describe("buildXeroReportsUrl", () => {
  it("links to the session-scoped Xero report centre without a short code", () => {
    expect(buildXeroReportsUrl()).toBe("https://go.xero.com/Reports/");
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroReportsUrl({ shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FReports%2F"
    );
  });
});

// #2314: `XeroObjectLink.xeroObjectUrl` and `XeroSyncOperation.xeroObjectUrl`
// are stored organisation-AGNOSTIC by owner decision — a short code baked into
// a row is wrong the moment the club reconnects to a different Xero
// organisation — so the short code is applied to those stored URLs at render
// time. This is the function that does it, and these are its contractual
// properties.
describe("applyXeroOrgShortCode", () => {
  it("scopes a stored generic URL to the club's organisation", () => {
    expect(
      applyXeroOrgShortCode("https://go.xero.com/Contacts/View/contact-1", {
        shortCode: "!aBc12",
      }),
    ).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FContacts%2FView%2Fcontact-1",
    );
  });

  // The whole point of applying at render time rather than at write time: a
  // producer can mix rows written before this existed with URLs it builds now
  // and get one consistent answer, because both paths land on the same string.
  it("matches what the builder would have produced with the short code", () => {
    const options = { shortCode: "!aBc12" };
    for (const [generic, direct] of [
      [buildXeroContactUrl("contact-1"), buildXeroContactUrl("contact-1", options)],
      [buildXeroInvoiceUrl("inv-1"), buildXeroInvoiceUrl("inv-1", options)],
      [
        buildXeroCreditNoteUrl("cn-1"),
        buildXeroCreditNoteUrl("cn-1", options),
      ],
      // Ids that need escaping round-trip identically too.
      [buildXeroContactUrl("a/b c"), buildXeroContactUrl("a/b c", options)],
    ] as const) {
      expect(applyXeroOrgShortCode(generic, options)).toBe(direct);
    }
  });

  it("re-points a URL already scoped to a DIFFERENT organisation", () => {
    // Self-healing: a row written under a previous connection must not keep
    // aiming at books the club no longer owns.
    const stale = buildXeroInvoiceUrl("inv-1", { shortCode: "!old99" });

    expect(applyXeroOrgShortCode(stale, { shortCode: "!aBc12" })).toBe(
      buildXeroInvoiceUrl("inv-1", { shortCode: "!aBc12" }),
    );
  });

  it("leaves the URL alone when there is no short code", () => {
    const generic = "https://go.xero.com/Contacts/View/contact-1";
    expect(applyXeroOrgShortCode(generic)).toBe(generic);
    expect(applyXeroOrgShortCode(generic, { shortCode: null })).toBe(generic);
    expect(applyXeroOrgShortCode(generic, { shortCode: "" })).toBe(generic);
  });

  it("passes null and undefined through as null", () => {
    expect(applyXeroOrgShortCode(null, { shortCode: "!aBc12" })).toBeNull();
    expect(applyXeroOrgShortCode(undefined, { shortCode: "!aBc12" })).toBeNull();
  });

  it("never rewrites a URL that is not a Xero web-app link", () => {
    for (const foreign of [
      "https://bookings.example.org/admin/payments",
      "https://go.xero.com.evil.example/Contacts/View/contact-1",
      "https://in.xero.com/abc123", // the member-facing online invoice link
      "not a url at all",
    ]) {
      expect(applyXeroOrgShortCode(foreign, { shortCode: "!aBc12" })).toBe(
        foreign,
      );
    }
  });

  it("leaves a malformed organisation-login URL untouched", () => {
    const malformed =
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12";
    expect(applyXeroOrgShortCode(malformed, { shortCode: "!new77" })).toBe(
      malformed,
    );
  });

  it("scopes every object type buildXeroObjectUrl knows", () => {
    for (const [type, id] of [
      ["CONTACT", "contact-1"],
      ["INVOICE", "inv-1"],
      ["SUBSCRIPTION", "inv-2"],
      ["CREDIT_NOTE", "cn-1"],
      ["CREDITNOTE", "cn-2"],
    ] as const) {
      const generic = buildXeroObjectUrl(type, id);
      expect(generic).not.toBeNull();
      expect(applyXeroOrgShortCode(generic, { shortCode: "!aBc12" })).toBe(
        buildXeroObjectUrl(type, id, { shortCode: "!aBc12" }),
      );
      expect(
        applyXeroOrgShortCode(generic, { shortCode: "!aBc12" }),
      ).toContain("shortcode=!aBc12");
    }
  });
});
