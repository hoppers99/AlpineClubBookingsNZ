import { describe, it, expect, vi, beforeEach } from "vitest";

// #2328 — a member who put account credit towards a booking read
// "Total Paid: $300.00" on their confirmation while their card statement said
// $180.00, with nothing in the email to explain the $120.00 difference. Every
// send site passed the booking's finalPriceCents as the total and none of them
// carried the credit figure, because the applied credit lives in the member
// credit ledger.
//
// The fix is the {{promoSummary}} pattern: ONE shared row builder feeding both
// the hand-built HTML confirmation and the flat {{creditNote}} token an
// admin-editable body renders, with an empty-case contract so a booking that
// used no credit is byte-for-byte unchanged.

const { sendEmailMock, loadLodgeSettingsMock, loadAppliedCreditMock } =
  vi.hoisted(() => ({
    sendEmailMock: vi.fn().mockResolvedValue({ status: "sent" }),
    loadLodgeSettingsMock: vi.fn(),
    loadAppliedCreditMock: vi.fn(),
  }));

vi.mock("@/lib/email/core", () => ({
  sendEmail: sendEmailMock,
}));

// The sender reads this itself (that is the whole design — twelve send sites
// cannot each be trusted to remember). Stubbed so each case can state what the
// booking's persisted ledger and Payment row say.
vi.mock("@/lib/booking-confirmation-credit", () => ({
  loadBookingAppliedCredit: loadAppliedCreditMock,
}));

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: loadLodgeSettingsMock,
  loadEmailMessageSettings: vi.fn(),
  applyEmailMessageSettingsToHtml: vi.fn((html: string) => html),
  applyEmailMessageSettingsToSubject: vi.fn((subject: string) => subject),
  buildEmailTemplateGlobalData: vi.fn(() => ({})),
}));

