import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2320 review (MED-3) — bind the four "false claim" senders to the composed
 * note tokens their shipped default bodies depend on.
 *
 * The #2268 guards prove properties of the REGISTRY (defaults, approvals,
 * optional declarations), and the note helpers have their own unit truth — but
 * nothing proved the SENDERS still put the composed paragraph into
 * templateData. Drop one supply line (`settlementActionNote: ...`) and the
 * registry guards stay green while every club override of that template
 * renders the token as "" — silently deleting exactly the outcome-dependent
 * sentence #2268 existed to make truthful. These tests call each real sender
 * with a representative fixture, capture the templateData it builds, and
 * render the SHIPPED default body with it, asserting the note's lead sentence
 * survives end to end.
 */

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendToAdmins: vi.fn(),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: mocks.sendToAdmins,
}));

import { EMAIL_AUDIT_DEFAULTS } from "@/lib/email-message-audit-defaults";
import {
  renderTemplateString,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";
import {
  sendAdminSplitSettlementCancelledAlert,
  sendAdminSplitSettlementUnpaidAlert,
} from "@/lib/email/admin-alerts-booking";
import { sendAdminDuplicateCaptureRefundAlert } from "@/lib/email/admin-alerts-finance";
import {
  sendBookingBumpedEmail,
  sendSplitGuestPortionCancelledEmail,
} from "@/lib/email/booking";

function capturedAdminTemplateData(): EmailTemplateData {
  expect(mocks.sendToAdmins).toHaveBeenCalledTimes(1);
  const [args] = mocks.sendToAdmins.mock.calls[0] as [
    { templateData: EmailTemplateData },
  ];
  return args.templateData;
}

function renderDefaultBody(
  templateName: keyof typeof EMAIL_AUDIT_DEFAULTS,
  data: EmailTemplateData,
): string {
  return renderTemplateString(
    EMAIL_AUDIT_DEFAULTS[templateName].defaultBody,
    data,
  );
}

describe("#2320 review — senders supply the composed notes their defaults render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue(undefined);
    mocks.sendToAdmins.mockResolvedValue(undefined);
  });

  it("admin-split-settlement-unpaid: {{settlementActionNote}} is supplied and renders its lead sentence", async () => {
    await sendAdminSplitSettlementUnpaidAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      guestCount: 3,
      totalCents: 45000,
      holdUntil: new Date("2026-07-09T18:00:00.000Z"),
      parentUnpaid: false,
    });

    const data = capturedAdminTemplateData();
    expect(typeof data.settlementActionNote).toBe("string");
    expect(String(data.settlementActionNote).trim()).not.toBe("");

    const rendered = renderDefaultBody("admin-split-settlement-unpaid", data);
    expect(rendered).toContain(
      "A split booking reached its hold deadline for the non-member guest portion",
    );
    // The truthful outcome arm for this fixture: a link WAS emailed.
    expect(rendered).toContain(
      "A secure payment link has been emailed to the member",
    );
  });

  it("admin-split-settlement-cancelled: {{settlementActionNote}} is supplied and renders its lead sentence", async () => {
    await sendAdminSplitSettlementCancelledAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      guestCount: 3,
      totalCents: 45000,
      parentUnpaid: false,
    });

    const data = capturedAdminTemplateData();
    expect(typeof data.settlementActionNote).toBe("string");
    expect(String(data.settlementActionNote).trim()).not.toBe("");

    const rendered = renderDefaultBody(
      "admin-split-settlement-cancelled",
      data,
    );
    expect(rendered).toContain(
      "A split booking's non-member guest portion was still unpaid at the end of its check-in day",
    );
    // The cancelled paragraph, not the recurring unpaid alert's (they share a
    // token name; supplying the wrong helper's output must go red).
    expect(rendered).toContain(
      "The provisional guest booking has now been automatically cancelled",
    );
    expect(rendered).not.toContain("hold has been extended");
  });

  it("admin-duplicate-capture-refund: {{refundOutcomeNote}} tells the true story on both outcomes", async () => {
    await sendAdminDuplicateCaptureRefundAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      amountCents: 12345,
      paymentIntentId: "pi_dup_1",
      settledPaymentIntentId: "pi_settled_1",
      operationReference: "op_1",
      errorMessage: null,
      refundFailed: false,
    });

    const data = capturedAdminTemplateData();
    expect(typeof data.refundOutcomeNote).toBe("string");
    expect(String(data.refundOutcomeNote).trim()).not.toBe("");
    const rendered = renderDefaultBody("admin-duplicate-capture-refund", data);
    expect(rendered).toContain(
      "The duplicate charge was automatically refunded in full",
    );

    // The failure arm — the exact claim the pre-#2268 flat body got wrong —
    // must state the refund did NOT complete, and must carry the detail.
    mocks.sendToAdmins.mockClear();
    await sendAdminDuplicateCaptureRefundAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      amountCents: 12345,
      paymentIntentId: "pi_dup_1",
      settledPaymentIntentId: "pi_settled_1",
      operationReference: "op_1",
      errorMessage: "card_declined",
      refundFailed: true,
    });
    const failedData = capturedAdminTemplateData();
    const failedRendered = renderDefaultBody(
      "admin-duplicate-capture-refund",
      failedData,
    );
    expect(failedRendered).toContain("the refund could not complete inline");
    expect(failedRendered).toContain("Failure detail: card_declined");
    expect(failedRendered).not.toContain("refunded in full");
  });

  it("split-guest-portion-cancelled: {{ownBookingNote}} is supplied and renders its reassurance sentence", async () => {
    await sendSplitGuestPortionCancelledEmail({
      bookingId: "booking_1",
      email: "member@example.org",
      firstName: "Alice",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      parentConfirmed: true,
      parentBookingReference: "BK-1234",
    });

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [args] = mocks.sendEmail.mock.calls[0] as [
      { templateName: string; templateData: EmailTemplateData },
    ];
    expect(args.templateName).toBe("split-guest-portion-cancelled");
    expect(typeof args.templateData.ownBookingNote).toBe("string");
    expect(String(args.templateData.ownBookingNote).trim()).not.toBe("");

    const rendered = renderDefaultBody(
      "split-guest-portion-cancelled",
      args.templateData,
    );
    // The confirmed-parent sentence — the promise the pre-#2268 flat body made
    // unconditionally is now only made when it is true.
    expect(rendered).toContain(
      "your own booking is unaffected and remains confirmed",
    );
  });
});

