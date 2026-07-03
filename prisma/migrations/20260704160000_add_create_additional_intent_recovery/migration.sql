-- #1096: durable retry for additional PaymentIntent creation. When a booking
-- edit increases the price on a Stripe booking and the post-transaction intent
-- creation fails transiently, a recovery operation of this type re-creates it
-- with the modification-scoped Stripe idempotency key.
ALTER TYPE "PaymentRecoveryOperationType" ADD VALUE 'CREATE_ADDITIONAL_PAYMENT_INTENT';