import { getEmailTemplateDefinition } from "@/lib/email-message-registry";
import {
  appliedCreditSummaryRows,
  settledByPaymentCents,
  plainTextEmailTemplate,
  type ConfirmationSettlementMethod,
} from "@/lib/email-templates";
import {
  renderTemplateString,
  validateEmailTemplateContent,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";

const GLOBAL_DATA: EmailTemplateData = {
  BASE_URL: "https://bookings.example.org",
  CLUB_LODGE_TRAVEL_NOTE: "Take the Bruce Road.",
};

type AppliedCredit = {
  amountCents: number;
  settlementMethod: ConfirmationSettlementMethod;
};

const NO_CREDIT: AppliedCredit = { amountCents: 0, settlementMethod: "card" };

beforeEach(() => {
  vi.clearAllMocks();
  loadLodgeSettingsMock.mockResolvedValue({
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: "1234",
  });
  loadAppliedCreditMock.mockResolvedValue(NO_CREDIT);
});

function renderDefaultBody(templateData: EmailTemplateData): string {
  const definition = getEmailTemplateDefinition("booking-confirmed");
  if (!definition) throw new Error("missing booking-confirmed definition");
  return renderTemplateString(definition.defaultBody, {
    ...GLOBAL_DATA,
    ...templateData,
  });
}

// The same dangling-label check the #2267 suite uses: no rendered line may
// trail off after a sign, dash or colon, in the substituted body OR in the HTML
// a member actually receives.
function expectCleanBody(rendered: string) {
  for (const text of [rendered, plainTextEmailTemplate(rendered)]) {
    for (const line of text.split("\n")) {
      expect(
        line.trimEnd(),
        `dangling line: ${JSON.stringify(line)}`,
      ).not.toMatch(/[-+:–]$/);
    }
  }
}

async function send(
  totalCents: number,
  appliedCredit: AppliedCredit,
  senderOptions: Record<string, unknown> = {},
): Promise<{ templateData: EmailTemplateData; html: string }> {
  loadAppliedCreditMock.mockResolvedValue(appliedCredit);
  const { sendBookingConfirmedEmail } = await import("@/lib/email/booking");
  await sendBookingConfirmedEmail(
    { bookingId: "bk_2328" },
    "member@example.org",
    "Sam",
    new Date("2026-08-15"),
    new Date("2026-08-17"),
    2,
    totalCents,
    senderOptions,
  );
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  const call = sendEmailMock.mock.calls[0][0];
  expect(call.templateName).toBe("booking-confirmed");
  return { templateData: call.templateData, html: call.html };
}

describe("#2328 booking-confirmed applied-credit note", () => {
  it("states the movement a member can check against their card statement", async () => {
    // The issue's own numbers: a $300.00 stay, $120.00 of account credit, so
    // the card took $180.00.
    const { templateData, html } = await send(30000, {
      amountCents: 12000,
      settlementMethod: "card",
    });

    expect(templateData.creditNote).toBe(
      "Account credit applied: -$120.00\nPaid by card: $180.00\n",
    );
    // "Total Paid" stays the booking's FULL price, so the three numbers
    // reconcile: 300.00 − 120.00 = 180.00.
    expect(templateData.paymentOutcome).toBe(
      "Total Paid: $300.00\n" +
        "Account credit applied: -$120.00\n" +
        "Paid by card: $180.00\n\n" +
        "Payment has been processed successfully.",
    );
    expect(templateData.totalPaid).toBe("$300.00");

    const rendered = renderDefaultBody(templateData);
    expect(rendered).toContain(
      "Guests: 2\n" +
        "Total Paid: $300.00\n" +
        "Account credit applied: -$120.00\n" +
        "Paid by card: $180.00\n\n" +
        "Payment has been processed successfully.",
    );
    expectCleanBody(rendered);

    // Drift guard: the hand-built HTML shows the identical rows, in the same
    // order, under the same total.
    expect(html).toContain(">Total Paid</td>");
    expect(html).toContain(">$300.00</td>");
    expect(html).toContain(">Account credit applied</td>");
    expect(html).toContain(">-$120.00</td>");
    expect(html).toContain(">Paid by card</td>");
    expect(html).toContain(">$180.00</td>");
    expect(html.indexOf(">Total Paid</td>")).toBeLessThan(
      html.indexOf(">Account credit applied</td>"),
    );
    expect(html.indexOf(">Account credit applied</td>")).toBeLessThan(
      html.indexOf(">Paid by card</td>"),
    );
  });

  it("leaves a confirmation that used no credit byte-for-byte unchanged", async () => {
    const { templateData, html } = await send(30000, NO_CREDIT);

    // The empty-case contract: nothing at all, so no blank line and no ragged
    // label survive into the body.
    expect(templateData.creditNote).toBe("");
    expect(templateData.paymentOutcome).toBe(
      "Total Paid: $300.00\n\nPayment has been processed successfully.",
    );

    const rendered = renderDefaultBody(templateData);
    expect(rendered).toContain(
      "Guests: 2\nTotal Paid: $300.00\n\nPayment has been processed successfully.",
    );
    expect(rendered).not.toContain("Account credit");
    expect(rendered).not.toContain("Paid by");
    expectCleanBody(rendered);

    expect(html).not.toContain("Account credit applied");
    expect(html).not.toContain("Paid by card");
  });

  it("says the card took nothing when credit covered the whole stay", async () => {
    // booking-create's fully-credit-covered branch and the $0 settlement in
    // create-payment-intent both send this shape. "Total Paid: $300.00" alone
    // was at its most misleading here: the card was never touched.
    const { templateData, html } = await send(30000, {
      amountCents: 30000,
      settlementMethod: "card",
    });

    expect(templateData.creditNote).toBe(
      "Account credit applied: -$300.00\nPaid by card: $0.00\n",
    );
    expect(html).toContain(">-$300.00</td>");
    expect(html).toContain(">$0.00</td>");
    expectCleanBody(renderDefaultBody(templateData));
  });

  it.each([
    ["bank_transfer", "Paid by bank transfer"],
    ["manual", "Paid by cash or bank transfer"],
  ] as const)(
    "never tells a %s settlement their card was charged",
    async (settlementMethod, label) => {
      const { templateData, html } = await send(30000, {
        amountCents: 12000,
        settlementMethod,
      });

      expect(templateData.creditNote).toBe(
        `Account credit applied: -$120.00\n${label}: $180.00\n`,
      );
      expect(templateData.creditNote).not.toContain("Paid by card");
      expect(html).toContain(`>${label}</td>`);
      expect(html).not.toContain(">Paid by card</td>");
    },
  );

  it("breaks down the settled slice, not the price, on a partly-paid settle (#2397)", async () => {
    // A $200.00 booking with $50.00 of credit applied and $30.00 still owing
    // after an uncollected price increase: the club has $170.00 of the price,
    // of which $50.00 was credit, so $120.00 really was cash. Every figure
    // reconciles — 200.00 = 170.00 + 30.00, and 170.00 = 50.00 + 120.00.
    const { templateData, html } = await send(
      20000,
      { amountCents: 5000, settlementMethod: "manual" },
      { outstandingBalance: { amountCents: 3000, payableOnline: true } },
    );

    expect(templateData.paymentOutcome).toBe(
      "Booking Total: $200.00\n" +
        "Paid: $170.00\n" +
        "Account credit applied: -$50.00\n" +
        "Paid by cash or bank transfer: $120.00\n" +
        "Still Owing: $30.00\n\n" +
        "Your payment of $170.00 has been recorded and your booking is confirmed. " +
        "$30.00 is still owing from a later change to this booking. " +
        "You can pay it from your booking page.",
    );
    expectCleanBody(renderDefaultBody(templateData));

    // The HTML table keeps the same order: the pair explains "Paid" above it,
    // and "Still Owing" stays last.
    expect(html.indexOf(">Paid</td>")).toBeLessThan(
      html.indexOf(">Account credit applied</td>"),
    );
    expect(html.indexOf(">Paid by cash or bank transfer</td>")).toBeLessThan(
      html.indexOf(">Still Owing</td>"),
    );
  });

  it("claims no payment at all on a confirmed-but-unpaid send (#2263)", async () => {
    // Nothing has been settled, so there is no "paid by" figure to state. The
    // pair is suppressed rather than inventing one — a "Paid by card: $0.00"
    // line under "Total Due" would read as a failed payment.
    const { templateData, html } = await send(
      30000,
      { amountCents: 12000, settlementMethod: "bank_transfer" },
      { paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: false } },
    );

    expect(templateData.creditNote).toBe("");
    expect(templateData.paymentOutcome).toBe(
      "Total Due: $300.00\n\nThis booking is confirmed, but payment of $300.00 is still owing. " +
        "Please pay by internet banking quoting reference BOOKING-ABC123. " +
        "The club will send you an invoice for it.",
    );
    expect(html).not.toContain("Account credit applied");
    expectCleanBody(renderDefaultBody(templateData));
  });

  it("keeps the promo explanation and the credit explanation side by side", async () => {
    // Both pre-composed blocks on one send: the promo rows say why the price is
    // what it is, the credit rows say where the money came from.
    const { templateData } = await send(
      27000,
      { amountCents: 7000, settlementMethod: "card" },
      { promoAdjustmentCents: -3000, promoCode: "SPRING10" },
    );

    const rendered = renderDefaultBody(templateData);
    expect(rendered).toContain(
      "Subtotal: $300.00\n" +
        "Promo adjustment (SPRING10): -$30.00\n" +
        "Total Paid: $270.00\n" +
        "Account credit applied: -$70.00\n" +
        "Paid by card: $200.00",
    );
    expectCleanBody(rendered);
  });
});

