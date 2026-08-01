import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";

// #2444 — the confirmed-but-UNPAID booking confirmation told a member to
// transfer the booking's FULL price ("Total Due: $300.00") without ever
// mentioning the invoice that figure is supposed to agree with. The invoice is
// a separate document a club admin can adjust by hand — netting a member's
// account credit off it, most commonly — so a member who transfers the emailed
// figure can send more than the club is asking for.
//
// The INTERIM fix (owner decision, 1 Aug 2026): one neutral, conditional
// sentence pointing at the invoice. No figure is computed and no Xero read is
// made — the computed-figure version is deliberately its own later piece of
// work.
//
// WHAT THE SENTENCE MUST NOT SAY, and why (review, 1 Aug 2026). Its first draft
// promised that credit a member holds "will be applied to your invoice",
// justified by #1620 "allocate-existing". That is FALSE on this path: the one
// send site mints a brand-new booking with no BOOKING_APPLIED ledger rows, so
// the allocation op it enqueues always short-circuits and the invoice stands at
// the full price. The guard below pins the copy against promising it again.
//
// What is pinned here is that the sentence renders on the paymentDue branch and
// NOWHERE else, that both renderers get it from the one shared composer, that
// it promises nothing the system does not do, and that it reads sensibly for
// the great majority of members, who hold no account credit at all.

const { sendEmailMock, loadLodgeSettingsMock, loadAppliedCreditMock } =
  vi.hoisted(() => ({
    sendEmailMock: vi.fn().mockResolvedValue({ status: "sent" }),
    loadLodgeSettingsMock: vi.fn(),
    loadAppliedCreditMock: vi.fn(),
  }));

vi.mock("@/lib/email/core", () => ({
  sendEmail: sendEmailMock,
}));

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

