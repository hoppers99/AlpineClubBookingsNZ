import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { BookingAdditionalPaymentPanel } from "@/components/admin/booking-additional-payment-panel";

/**
 * The admin-side view of an uncollected additional payment (#2350).
 *
 * The member-facing card is owner-only by design (#1303), which is exactly why
 * this panel exists — but it must not become a second way to reach the member's
 * payment controls. These tests pin what it says, what it never offers, and who
 * gets the re-send button.
 */

const NOW = new Date("2026-06-11T00:00:00.000Z");
const RAISED_AT = new Date("2026-06-01T00:00:00.000Z");

function payment(overrides: Record<string, unknown> = {}) {
  return {
    additionalAmountCents: 21_000,
    additionalPaymentStatus: "PENDING",
    additionalReminderSentAt: null,
    additionalFinalReminderSentAt: null,
    ...overrides,
  } as Parameters<typeof BookingAdditionalPaymentPanel>[0]["payment"];
}

function render(props: Partial<Parameters<typeof BookingAdditionalPaymentPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <BookingAdditionalPaymentPanel
      bookingId="booking-1"
      payment={payment()}
      requestedOn={RAISED_AT}
      canResend
      now={NOW}
      {...props}
    />,
  );
}

describe("BookingAdditionalPaymentPanel", () => {
  it("names the amount, its age, and that it is still awaiting payment", () => {
    const html = render();

    expect(html).toContain("Additional payment outstanding");
    expect(html).toContain("$210.00");
    expect(html).toContain("Awaiting payment");
    expect(html).toContain("10 days ago");
    expect(html).toContain("Not yet");
  });

  it("says plainly when the last charge attempt failed", () => {
    const html = render({
      payment: payment({ additionalPaymentStatus: "FAILED" }),
    });

    expect(html).toContain("Payment failed");
    expect(html).toContain("failed");
  });

  it("reports when the member was last emailed, newest stamp wins", () => {
    const html = render({
      payment: payment({
        additionalReminderSentAt: new Date("2026-06-04T00:00:00.000Z"),
        additionalFinalReminderSentAt: new Date("2026-06-09T00:00:00.000Z"),
      }),
    });

    expect(html).not.toContain("Not yet");
    expect(html).toContain("9/06/2026");
  });

  it("renders nothing at all once the extra has been collected", () => {
    expect(
      render({ payment: payment({ additionalPaymentStatus: "SUCCEEDED" }) }),
    ).toBe("");
    expect(render({ payment: payment({ additionalAmountCents: 0 }) })).toBe("");
    expect(render({ payment: null })).toBe("");
  });

  it("offers the re-send only to an admin who may write", () => {
    expect(render({ canResend: true })).toContain(
      "Resend payment request email",
    );

    const viewOnly = render({ canResend: false });
    expect(viewOnly).not.toContain("Resend payment request email");
    // The reason is stated in prose, in reading order, rather than hidden on a
    // disabled control.
    expect(viewOnly).toContain("cannot make changes");
  });

  /*
    The panel is read-only on purpose: an admin must never be able to take,
    waive, or zero the member's money from here. Collecting it stays with the
    member's own card or the ordinary modification tooling.
  */
  it("offers no way to take or waive the payment", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/admin/booking-additional-payment-panel.tsx",
      ),
      "utf8",
    );

    // Imports only — the prose above deliberately NAMES the member card it is
    // the counterpart to, so a raw substring scan would police the comment.
    const imports = source
      .split(/\r?\n/)
      .filter((line) => line.startsWith("import "))
      .join(" ");
    for (const forbidden of [
      "BookingPaymentSection",
      "additional-payment-card",
      "stripe",
      "Stripe",
    ]) {
      expect(imports).not.toContain(forbidden);
    }
    // And nothing rendered takes input or posts anywhere: the only interactive
    // element the panel can produce is the re-send button.
    const html = render();
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(html).toContain("Resend payment request email");
  });
});