// ---------------------------------------------------------------------------
// #2430 — the bumped notice's way back in, per recipient class.
// ---------------------------------------------------------------------------
describe("#2430 booking-bumped points each recipient class somewhere it can go", () => {
  const BASE_URL = "https://club.example.org";
  const SUPPORT_EMAIL = "club@example.org";
  const SUPPORT_LINE = `If you have any questions, contact the club at ${SUPPORT_EMAIL}.`;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue(undefined);
  });

  async function bumpedTemplateData(
    recipientCanBookOnline: boolean,
  ): Promise<EmailTemplateData> {
    await sendBookingBumpedEmail(
      { bookingId: "booking_1" },
      "someone@example.org",
      "Alice",
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      2,
      null,
      recipientCanBookOnline,
    );
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [args] = mocks.sendEmail.mock.calls[0] as [
      { templateName: string; templateData: EmailTemplateData },
    ];
    expect(args.templateName).toBe("booking-bumped");
    // BASE_URL and SUPPORT_EMAIL are GLOBAL tokens resolved from the club's own
    // configured public URL and support address at render time, which is
    // exactly why the sender supplies only the caption and the path.
    return { ...args.templateData, BASE_URL, SUPPORT_EMAIL };
  }

  it("a club member still gets the members-only booking flow", async () => {
    const rendered = renderDefaultBody(
      "booking-bumped",
      await bumpedTemplateData(true),
    );
    expect(rendered).toContain(
      `

Book Again: ${BASE_URL}/book

${SUPPORT_LINE}

We apologise for the inconvenience.`,
    );
    expect(rendered).not.toContain("Contact the Club");
  });

  it("a non-login contact gets the club contact page instead of a login they cannot complete", async () => {
    const rendered = renderDefaultBody(
      "booking-bumped",
      await bumpedTemplateData(false),
    );
    expect(rendered).toContain(
      `

Contact the Club: ${BASE_URL}/contact

${SUPPORT_LINE}

We apologise for the inconvenience.`,
    );
    expect(rendered).not.toContain("Book Again");
    expect(rendered).not.toContain(`${BASE_URL}/book`);
  });

  // #2430 review: the contact page is a club-authored page and need not host a
  // contact form, so a recipient who cannot sign in must be given an address
  // too. Both classes get the same courtesy line.
  it("names the club's support address for both classes", async () => {
    for (const canBook of [true, false]) {
      mocks.sendEmail.mockClear();
      const rendered = renderDefaultBody(
        "booking-bumped",
        await bumpedTemplateData(canBook),
      );
      expect(rendered).toContain(SUPPORT_LINE);
    }
  });

  it("leaves no dangling caption or bare base URL for either class", async () => {
    for (const canBook of [true, false]) {
      mocks.sendEmail.mockClear();
      const data = await bumpedTemplateData(canBook);
      expect(String(data.rebookLabel).trim()).not.toBe("");
      expect(String(data.rebookPath)).toMatch(/^\/[a-z]/);
      const rendered = renderDefaultBody("booking-bumped", data);
      expect(rendered).not.toMatch(/:\s*$/m);
      expect(rendered).not.toContain("{{");
    }
  });
});