import {
  EXTRA_TEMPLATE_TOKENS,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import {
  EMPTYABLE_OVERRIDE_TOKENS,
  OPTIONAL_TEMPLATE_TOKENS,
  findDanglingDefaultLines,
} from "@/lib/email-message-token-contract";
import { bookingPaymentDueNote } from "@/lib/email-message-notes";
import {
  bookingConfirmedTemplate,
  plainTextEmailTemplate,
} from "@/lib/email-templates";
import {
  renderTemplateString,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";

// THE FIXTURE. Every assertion below — the flat token, the composed
// {{paymentOutcome}} block, the rendered default body, and the hand-built HTML
// a member actually receives — is checked against this ONE string, which is why
// the two renderers cannot be allowed to drift apart.
const CREDIT_SENTENCE =
  "If the invoice asks for a different amount — for example because the club " +
  "has put account credit you hold towards it — please transfer the amount " +
  "the invoice shows.";

// A short marker for the "renders nowhere else" assertions, so they keep
// working if the sentence is reworded but keep failing if it leaks.
const SENTENCE_MARKER = "the amount the invoice shows";

const GLOBAL_DATA: EmailTemplateData = {
  BASE_URL: "https://bookings.example.org",
  CLUB_LODGE_TRAVEL_NOTE: "Take the Bruce Road.",
};

const NO_CREDIT = { amountCents: 0, settlementMethod: "card" as const };

const CHECK_IN = new Date("2026-08-15");
const CHECK_OUT = new Date("2026-08-17");

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

async function send(
  senderOptions: Record<string, unknown> = {},
): Promise<{ templateData: EmailTemplateData; html: string }> {
  const { sendBookingConfirmedEmail } = await import("@/lib/email/booking");
  await sendBookingConfirmedEmail(
    { bookingId: "bk_2444", recipientMemberId: "member_2444" },
    "member@example.org",
    "Sam",
    CHECK_IN,
    CHECK_OUT,
    2,
    30000,
    senderOptions,
  );
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  const call = sendEmailMock.mock.calls[0][0];
  expect(call.templateName).toBe("booking-confirmed");
  return { templateData: call.templateData, html: call.html };
}

const PAYMENT_DUE = {
  paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: true },
};

describe("#2444 the unpaid confirmation's pay-what-the-invoice-asks sentence", () => {
  it("tells an unpaid member to transfer what the invoice asks for", async () => {
    const { templateData, html } = await send(PAYMENT_DUE);

    // The flat token an override may place on its own, the pre-composed block
    // the shipped default body renders, and the HTML — one sentence, three
    // paths, from one composer.
    expect(templateData.paymentDueNote).toContain(CREDIT_SENTENCE);
    expect(templateData.paymentOutcome).toContain(CREDIT_SENTENCE);
    expect(html).toContain(CREDIT_SENTENCE);

    // It follows the existing #2263 story rather than replacing any of it: the
    // amount owing, the reference to quote, and what is happening about an
    // invoice all still come first.
    expect(templateData.paymentOutcome).toBe(
      "Total Due: $300.00\n\n" +
        "This booking is confirmed, but payment of $300.00 is still owing. " +
        "Please pay by internet banking quoting reference BOOKING-ABC123. " +
        "An invoice has been emailed to you separately. " +
        CREDIT_SENTENCE,
    );

    const rendered = renderDefaultBody(templateData);
    expect(rendered).toContain(CREDIT_SENTENCE);
    // No line trails off after a label, sign or dash, in the substituted body
    // or in the plain text a member receives.
    for (const text of [rendered, plainTextEmailTemplate(rendered)]) {
      for (const line of text.split("\n")) {
        expect(
          line.trimEnd(),
          `dangling line: ${JSON.stringify(line)}`,
        ).not.toMatch(/[-+:–]$/);
      }
    }
  });

  it("reads as a condition, not as a claim about this member's invoice", async () => {
    // Most invoices ask for exactly the "Total Due" figure, so an unconditional
    // "your invoice asks for less" would be false for nearly everyone. The
    // sentence must open with the condition and must state no figure — there is
    // no Xero read on this path and none is wanted (the send would then carry a
    // provider round-trip, and a provider outage, into a member's
    // confirmation).
    const { templateData, html } = await send(PAYMENT_DUE);

    expect(CREDIT_SENTENCE.startsWith("If the invoice asks for a")).toBe(true);
    // No second money figure anywhere in the paragraph: the only amount an
    // unpaid confirmation names is the booking's own price.
    expect(
      (templateData.paymentDueNote as string).match(/\$[\d,]+\.\d{2}/g),
    ).toEqual(["$300.00"]);
    // And no credit BREAKDOWN — nothing has been settled, so there is no
    // "paid by" story and #2328's pair stays suppressed (its own suite pins
    // why that is safe on this path).
    expect(templateData.creditNote).toBe("");
    expect(html).not.toContain("Account credit applied");
  });

  it("says the same thing when the club raises no invoice automatically", async () => {
    // Xero module off: the club sends the invoice by hand, and the member still
    // must not transfer the figure above it if they hold credit.
    const { templateData } = await send({
      paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: false },
    });

    expect(templateData.paymentDueNote).toBe(
      "This booking is confirmed, but payment of $300.00 is still owing. " +
        "Please pay by internet banking quoting reference BOOKING-ABC123. " +
        "The club will send you an invoice for it. " +
        CREDIT_SENTENCE,
    );
  });

  it.each([
    ["paid in full", {}],
    [
      "partly paid (#2397)",
      { outstandingBalance: { amountCents: 3000, payableOnline: true } },
    ],
  ])("says nothing about the invoice amount on a %s confirmation", async (
    _label,
    senderOptions,
  ) => {
    const { templateData, html } = await send(senderOptions);

    expect(templateData.paymentDueNote).toBe("");
    expect(templateData.paymentOutcome).not.toContain(SENTENCE_MARKER);
    expect(renderDefaultBody(templateData)).not.toContain(SENTENCE_MARKER);
    expect(html).not.toContain(SENTENCE_MARKER);
  });

  it("says nothing about it when account credit covered the whole stay", async () => {
    // The one settled case where credit really was involved. It is settled, so
    // there is nothing left to transfer and no invoice to check — the #2328
    // pair already explains where the money came from, and this sentence would
    // only invite a member to go looking for a payment they do not owe.
    loadAppliedCreditMock.mockResolvedValue({
      amountCents: 30000,
      settlementMethod: "card" as const,
    });
    const { templateData, html } = await send();

    expect(templateData.creditNote).toBe(
      "Account credit applied: -$300.00\nNothing more to pay: $0.00\n",
    );
    expect(templateData.paymentDueNote).toBe("");
    expect(html).not.toContain(SENTENCE_MARKER);
  });

  it("renders identically from the HTML template and the flat token", async () => {
    // The drift guard proper. #2263 kept two hand-written copies of this
    // paragraph, one per renderer; #2444 had to add a sentence to it, so the
    // paragraph moved to a single composer. Both renderers are driven from the
    // same fixture here, so a change made to one and not the other fails.
    const { templateData, html } = await send(PAYMENT_DUE);
    const composed = bookingPaymentDueNote({
      amount: "$300.00",
      reference: "BOOKING-ABC123",
      invoiceEmailed: true,
    });

    expect(templateData.paymentDueNote).toBe(composed);
    expect(html).toContain(composed);
    expect(
      bookingConfirmedTemplate("Sam", CHECK_IN, CHECK_OUT, 2, 30000, {
        paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: true },
      }),
    ).toContain(composed);
  });

  it("escapes a club-entered reference on the HTML path only", async () => {
    // The composer takes the reference ALREADY escaped for the caller's medium
    // (it imports nothing and knows nothing about HTML), exactly as the shared
    // money rows do. The plain-text token must keep the raw reference or a
    // member cannot type it into their banking app.
    const html = bookingConfirmedTemplate("Sam", CHECK_IN, CHECK_OUT, 2, 30000, {
      paymentDue: { reference: "A&B<1>", invoiceEmailed: false },
    });

    expect(html).toContain("quoting reference A&amp;B&lt;1&gt;.");
    expect(html).not.toContain("quoting reference A&B<1>.");

    const { templateData } = await send({
      paymentDue: { reference: "A&B<1>", invoiceEmailed: false },
    });
    expect(templateData.paymentDueNote).toContain("quoting reference A&B<1>.");
  });
});

