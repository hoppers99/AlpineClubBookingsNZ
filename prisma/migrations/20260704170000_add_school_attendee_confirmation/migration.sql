-- #1101: school attendee confirmation. Quoted school bookings are created
-- with placeholder guests; before arrival the school contact confirms who is
-- attending via a tokenized public page (SHA-256 hash stored, raw token
-- emailed, rotated on each reminder).
ALTER TABLE "BookingRequestSettings"
  ADD COLUMN "attendeeConfirmationLeadDays" INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN "attendeeConfirmationReminderDays" INTEGER NOT NULL DEFAULT 3;

ALTER TABLE "BookingRequest"
  ADD COLUMN "attendeeConfirmationTokenHash" TEXT,
  ADD COLUMN "attendeeConfirmationTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "attendeeConfirmationLastSentAt" TIMESTAMP(3),
  ADD COLUMN "attendeesConfirmedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "BookingRequest_attendeeConfirmationTokenHash_key"
  ON "BookingRequest"("attendeeConfirmationTokenHash");
