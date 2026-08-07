import { describe, expect, it } from "vitest";
import {
  EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
  isExistingCardTransactionStatusUnconfirmed,
  isPaymentReceivedFinalisationPending,
  isPaymentReceivedStatusUnconfirmed,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
} from "@/lib/payment-recovery-contract";

describe("ordinary post-capture payment recovery contract", () => {
  it("recognises only the two positive captured-and-pending facts", () => {
    expect(
      isPaymentReceivedFinalisationPending({
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        paymentReceived: true,
        finalisationPending: true,
      }),
    ).toBe(true);
    expect(
      isPaymentReceivedFinalisationPending({
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        paymentReceived: true,
      }),
    ).toBe(false);
    expect(
      isPaymentReceivedFinalisationPending({
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        finalisationPending: true,
      }),
    ).toBe(false);
  });

  it("accepts only the exact status-unconfirmed marker", () => {
    expect(
      isPaymentReceivedStatusUnconfirmed(
        PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
      ),
    ).toBe(true);
    expect(
      isPaymentReceivedStatusUnconfirmed({
        ...PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
        bookingStatusUnconfirmed: false,
      }),
    ).toBe(false);
    expect(
      isPaymentReceivedStatusUnconfirmed({
        ...PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
        finalisationPending: true,
      }),
    ).toBe(false);
  });

  it("does not expose an intent id or claim finalisation is pending", () => {
    expect(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY).not.toHaveProperty(
      "paymentIntentId",
    );
    expect(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY).not.toHaveProperty(
      "finalisationPending",
    );
  });

  it("keeps succeeded-observed recovery separate from payment-received claims", () => {
    expect(
      isExistingCardTransactionStatusUnconfirmed(
        EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
      ),
    ).toBe(true);
    expect(EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY).not.toHaveProperty(
      "paymentReceived",
    );
    expect(
      isExistingCardTransactionStatusUnconfirmed({
        ...EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
        paymentReceived: true,
      }),
    ).toBe(false);
  });
});
