export const PAYMENT_RECEIVED_STATUS_UNCONFIRMED_CODE =
  "PAYMENT_RECEIVED_STATUS_UNCONFIRMED" as const;

export const PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE =
  "Your card payment was received, but we could not confirm the booking status. Reload the booking and check its payment status before trying any payment again.";

export const PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY = Object.freeze({
  code: PAYMENT_RECEIVED_STATUS_UNCONFIRMED_CODE,
  error: PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE,
  paymentReceived: true as const,
  bookingStatusUnconfirmed: true as const,
});

export function isPaymentReceivedStatusUnconfirmed(
  value: unknown,
): value is typeof PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.code === PAYMENT_RECEIVED_STATUS_UNCONFIRMED_CODE &&
    candidate.paymentReceived === true &&
    candidate.bookingStatusUnconfirmed === true &&
    candidate.finalisationPending !== true
  );
}