describe("#2444 the shared composer", () => {
  it("appends the sentence to both invoice outcomes and nothing else", () => {
    for (const invoiceEmailed of [true, false]) {
      const note = bookingPaymentDueNote({
        amount: "$120.00",
        reference: "BOOKING-XYZ",
        invoiceEmailed,
      });
      expect(note.endsWith(CREDIT_SENTENCE)).toBe(true);
      expect(note).toContain(
        "This booking is confirmed, but payment of $120.00 is still owing.",
      );
      expect(note).toContain("quoting reference BOOKING-XYZ.");
    }

    expect(
      bookingPaymentDueNote({
        amount: "$120.00",
        reference: "BOOKING-XYZ",
        invoiceEmailed: true,
      }),
    ).toContain("An invoice has been emailed to you separately.");
    expect(
      bookingPaymentDueNote({
        amount: "$120.00",
        reference: "BOOKING-XYZ",
        invoiceEmailed: false,
      }),
    ).toContain("The club will send you an invoice for it.");
  });

  it("is one paragraph, so no body can leave it half-rendered", () => {
    // It is supplied as a single {{paymentDueNote}} value and carried whole
    // inside {{paymentOutcome}}; an override cannot place the payment
    // instruction without the credit caveat that qualifies it.
    const note = bookingPaymentDueNote({
      amount: "$120.00",
      reference: "BOOKING-XYZ",
      invoiceEmailed: true,
    });
    expect(note).not.toContain("\n");
  });

  it("promises no credit netting the system does not actually do", () => {
    // THE REGRESSION GUARD for this issue's own first draft, which said "If you
    // hold account credit with the club, it will be applied to your invoice".
    // Nothing on the one send path applies credit (see the premise test below),
    // so that was a promise the club would silently break. The sentence may
    // point at the invoice and may explain WHY the two figures can differ; it
    // may not assert that anything will happen to this member's invoice.
    const note = bookingPaymentDueNote({
      amount: "$120.00",
      reference: "BOOKING-XYZ",
      invoiceEmailed: true,
    });

    for (const promise of [
      "it will be applied",
      "will be applied to your invoice",
      "has been applied to your invoice",
      "credit has been applied",
    ]) {
      expect(note.toLowerCase(), `unkeepable promise: ${promise}`).not.toContain(
        promise,
      );
    }
    // Whatever it says about credit must sit behind the invoice condition.
    expect(note).toContain("If the invoice asks for a different amount");
    expect(note.indexOf("If the invoice asks for a different amount")).toBeLessThan(
      note.indexOf("account credit"),
    );
  });

  it("rests on a send path that applies no account credit at all", () => {
    // The sentence is worded around what this path really does. It mints a
    // brand-new booking and writes NO MemberCredit row, so the
    // enqueueXeroAppliedCreditAllocationOperation call it makes always
    // short-circuits ("No unallocated applied credit; nothing to allocate.")
    // and the Xero invoice stands at the full price. If that ever changes, the
    // copy can — and should — be revisited, so fail here rather than let the
    // wording quietly become either wrong or needlessly timid.
    // (#2328's own suite pins the single-send-site half of this premise.)
    const source = readFileSync(
      path.join(process.cwd(), "src", "lib", "school-booking-request.ts"),
      "utf8",
    );

    expect(source).not.toContain("BOOKING_APPLIED");
    expect(source).not.toContain("applyCreditToBooking");
    expect(source).not.toContain("memberCredit");
  });
});

