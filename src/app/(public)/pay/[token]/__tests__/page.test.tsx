// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PayByLinkPage from "../page";
import {
  EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
} from "@/lib/payment-recovery-contract";

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "public-token" }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeName: "Test Lodge" }),
}));

vi.mock("@/components/stripe/StripeProvider", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/stripe/PaymentForm", () => ({
  default: () => <div>card-entry-form</div>,
}));

const payableContext = {
  state: "payable",
  narrative: {
    state: "payable",
    headline: "Payment due",
    message: "Payment is due.",
    nextStep: "Pay now.",
  },
  firstName: "Riley",
  payable: {
    checkIn: "2026-09-01T00:00:00.000Z",
    checkOut: "2026-09-03T00:00:00.000Z",
    guestCount: 1,
    status: "CONFIRMED",
    amountCents: 12500,
    internetBankingReference: "BOOK-123",
    expiresAt: "2026-09-10T00:00:00.000Z",
  },
  canRequestFreshLink: false,
};

function installFetch(recoveryBody: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/pay/public-token" && !init?.method) {
        return {
          ok: true,
          json: async () => payableContext,
        } as Response;
      }
      if (url === "/api/booking-messages") {
        return {
          ok: true,
          json: async () => ({ messages: {} }),
        } as Response;
      }
      if (
        url === "/api/pay/public-token/payment-intent" &&
        init?.method === "POST"
      ) {
        return {
          ok: false,
          status: 409,
          json: async () => recoveryBody,
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch,
  );
}

describe("public payment-link captured-payment recovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it.each([
    {
      name: "participant finalisation",
      body: {
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        error: "private participant detail",
        paymentReceived: true,
        finalisationPending: true,
      },
      heading: "Payment received - finalisation pending",
      message: /card payment was received, but booking finalisation is still pending/i,
    },
    {
      name: "ordinary post-capture status",
      body: {
        ...PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
        error: "private database detail",
      },
      heading: "Payment received - check booking status",
      message: /could not confirm the booking status/i,
    },
    {
      name: "unclassified existing transaction",
      body: {
        ...EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
        error: "private ledger detail",
      },
      heading: "Card transaction found - check payment status",
      message: /could not confirm whether it is still paid or has been refunded/i,
    },
  ])(
    "suppresses every payment action for $name recovery",
    async ({ body, heading, message }) => {
      installFetch(body);
      render(<PayByLinkPage />);

      fireEvent.click(await screen.findByRole("button", { name: "Pay by card" }));

      const alert = document.getElementById("payment-link-recovery-error");
      await waitFor(() => expect(alert).toHaveTextContent(heading));
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent("private");
      expect(
        screen.queryByRole("button", { name: "Pay by card" }),
      ).toBeNull();
      expect(screen.queryByText("Or pay by internet banking")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Reload payment status" }),
      ).not.toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(alert));
    },
  );
});
