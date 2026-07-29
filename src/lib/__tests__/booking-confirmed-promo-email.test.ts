import { describe, it, expect, vi, beforeEach } from "vitest";

// #2267 — a price-raising FIXED_NIGHTLY/SET_PRICE promo rendered a blank
// "Discount: -" line and an unexplained total in the admin-editable
// booking-confirmed body. These tests render the DEFAULT bodies through
// renderTemplateString with the exact templateData the senders build — the
// override render path prepareEmailMessage takes — for all three promo
// shapes, and pin the flat body to the hand-built HTML template so the two
// money stories can never drift apart again (the 31651e00 failure mode).

const { sendEmailMock, loadLodgeSettingsMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue({ status: "sent" }),
  loadLodgeSettingsMock: vi.fn(),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: sendEmailMock,
}));

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  // Search key the email `<title>` bakes (C6 #1985); required alongside
  // EMAIL_DEFAULT_LODGE_NAME whenever this module is mocked and a template renders.
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: loadLodgeSettingsMock,
  loadEmailMessageSettings: vi.fn(),
  applyEmailMessageSettingsToHtml: vi.fn((html: string) => html),
  applyEmailMessageSettingsToSubject: vi.fn((subject: string) => subject),
  buildEmailTemplateGlobalData: vi.fn(() => ({})),
}));

