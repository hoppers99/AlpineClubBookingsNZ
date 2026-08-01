-- #2362: a failed concrete-booking email must re-check current recipient
-- authority before retrying its retained HTML. Email addresses are not proof of
-- booking access, so persist the member identity used by the authority check.
--
-- All columns are nullable for blue/green compatibility. Existing rows keep a
-- NULL override flag and are retired fail-closed by the new retry worker rather
-- than replayed with unknowable authority. New public/aggregate rows have a
-- non-NULL override flag and a NULL recipient member id, which explicitly means
-- "no authenticated booking-detail link". The included-link bit lets a later
-- retry fail closed if deployment URL drift prevents locating the retained href.
ALTER TABLE "EmailLog"
  ADD COLUMN "bookingRecipientMemberId" TEXT,
  ADD COLUMN "bookingBodyOverrideApplied" BOOLEAN,
  ADD COLUMN "bookingDetailLinkIncluded" BOOLEAN;
