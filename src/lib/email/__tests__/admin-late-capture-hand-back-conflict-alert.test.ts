import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2774 D2 pinned AT THE SENDER, for the reason its #2761 sibling has its own
 * file: the webhook test mocks this sender away, so without this nothing anywhere
 * imports the real one and its subject, template name, audience and tokens would
 * all be unasserted.
 *
 * WHAT THIS ALERT IS FOR. Either the automatic late-capture refund was WITHHELD
 * because an operator had already handed the same capture back by hand — the fence,
 * which stops the club paying a member twice — or it went out anyway because that
 * hand-completion committed inside the webhook's own Stripe round trip, in which
 * case the member probably HAS been paid twice. Both directions need a person; the
 * direction decides which way they reconcile.
 *
 * MUTATION PROOF. Route this sender through `sendToAdmins` and "never goes through
 * the muteable preference path" fails. Collapse the two subjects into one and the
 * two subject tests fail. Reuse `admin-late-capture-auto-refund` as the template
 * name and "sends its OWN registry template" fails — and that is the assertion
 * that matters most here, because that template's body says the money went back
 * and there is nothing to pay back, which is false in both of this alert's
 * directions. Drop the `{{handBackConflictNote}}` supply line and "supplies the
 * one sentence that says which way the money went" fails.
 */

const mocks = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  sendUnmuteableAdminAlert: vi.fn(),
}));

vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: mocks.sendToAdmins,
  sendUnmuteableAdminAlert: mocks.sendUnmuteableAdminAlert,
}));

import { sendAdminLateCaptureHandBackConflictAlert } from "@/lib/email/admin-alerts-finance";

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

async function send(options: {
  refundSent: boolean;
  captureKind?: "modification" | "primary";
  handBackAmountCents?: number | null;
}) {
  await sendAdminLateCaptureHandBackConflictAlert({
    memberName: "Alice Example",
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    amountCents: 2500,
    paymentIntentId: "pi_additional_late",
    bookingId: "booking-9",
    bookingDeleted: true,
    captureKind: options.captureKind ?? "modification",
    handBackAmountCents:
      options.handBackAmountCents === undefined
        ? 2500
        : options.handBackAmountCents,
    refundSent: options.refundSent,
  });
  return captured();
}

describe("sendAdminLateCaptureHandBackConflictAlert (#2774)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendToAdmins.mockResolvedValue(undefined);
    mocks.sendUnmuteableAdminAlert.mockResolvedValue(undefined);
  });

  it("never goes through the muteable preference path", async () => {
    // If anything, the case for locking this one is stronger than for its
    // sibling: it is the only mail on the path that says money may have left the
    // club twice.
    await send({ refundSent: false });
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
  });

  it("says the refund was withheld, and never claims one was made", async () => {
    const alert = await send({ refundSent: false });
    expect(alert.subject).toContain("Automatic refund withheld");
    expect(alert.subject).toContain("already paid back by hand");
    expect(alert.subject).toContain("Alice Example");
    expect(alert.subject).not.toContain("refunded automatically");
    expect(alert.subject).not.toContain("Payment Failed");
    // The body must not read as a completed refund either.
    expect(alert.html).toContain("was NOT sent");
    expect(alert.html).not.toContain("there is nothing to pay back");
  });

  it("says the money may have gone TWICE on the other direction", async () => {
    const alert = await send({ refundSent: true });
    expect(alert.subject).toContain("refunded TWICE");
    expect(alert.subject).toContain("reconcile");
    expect(alert.subject).not.toContain("withheld");
    expect(alert.html).toContain("may have gone back TWICE");
  });

  it("sends its OWN registry template, not the auto-refund one", async () => {
    /*
      The load-bearing assertion. `admin-late-capture-auto-refund`'s heading is
      "Payment Refunded Automatically" and its body says the money has gone back
      and there is nothing to pay back — false on the withheld arm, and the
      opposite of the truth on the double-payment arm. Sharing the key would also
      mean ONE admin-editable body having to be correct about a refund that
      happened and one that did not.
    */
    const alert = await send({ refundSent: false });
    expect(alert.templateName).toBe("admin-late-capture-hand-back-conflict");
  });

  it("addresses the alert to the people who reconcile the club's money", async () => {
    const alert = await send({ refundSent: true });
    expect(alert.requirement).toEqual({ area: "finance", level: "edit" });
  });

  it("supplies the one sentence that says which way the money went", async () => {
    const withheld = await send({ refundSent: false });
    expect(String(withheld.templateData.handBackConflictNote)).toContain(
      "has NOT been sent back a second time",
    );

    mocks.sendUnmuteableAdminAlert.mockClear();
    const sent = await send({ refundSent: true });
    expect(String(sent.templateData.handBackConflictNote)).toContain(
      "may have gone back TWICE",
    );
    // Two genuinely different sentences, so a saved default cannot tell an
    // operator the opposite of what happened.
    expect(String(sent.templateData.handBackConflictNote)).not.toBe(
      String(withheld.templateData.handBackConflictNote),
    );
  });

  it("names which payment was captured, on both capture kinds (#2773)", async () => {
    const modification = await send({
      refundSent: false,
      captureKind: "modification",
    });
    expect(modification.html).toContain("booking-change payment");

    mocks.sendUnmuteableAdminAlert.mockClear();
    const primary = await send({ refundSent: false, captureKind: "primary" });
    expect(primary.html).toContain("The booking's own payment");
    expect(primary.html).not.toContain("booking-change payment");
  });

  it("prints the hand-back amount when it is known, and omits the row when it is not", async () => {
    // So a person can see whether the hand-back covered the whole capture.
    // Nothing here refunds a difference: that is a new money decision.
    const known = await send({ refundSent: false, handBackAmountCents: 1500 });
    expect(known.html).toContain("Recorded as paid back by hand");
    expect(known.html).toContain("$15.00");

    mocks.sendUnmuteableAdminAlert.mockClear();
    const unknown = await send({
      refundSent: true,
      handBackAmountCents: null,
    });
    expect(unknown.html).not.toContain("Recorded as paid back by hand");
    // The identifiers that let somebody find the row are still there.
    expect(unknown.templateData.bookingId).toBe("booking-9");
    expect(unknown.templateData.paymentIntentId).toBe("pi_additional_late");
  });

  it("states in the body whether the automatic refund went out", async () => {
    // A reader must not have to infer it from the heading alone.
    const withheld = await send({ refundSent: false });
    expect(withheld.html).toContain("Automatic refund sent");
    expect(withheld.html).toContain(">No<");

    mocks.sendUnmuteableAdminAlert.mockClear();
    const sent = await send({ refundSent: true });
    expect(sent.html).toContain("Yes — on top of the hand-back");
  });
});
