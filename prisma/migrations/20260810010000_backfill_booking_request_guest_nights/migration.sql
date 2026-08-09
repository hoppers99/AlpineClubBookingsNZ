-- #2739: backfill BookingGuestNight rows for guests on bookings that came from a
-- BOOKING REQUEST — the exact population the #1098 backfill
-- (20260704150000_backfill_booking_guest_nights) excluded.
--
-- WHY THE EXCLUSION IS BEING REVERSED, since #1098 recorded a reason for it.
-- #1098's reason was about PRICE and only about price: "the #1032 edit block
-- already protects their negotiated prices, and their per-guest flat splits are
-- not per-night rates", and its own issue said these bookings "can be skipped or
-- included deliberately". Its purpose was the #1036 nightly price lock, which
-- these bookings did not need. Nothing recorded says a booking-request booking is
-- meant to be ALLOCATED differently — and BookingGuestNight is not only a price
-- record, it is the canonical night set the whole bed-allocation surface reads
-- (INV-CAP-032). With no rows, these guests are invisible to it: not listed on
-- the board, not placed by the planner, not counted as awaiting a bed, while
-- being real people on a confirmed booking who turn up at the lodge.
--
-- MONEY DOES NOT MOVE. The nights sum to the guest's stored priceCents exactly,
-- integer cents, one extra cent on each of the earliest `remainder` nights. That
-- is `evenlySplitCents` in src/lib/xero-booking-invoices.ts — the vector that file
-- ALREADY synthesises for a guest carrying no night rows and bills from — so a
-- backfilled booking's Xero line items stay byte-identical and a later
-- invoice-update diff finds nothing to push. #1098's own rule (the whole
-- remainder on the FIRST night, borrowed from splitPriceAcrossGuests, which
-- splits across GUESTS) totals the same but splits into different lines, which on
-- an already-raised invoice would read as a change. This migration deliberately
-- does NOT reprice anything: it reads the stored total and divides it.
--
-- Floor division rather than PostgreSQL's truncating `/`, so the split matches
-- `Math.floor` in buildApprovalGuestNights for every sign and the remainder is
-- always in [0, night_count).
--
-- Idempotent: only guests with ZERO existing rows are touched, and the unique
-- (bookingGuestId, stayDate) constraint plus ON CONFLICT DO NOTHING make a replay
-- insert nothing. Cancelled/bumped and soft-deleted bookings are skipped, exactly
-- as #1098 skipped them.
--
-- OPERATOR NOTE — RE-RUN THIS AFTER CUTOVER. `prisma migrate deploy` runs at step
-- 13 of docs/PRODUCTION_UPGRADE_RUNBOOK.md, BEFORE cutover, so the old colour is
-- still taking booking-request approvals and quote holds while this runs. Every
-- one of those is written by pre-#2739 code, gets no night rows, and is already
-- behind this one-shot INSERT — leaving exactly the invisible-guest state the
-- release claims to have closed. Running the statement again verbatim after
-- cutover picks those up and inserts nothing anywhere it already ran.
--
-- Two more consequences of that same window, stated so they are decisions rather
-- than surprises:
--   * THIS IS NOT REVERSIBLE BY ABORTING THE CUTOVER. A data write survives a
--     rollback of the code; there is no rollback.sql and none is required by the
--     gates (this migration is not `windowed`), so an aborted release keeps the
--     rows. They are harmless — they describe the stay the guest already had —
--     but they do not go away.
--   * The old colour's in-place held-booking reassignment (reassignHeldBookingGuests)
--     overwrites stayStart/stayEnd/priceCents WITHOUT rewriting night rows; the
--     rewrite is part of this release. Harmless while these guests have no rows,
--     which is why the exposure is created by this backfill: a quote accepted
--     between `migrate` and cutover at a different option than the hold was taken
--     at leaves rows describing the hold's dates and total, and
--     buildInvoiceLineItems prefers stored rows over the guest's flat priceCents.
--     Remedy: re-raise or refresh the invoice for any request approved in the
--     window, or take the deploy with quoting paused.
INSERT INTO "BookingGuestNight" ("id", "bookingGuestId", "stayDate", "priceCents")
SELECT
  gen_random_uuid()::text,
  g."id",
  night.d::date,
  CASE
    WHEN (night.d::date - g."stayStart"::date)
           < (g."priceCents" - split.base * n.night_count)
      THEN split.base + 1
    ELSE split.base
  END
FROM "BookingGuest" g
JOIN "Booking" b ON b."id" = g."bookingId"
CROSS JOIN LATERAL (
  SELECT (g."stayEnd" - g."stayStart")::int AS night_count
) n
CROSS JOIN LATERAL (
  -- NULLIF so a zero-night envelope yields NULL rather than raising: a lateral
  -- in the FROM list is not guaranteed to be evaluated after the WHERE clause
  -- that filters those rows out, and a division-by-zero here would abort the
  -- whole migration over a guest whose row the backfill never wanted anyway.
  SELECT floor(g."priceCents"::numeric / NULLIF(n.night_count, 0))::int AS base
) split
CROSS JOIN LATERAL generate_series(
  g."stayStart"::timestamp,
  (g."stayEnd" - INTERVAL '1 day')::timestamp,
  INTERVAL '1 day'
) AS night(d)
WHERE n.night_count > 0
  AND b."deletedAt" IS NULL
  AND b."status" NOT IN ('CANCELLED', 'BUMPED')
  AND NOT EXISTS (
    SELECT 1
    FROM "BookingGuestNight" existing
    WHERE existing."bookingGuestId" = g."id"
  )
  AND EXISTS (
    SELECT 1
    FROM "BookingRequest" r
    WHERE r."convertedBookingId" = b."id"
       OR r."heldBookingId" = b."id"
  )
ON CONFLICT ("bookingGuestId", "stayDate") DO NOTHING;