import { getEmailTemplateDefinition } from "@/lib/email-message-registry";
import {
  renderTemplateString,
  validateEmailTemplateContent,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";

// The global tokens prepareEmailMessage merges in from settings; supplied here
// so the rendered default body has no artificial holes at the global tokens.
const GLOBAL_DATA: EmailTemplateData = {
  BASE_URL: "https://bookings.example.org",
  CLUB_LODGE_TRAVEL_NOTE: "Take the Bruce Road.",
};

// Most clubs have a door code; the doorCode-unset cells below override it.
beforeEach(() => {
  loadLodgeSettingsMock.mockResolvedValue({
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: "1234",
  });
});

function renderDefaultBody(
  templateName: string,
  templateData: EmailTemplateData,
): string {
  const definition = getEmailTemplateDefinition(templateName);
  if (!definition) throw new Error(`missing definition for ${templateName}`);
  return renderTemplateString(definition.defaultBody, {
    ...GLOBAL_DATA,
    ...templateData,
  });
}

// The assertion that would have caught the original bug: no rendered line may
// trail off after a minus sign or a colon (the blank "Discount: -" line), and
// bracket authoring notes must never reach a member inbox as body text.
function expectCleanLines(rendered: string) {
  expect(rendered).not.toContain("[only when");
  expect(rendered).not.toContain("[when");
  for (const line of rendered.split("\n")) {
    const trimmed = line.trimEnd();
    expect(trimmed, `dangling line: ${JSON.stringify(line)}`).not.toMatch(
      /[-:]$/,
    );
  }
}

async function captureConfirmedTemplateData(
  totalCents: number,
  options?: {
    promoAdjustmentCents?: number;
    promoCode?: string;
    // Lodge door code for this send; null models a club that records none.
    doorCode?: string | null;
  },
): Promise<{ templateData: EmailTemplateData; html: string }> {
  if (options && "doorCode" in options) {
    loadLodgeSettingsMock.mockResolvedValue({
      lodgeTravelNote: "Take the Bruce Road.",
      doorCode: options.doorCode,
    });
  }
  const { sendBookingConfirmedEmail } = await import("../email/booking");
  await sendBookingConfirmedEmail(
    { bookingId: "bk_test" },
    "member@example.org",
    "Sam",
    new Date("2026-08-15"),
    new Date("2026-08-16"),
    options?.promoAdjustmentCents ? 1 : 2,
    totalCents,
    options,
  );
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  const call = sendEmailMock.mock.calls[0][0];
  expect(call.templateName).toBe("booking-confirmed");
  return { templateData: call.templateData, html: call.html };
}

describe("booking-confirmed promo summary (#2267)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explains a price-raising SET_PRICE promo with a visibly positive adjustment (the incident shape)", async () => {
    // FULL_LODGE_RATE_2025: 1 guest × 1 night base $30.00, exclusive-use flat
    // rate raises the price by +$1,370.00 to $1,400.00.
    const { templateData, html } = await captureConfirmedTemplateData(140000, {
      promoAdjustmentCents: 137000,
      promoCode: "FULL_LODGE_RATE_2025",
    });

    const rendered = renderDefaultBody("booking-confirmed", templateData);

    // Subtotal, adjustment and total reconcile, and the adjustment is signed.
    expect(rendered).toContain(
      "Guests: 1\n" +
        "Subtotal: $30.00\n" +
        "Promo adjustment (FULL_LODGE_RATE_2025): +$1,370.00\n" +
        "Total Paid: $1,400.00",
    );
    // The old discount-only wording could not express a surcharge — it must
    // not reappear anywhere in the rendered body.
    expect(rendered).not.toContain("Discount");
    expectCleanLines(rendered);

    // Drift guard: the hand-built HTML path tells the identical money story.
    expect(html).toContain("Subtotal");
    expect(html).toContain("$30.00");
    expect(html).toContain("Promo adjustment (FULL_LODGE_RATE_2025)");
    expect(html).toContain("+$1,370.00");
    expect(html).toContain("$1,400.00");
  });

  it("renders a discount promo with a negative adjustment", async () => {
    const { templateData, html } = await captureConfirmedTemplateData(27000, {
      promoAdjustmentCents: -3000,
      promoCode: "SPRING10",
    });

    const rendered = renderDefaultBody("booking-confirmed", templateData);

    expect(rendered).toContain(
      "Guests: 1\n" +
        "Subtotal: $300.00\n" +
        "Promo adjustment (SPRING10): -$30.00\n" +
        "Total Paid: $270.00",
    );
    expectCleanLines(rendered);

    expect(html).toContain("Promo adjustment (SPRING10)");
    expect(html).toContain("-$30.00");
  });

  it("renders no promo lines at all — not ragged, not empty — without a promo", async () => {
    const { templateData, html } = await captureConfirmedTemplateData(30000);

    expect(templateData.promoSummary).toBe("");
    const rendered = renderDefaultBody("booking-confirmed", templateData);

    // The {{promoSummary}} token collapses to nothing: Total Paid follows
    // Guests directly with no blank or ragged line in between.
    expect(rendered).toContain("Guests: 2\nTotal Paid: $300.00");
    expect(rendered).not.toContain("Subtotal");
    expect(rendered).not.toContain("Promo adjustment");
    expectCleanLines(rendered);

    expect(html).not.toContain("Subtotal");
    expect(html).not.toContain("Promo adjustment");
  });

  it("renders the whole door-code line when the lodge has a code", async () => {
    const { templateData } = await captureConfirmedTemplateData(30000, {
      doorCode: "1234",
    });

    expect(templateData.doorCodeNote).toBe("Door code: 1234");
    const rendered = renderDefaultBody("booking-confirmed", templateData);
    expect(rendered).toContain("Door code: 1234");
    expectCleanLines(rendered);
  });

  it("renders no door-code line at all for a club that records no door code", async () => {
    const { templateData } = await captureConfirmedTemplateData(30000, {
      doorCode: null,
    });

    // The bare value is still supplied (empty) for legacy overrides, but the
    // pre-composed line collapses to nothing, so the default body cannot emit
    // the dangling "Door code:" line it used to.
    expect(templateData.doorCode).toBe("");
    expect(templateData.doorCodeNote).toBe("");
    const rendered = renderDefaultBody("booking-confirmed", templateData);
    expect(rendered).not.toContain("Door code");
    expectCleanLines(rendered);
  });

  it("keeps an existing override that writes its own Door code line valid and re-savable", () => {
    // The pre-#2267 override shape: the label is written by hand around the
    // bare {{doorCode}} value. It must still satisfy the required-token rule,
    // or an operator could no longer re-save their own saved body.
    const legacy = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}, you're confirmed.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    });
    expect(legacy.missingRequiredTokens).toEqual([]);
    expect(legacy.valid).toBe(true);

    // The new pre-composed token satisfies it directly.
    const composed = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}, you're confirmed.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    });
    expect(composed.valid).toBe(true);

    // Dropping the door code entirely is still rejected.
    const missing = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText: "Hi {{firstName}}, you're confirmed.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}",
    });
    expect(missing.valid).toBe(false);
    expect(missing.missingRequiredTokens).toContain("doorCodeNote");
  });

  it("never lets the composed door-code line into a subject line", () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    // The composed line carries the code itself, so it is subject-forbidden
    // exactly like the bare {{doorCode}} value.
    const result = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed {{doorCodeNote}}",
      bodyText: definition.defaultBody,
    });
    expect(result.valid).toBe(false);
    expect(result.sensitiveSubjectTokens).toContain("doorCodeNote");
  });

  it("keeps the split provisionalGuestsNote token in the default body (CONFIGURATION.md mandate)", () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    expect(definition.defaultBody).toContain("{{provisionalGuestsNote}}");
    for (const token of definition.requiredTokens) {
      expect(definition.defaultBody).toContain(`{{${token}}}`);
    }
  });

  it("keeps the legacy per-piece promo tokens valid for existing overrides, including {{promoAdjustment}}", async () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    expect(definition.allowedTokens).toEqual(
      expect.arrayContaining([
        "discount",
        "promoAdjustment",
        "promoCode",
        "promoSummary",
        "provisionalGuestsNote",
        "subtotal",
      ]),
    );

    // Acceptance (#2267): {{promoAdjustment}} passes admin-editor validation —
    // before this fix it was rejected as both unknown and disallowed.
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}, promo adjustment {{promoAdjustment}} applied.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    });
    expect(validation.valid).toBe(true);

    // The send still supplies the legacy tokens for such overrides, with the
    // signed value carrying its own +/-.
    const { templateData } = await captureConfirmedTemplateData(140000, {
      promoAdjustmentCents: 137000,
      promoCode: "FULL_LODGE_RATE_2025",
    });
    expect(templateData.promoAdjustment).toBe("+$1,370.00");
    expect(templateData.subtotal).toBe("$30.00");
    expect(templateData.discount).toBe("");
  });
});