describe("#2328 the shared row builder", () => {
  it("renders nothing at all when no credit was applied", () => {
    expect(appliedCreditSummaryRows(0, 18000, "card")).toEqual([]);
    // A negative amount cannot describe applied credit; it must not invent a
    // "+$…" line out of one.
    expect(appliedCreditSummaryRows(-1, 18000, "card")).toEqual([]);
  });

  it("renders nothing when nothing was settled to report", () => {
    // settledByPaymentCents returns a negative for an unpaid confirmation.
    expect(appliedCreditSummaryRows(12000, -1, "card")).toEqual([]);
  });

  it("signs the credit itself, so no body ever needs to type a minus", () => {
    expect(appliedCreditSummaryRows(12000, 18000, "card")).toEqual([
      { label: "Account credit applied", value: "-$120.00" },
      { label: "Paid by card", value: "$180.00" },
    ]);
  });

  it("computes the settled slice for each of the three money outcomes", () => {
    const base = { totalCents: 30000, appliedCreditCents: 12000 };
    // Paid in full: the whole price, less the credit.
    expect(
      settledByPaymentCents({ ...base, unpaid: false, outstandingCents: 0 }),
    ).toBe(18000);
    // Partly paid: the settled slice, less the credit.
    expect(
      settledByPaymentCents({ ...base, unpaid: false, outstandingCents: 10000 }),
    ).toBe(8000);
    // Unpaid: negative, which suppresses the rows.
    expect(
      settledByPaymentCents({ ...base, unpaid: true, outstandingCents: 0 }),
    ).toBeLessThan(0);
  });
});

describe("#2328 the {{creditNote}} token contract", () => {
  it("is approved and allowed on booking-confirmed, so an admin can use it", () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed definition");
    // The #2267 failure mode in reverse: supplied and computed, but rejected by
    // the editor as an unknown token, so no admin could ever put it in a body.
    expect(definition.allowedTokens).toContain("creditNote");
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}.\n\n{{promoSummary}}Total Paid: {{totalPaid}}\n{{creditNote}}\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    });
    expect(validation.valid).toBe(true);
    expect(validation.unknownTokens).toEqual([]);
    expect(validation.disallowedTokens).toEqual([]);
  });

  it("rejects a hand-typed minus in front of it, like {{promoAdjustment}}", () => {
    // Its first line already reads "Account credit applied: -$120.00", so
    // "-{{creditNote}}" renders "--$120.00" — and a bare "-" for the majority
    // of bookings, which use no credit at all.
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}.\n\n{{promoSummary}}Credit: -{{creditNote}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    });
    expect(validation.valid).toBe(false);
    expect(validation.signPrefixedTokens).toContain("creditNote");
  });

  it("leaves an override saved before #2328 valid and re-savable", () => {
    // The token is NOT required: a club that hand-built its money lines before
    // this existed must keep rendering and keep saving.
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}.\n\nSubtotal: {{subtotal}}\nDiscount ({{promoCode}}): {{discount}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    });
    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredTokens).toEqual([]);
  });
});
