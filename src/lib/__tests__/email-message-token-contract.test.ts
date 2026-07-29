import { describe, expect, it } from "vitest";
import { EMAIL_AUDIT_DEFAULTS } from "@/lib/email-message-audit-defaults";
import {
  APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
  EXTRA_TEMPLATE_TOKENS,
  EMAIL_TEMPLATE_DEFINITIONS,
  getEmailTemplateDefinition,
  sampleValue,
} from "@/lib/email-message-registry";
import {
  OPTIONAL_TEMPLATE_TOKENS,
  findBracketAnnotations,
  findDanglingDefaultLines,
  findStaleOptionalTokens,
  findUnapprovedDefaultTokens,
  findUnapprovedSuppliedTokens,
  type EmailTemplateDefaults,
} from "@/lib/email-message-token-contract";
import { validateEmailTemplateContent } from "@/lib/email-message-renderer";

// #2268 — the guard these replace was circular. The old check ran
// validateEmailTemplateContent over every default body, but the per-template
// `allowedTokens` it validated against is built by scraping tokens out of that
// same default body, so a token was allowed *because* an author had put it
// there. It could not fail on a default, which is how 33 templates shipped
// carrying "[only when ...]" authoring notes as literal member-facing text.
//
// Every guard below takes its registry as an ARGUMENT, and every one is
// exercised twice: once against the real shipped registry, and once against a
// deliberately broken fixture that proves it actually bites.

const DEFAULTS = EMAIL_AUDIT_DEFAULTS as unknown as Record<
  string,
  EmailTemplateDefaults
>;

describe("#2268 guard 1 — no authoring annotations in a shipped default", () => {
  it("finds none in the shipped defaults", () => {
    expect(findBracketAnnotations(DEFAULTS)).toEqual([]);
  });

  it("fails on a deliberately broken fixture", () => {
    const findings = findBracketAnnotations({
      "broken-body": {
        defaultSubject: "All good",
        defaultBody: "Door code: {{doorCode}} [only when a door code is set]",
      },
      "broken-subject": {
        defaultSubject: "Refund [only when approved]",
        defaultBody: "All good",
      },
    });

    expect(findings).toEqual([
      {
        key: "broken-body",
        field: "defaultBody",
        detail: "[only when a door code is set]",
      },
      {
        key: "broken-subject",
        field: "defaultSubject",
        detail: "[only when approved]",
      },
    ]);
  });
});

describe("#2268 guard 2 — shipped defaults only use approved tokens", () => {
  it("finds none in the shipped defaults", () => {
    expect(
      findUnapprovedDefaultTokens(DEFAULTS, APPROVED_EMAIL_TEMPLATE_TOKEN_SET),
    ).toEqual([]);
  });

  it("is not circular: it fails on a token the defaults themselves introduce", () => {
    // The old guard passed this exact input, because the token was allowed by
    // virtue of appearing in the body being checked.
    const findings = findUnapprovedDefaultTokens(
      {
        "booking-confirmed": {
          defaultSubject: "Booking Confirmed",
          defaultBody: "Hi {{firstName}}, your total is {{madeUpToken}}.",
        },
      },
      APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
    );

    expect(findings).toEqual([
      {
        key: "booking-confirmed",
        field: "defaultBody",
        detail: "madeUpToken",
      },
    ]);
  });
});

describe("#2268 guard 3 — every supplied override token is approved", () => {
  it("finds none in the shipped registry", () => {
    expect(
      findUnapprovedSuppliedTokens(
        EXTRA_TEMPLATE_TOKENS,
        APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
      ),
    ).toEqual([]);
  });

  it("fails on the {{promoAdjustment}} shape: supplied and allowed, but unusable", () => {
    // Correctly computed, passed to the renderer, allowed for the template —
    // and still rejected by the editor's own validator as an unknown token, so
    // no admin could ever put it in a body. That was the #2267 bug.
    const findings = findUnapprovedSuppliedTokens(
      { "booking-confirmed": ["subtotal", "neverApprovedToken"] },
      APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
    );

    expect(findings).toEqual([
      {
        key: "booking-confirmed",
        field: "defaultBody",
        detail: "neverApprovedToken",
      },
    ]);
  });
});

