import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The #2761 decision, pinned AT THE SENDER.
 *
 * WHY THIS FILE EXISTS. A review of #2761 mutation-proved that reverting BOTH
 * halves of the owner's decision — putting `sendAdminLateCaptureAutoRefundAlert`
 * back on the muteable `sendToAdmins({ preferenceKey: "adminPaymentFailure" })`
 * with a generic "Payment Failed" subject — passed every test in the branch. The
 * audience test exercises the shared `sendUnmuteableAdminAlert` with its subject
 * and template name hand-written as literals, and the webhook test mocks this
 * sender away entirely, so nothing anywhere imported the real one. Its subject
 * text, its template name, its audience requirement and the fact that it supplies
 * the population tokens at all were all unasserted.
 *
 * MUTATION PROOF. Route this sender through `sendToAdmins` and "never goes through
 * the muteable preference path" fails. Restore the generic "Payment Failed"
 * subject and both subject tests fail. Change the template name and the registry
 * would still be green — the assertion below is what catches it. Widen or narrow
 * the audience requirement away from `finance: edit` and "addresses the alert to
 * the people who reconcile the club's money" fails. Drop either population token
 * and the token assertions fail.
 */

const mocks = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  sendUnmuteableAdminAlert: vi.fn(),
}));

vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: mocks.sendToAdmins,
  sendUnmuteableAdminAlert: mocks.sendUnmuteableAdminAlert,
}));

import { sendAdminLateCaptureAutoRefundAlert } from "@/lib/email/admin-alerts-finance";

type CapturedAlert = {
  subject: string;
  html: string;
  templateName: string;
  templateData: Record<string, unknown>;
  requirement: { area: string; level: string };
};

function captured(): CapturedAlert {
  expect(mocks.sendUnmuteableAdminAlert).toHaveBeenCalledTimes(1);
  const [args] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [CapturedAlert];
  return args;
}

async function send(bookingDeleted: boolean) {
  await sendAdminLateCaptureAutoRefundAlert({
    memberName: "Alice Example",
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    amountCents: 2500,
    paymentIntentId: "pi_additional_late",
    bookingId: "booking-9",
    bookingDeleted,
  });
  return captured();
}

describe("sendAdminLateCaptureAutoRefundAlert (#2761)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendToAdmins.mockResolvedValue(undefined);
    mocks.sendUnmuteableAdminAlert.mockResolvedValue(undefined);
  });

  it("never goes through the muteable preference path", async () => {
    // The two mute vectors the owner's decision closes are the per-member
    // `adminPaymentFailure` checkbox and the club-wide delivery mode, and both
    // live behind `sendToAdmins`. Reaching it at all reopens them.
    await send(true);
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
  });

  it("says what happened rather than 'Payment Failed', and names the deleted population", async () => {
    const alert = await send(true);
    expect(alert.subject).toContain("Payment refunded automatically");
    expect(alert.subject).toContain("already deleted");
    expect(alert.subject).toContain("Alice Example");
    expect(alert.subject).not.toContain("Payment Failed");
  });

  it("names the merely-cancelled population instead when the booking is still on file", async () => {
    const alert = await send(false);
    expect(alert.subject).toContain("Payment refunded automatically");
    expect(alert.subject).toContain("already cancelled");
    expect(alert.subject).not.toContain("already deleted");
    expect(alert.subject).not.toContain("Payment Failed");
  });

  it("sends its OWN registry template, not a variant of admin-payment-failure", async () => {
    // Sharing the key would let an admin's override of the routine
    // payment-failure wording rewrite this notice and put both under one
    // delivery switch.
    const alert = await send(true);
    expect(alert.templateName).toBe("admin-late-capture-auto-refund");
  });

  it("addresses the alert to the people who reconcile the club's money", async () => {
    // The audience rule is unchanged from what `adminPaymentFailure` masked on,
    // so making the alert unmuteable widened nobody's reach.
    const alert = await send(true);
    expect(alert.requirement).toEqual({ area: "finance", level: "edit" });
  });

  it("supplies both population tokens, so an override cannot lose the distinction", async () => {
    const deleted = await send(true);
    expect(deleted.templateData.bookingStateLabel).toBe("already deleted");
    expect(String(deleted.templateData.refundOutcomeNote)).toContain("DELETED");

    mocks.sendUnmuteableAdminAlert.mockClear();
    const cancelled = await send(false);
    expect(cancelled.templateData.bookingStateLabel).toBe("already cancelled");
    expect(String(cancelled.templateData.refundOutcomeNote)).not.toContain(
      "DELETED",
    );
    // The same sentence the hand-built HTML renders, so a saved default cannot
    // describe a different population from the mail.
    expect(String(cancelled.templateData.refundOutcomeNote)).not.toBe(
      String(deleted.templateData.refundOutcomeNote),
    );
  });

  it("carries the identifiers an operator needs to find the money", async () => {
    const alert = await send(true);
    expect(alert.templateData.bookingId).toBe("booking-9");
    expect(alert.templateData.paymentIntentId).toBe("pi_additional_late");
    expect(alert.html).toContain("pi_additional_late");
  });
});
