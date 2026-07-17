// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PaymentForm from "@/components/stripe/PaymentForm";

// The Stripe Elements hooks/components are the only external dependency of the
// display logic under test (#1976). Stub them so the form renders headlessly;
// the PaymentElement is irrelevant to the amount display.
vi.mock("@stripe/react-stripe-js", () => ({
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({}),
  useElements: () => ({}),
}));

const noop = () => undefined;

describe("PaymentForm split-vs-non-split amount display (#1976)", () => {
  it("non-split: shows the single 'Total' from amountCents, byte-for-byte unchanged", () => {
    render(
      <PaymentForm
        amountCents={12500}
        returnUrl="http://localhost/return"
        onSuccess={noop}
        onError={noop}
      />,
    );

    expect(screen.getByText("Total: $125.00")).toBeTruthy();
    expect(screen.queryByText(/Charged today/i)).toBeNull();
    expect(screen.queryByText(/closer to your stay/i)).toBeNull();
  });

  it("non-split even with chargedAmountCents present: no deferred portion means the original display", () => {
    render(
      <PaymentForm
        amountCents={12500}
        chargedAmountCents={12500}
        deferredGuestAmountCents={null}
        returnUrl="http://localhost/return"
        onSuccess={noop}
        onError={noop}
      />,
    );

    expect(screen.getByText("Total: $125.00")).toBeTruthy();
    expect(screen.queryByText(/Charged today/i)).toBeNull();
  });

  it("split: headline shows the server-charged member portion, plus the deferred guest line", () => {
    render(
      <PaymentForm
        amountCents={20000} // client full-party total — must NOT be the headline
        chargedAmountCents={12000} // server member-portion intent amount
        deferredGuestAmountCents={8000}
        returnUrl="http://localhost/return"
        onSuccess={noop}
        onError={noop}
      />,
    );

    // Headline is the server figure, not the full party total.
    expect(screen.getByText("Charged today: $120.00")).toBeTruthy();
    expect(screen.queryByText("Total: $200.00")).toBeNull();
    expect(screen.queryByText("$200.00")).toBeNull();

    // Deferred guest portion is surfaced as a secondary line.
    const deferred = screen.getByText(/closer to your stay/i);
    expect(deferred.textContent).toContain("$80.00");
  });
});