describe("#2268 guard 4 — no dangling line when an optional value is empty", () => {
  it("finds none in the shipped defaults", () => {
    expect(
      findDanglingDefaultLines(
        DEFAULTS,
        OPTIONAL_TEMPLATE_TOKENS,
        sampleValue,
      ),
    ).toEqual([]);
  });

  it("fails on the door-code shape a bare annotation strip would have left", () => {
    const findings = findDanglingDefaultLines(
      {
        "pre-arrival-reminder": {
          defaultSubject: "Pre-arrival Information",
          defaultBody: "Check-in: {{checkIn}}\nDoor code: {{doorCode}}\n\nSee you soon.",
        },
      },
      { "pre-arrival-reminder": ["doorCode"] },
      sampleValue,
    );

    expect(findings).toEqual([
      {
        key: "pre-arrival-reminder",
        field: "defaultBody",
        detail: '"Door code:"',
      },
    ]);
  });

  it("fails on an orphaned possessive when an optional name is empty", () => {
    const findings = findDanglingDefaultLines(
      {
        "school-attendee-confirmation": {
          defaultSubject: "Confirm your attendee list",
          defaultBody: "Hi {{firstName}}, {{schoolName}}'s stay is coming up.",
        },
      },
      { "school-attendee-confirmation": ["schoolName"] },
      sampleValue,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("'s stay");
  });
});

describe("#2268 guard 5 — the optional-token contract cannot rot", () => {
  it("names only tokens that are really in the default it describes", () => {
    expect(
      findStaleOptionalTokens(DEFAULTS, OPTIONAL_TEMPLATE_TOKENS),
    ).toEqual([]);
  });

  it("fails on a declaration for a token that is no longer in the body", () => {
    const findings = findStaleOptionalTokens(
      {
        "booking-confirmed": {
          defaultSubject: "Booking Confirmed",
          defaultBody: "Hi {{firstName}}.",
        },
      },
      { "booking-confirmed": ["promoSummary"], "gone-away": ["reasonNote"] },
    );

    expect(findings).toEqual([
      {
        key: "booking-confirmed",
        field: "defaultBody",
        detail: "promoSummary",
      },
      {
        key: "gone-away",
        field: "defaultBody",
        detail: "no such registered template",
      },
    ]);
  });
});

describe("#2268 — the swept defaults still validate and still re-save", () => {
  it("keeps every shipped default acceptable to the admin editor's validator", () => {
    const invalid = EMAIL_TEMPLATE_DEFINITIONS.filter(
      (definition) =>
        !validateEmailTemplateContent({
          templateName: definition.key,
          subject: definition.defaultSubject,
          bodyText: definition.defaultBody,
        }).valid,
    ).map((definition) => definition.key);

    expect(invalid).toEqual([]);
  });

  it("keeps a pre-#2268 override that uses the raw optional token valid", () => {
    // The whole point of leaving the raw values supplied: an admin who saved
    // "Door code: {{doorCode}}" before the sweep must not have their template
    // become unsaveable — including the required-token rule, which now names
    // {{doorCodeNote}} for pre-arrival-reminder.
    const validation = validateEmailTemplateContent({
      templateName: "pre-arrival-reminder",
      subject: "Pre-arrival Information",
      bodyText:
        "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    });

    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredTokens).toEqual([]);
  });

  it("accepts the new pre-composed token for the same required rule", () => {
    const validation = validateEmailTemplateContent({
      templateName: "pre-arrival-reminder",
      subject: "Pre-arrival Information",
      bodyText:
        "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    });

    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredTokens).toEqual([]);
  });

  it.each([
    ["membership-cancellation-approved", "adminNote"],
    ["booking-review-rejected", "adminNotes"],
    ["admin-new-booking", "reviewReason"],
    ["admin-refund-request", "requestedAmount"],
    ["split-guest-portion-cancelled", "bookingReference"],
    ["membership-payment-recorded", "amount"],
    ["admin-duplicate-capture-refund", "errorMessage"],
  ])("keeps %s's raw {{%s}} usable in an override", (key, token) => {
    const definition = getEmailTemplateDefinition(key);
    if (!definition) throw new Error(`missing definition for ${key}`);
    expect(definition.allowedTokens).toContain(token);
    expect(APPROVED_EMAIL_TEMPLATE_TOKEN_SET.has(token)).toBe(true);
  });

  it("no longer registers the dead credit-applied-to-booking template", () => {
    // Registered and admin-editable, but with no send site anywhere in src/ —
    // an admin could carefully word an email that was never sent (#2268).
    expect(getEmailTemplateDefinition("credit-applied-to-booking")).toBeUndefined();
  });
});