describe("booking-modified default body (#2267)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function captureModifiedTemplateData(overrides: {
    newFinalPriceCents: number;
    additionalAmountCents?: number;
    additionalPaymentMethod?: "STRIPE" | "INTERNET_BANKING";
    paymentReference?: string | null;
    xeroInvoiceNumber?: string | null;
  }): Promise<EmailTemplateData> {
    const { sendBookingModifiedEmail } = await import("../email/booking");
    await sendBookingModifiedEmail({
      bookingId: "bk_test",
      email: "member@example.org",
      firstName: "Sam",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-08-15"),
      oldCheckOut: new Date("2026-08-18"),
      newCheckIn: new Date("2026-08-16"),
      newCheckOut: new Date("2026-08-19"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 30000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 0,
      ...overrides,
    });
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.templateName).toBe("booking-modified");
    return call.templateData;
  }

  it("renders every money line unconditionally with no authoring notes or ragged lines", async () => {
    const templateData = await captureModifiedTemplateData({
      newFinalPriceCents: 37000,
      additionalAmountCents: 7000,
      additionalPaymentMethod: "INTERNET_BANKING",
      paymentReference: "ABC123",
      xeroInvoiceNumber: "INV-100",
    });

    const rendered = renderDefaultBody("booking-modified", templateData);

    expect(rendered).toContain("Previous Total: $300.00");
    expect(rendered).toContain("New Total: $370.00");
    expect(rendered).toContain("Change Fee: $0.00");
    // The additional-payment story arrives through the pre-composed
    // {{paymentNote}}, which already carries the Xero invoice and reference.
    expect(rendered).toContain(
      "An additional Internet Banking payment of $70.00 is required.",
    );
    expect(rendered).toContain("Xero invoice INV-100");
    expect(rendered).toContain("Payment reference: ABC123.");
    expectCleanLines(rendered);
  });

  it("renders cleanly when no payment movement occurred (empty paymentNote)", async () => {
    const templateData = await captureModifiedTemplateData({
      newFinalPriceCents: 30000,
    });

    expect(templateData.paymentNote).toBe("");
    const rendered = renderDefaultBody("booking-modified", templateData);

    expect(rendered).toContain("Previous Total: $300.00");
    expect(rendered).toContain("New Total: $300.00");
    expectCleanLines(rendered);
  });

  it("keeps the per-piece additional-payment tokens allowed for existing overrides", () => {
    const definition = getEmailTemplateDefinition("booking-modified");
    if (!definition) throw new Error("missing booking-modified");
    expect(definition.allowedTokens).toEqual(
      expect.arrayContaining([
        "additionalPaymentMethod",
        "paymentReference",
        "xeroInvoiceNumber",
        "paymentNote",
      ]),
    );
  });
});

describe("reverse-drift guard: no bracket annotations in the money default bodies (#2267)", () => {
  it.each(["booking-confirmed", "booking-modified"] as const)(
    "keeps the %s default body free of [only when …] authoring notes",
    (key) => {
      const definition = getEmailTemplateDefinition(key);
      if (!definition) throw new Error(`missing ${key}`);
      expect(definition.defaultBody).not.toMatch(/\[only when|\[when /);
      expect(definition.defaultSubject).not.toMatch(/\[only when|\[when /);
    },
  );
});