describe("#2444 the token contract is unchanged", () => {
  it("adds no new token, so every saved override keeps rendering", () => {
    // The sentence rides on {{paymentDueNote}}, which #2263 already supplies
    // and approves. A NEW token would have been invisible to every club that
    // saved an override before today — on the one branch where following the
    // email can make a member overpay.
    //
    // Review (1 Aug 2026): asserting that two pre-existing tokens are present
    // does NOT pin "no token was added" — it would pass unchanged if a later
    // edit added {{creditCaveat}} beside them. The exact supplied-token list is
    // what holds the line, so a token added here has to be argued for in this
    // test rather than slipped in.
    expect(EXTRA_TEMPLATE_TOKENS["booking-confirmed"]).toEqual([
      "creditNote",
      "discount",
      "doorCode",
      "doorCodeNote",
      "paymentDueNote",
      "paymentOutcome",
      "paymentReference",
      "promoAdjustment",
      "promoCode",
      "promoSummary",
      "provisionalGuestsNote",
      "subtotal",
      "totalDue",
      "totalPaid",
    ]);

    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed definition");
    expect(definition.allowedTokens).toContain("paymentDueNote");
    expect(definition.allowedTokens).toContain("paymentOutcome");
  });

  it("previews the real paragraph, not the word 'paymentDueNote'", async () => {
    // Review (1 Aug 2026). The preview IS the admin's only picture of what a
    // member reads, and a pre-composed token whose sample is its own name
    // teaches an admin to lay a body out for a shape no member receives —
    // here, invisible payment advice. #2263 registered the token without a
    // sample; #2444 is what puts the club's payment instructions in it.
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed definition");

    const sample = definition.sampleData.paymentDueNote;
    expect(sample).not.toBe("paymentDueNote");
    // Composed by the SAME function the send uses, so the preview cannot drift
    // from the message.
    expect(sample).toBe(
      bookingPaymentDueNote({
        amount: "$123.45",
        reference: "BOOKING-1234",
        invoiceEmailed: true,
      }),
    );
    expect(sample).toContain(CREDIT_SENTENCE);
    // And it reconciles: the reference it tells a member to quote is the one
    // {{paymentReference}} previews beside it.
    expect(definition.sampleData.paymentReference).toBe("BOOKING-1234");
    expect(sample).toContain(
      `quoting reference ${definition.sampleData.paymentReference}.`,
    );
  });

  it("is declared EMPTYABLE, so the editor warns about a label typed in front", () => {
    // Review (1 Aug 2026) — mutation pin, mirroring #2328's for {{creditNote}}.
    // The token is "" on every paid, partly-paid and credit-covered send (the
    // cases above), so an override that writes "Payment: {{paymentDueNote}}"
    // sends a bare "Payment:" to everyone who has already paid. Undeclared,
    // guard 4 renders the token with its (non-empty) preview sample, sees a
    // full line and stays quiet. This drives the guard exactly as
    // `GET /api/admin/email-templates` does.
    expect(EMPTYABLE_OVERRIDE_TOKENS["booking-confirmed"]).toContain(
      "paymentDueNote",
    );

    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed definition");
    const findings = findDanglingDefaultLines(
      {
        "booking-confirmed": {
          defaultSubject: "Booking Confirmed",
          defaultBody:
            "Hi {{firstName}}.\n\nPayment: {{paymentDueNote}}\n\nThanks.",
        },
      },
      {
        "booking-confirmed": [
          ...(OPTIONAL_TEMPLATE_TOKENS["booking-confirmed"] ?? []),
          ...(EMPTYABLE_OVERRIDE_TOKENS["booking-confirmed"] ?? []),
        ],
      },
      (token) => definition.sampleData[token] ?? token,
    );

    expect(findings).toEqual([
      {
        key: "booking-confirmed",
        field: "defaultBody",
        detail: '"Payment:"',
      },
    ]);
  });
});
