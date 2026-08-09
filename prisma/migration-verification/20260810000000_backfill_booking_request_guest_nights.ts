import type { DataMigrationVerification } from "./types";

/**
 * #2739 — the backfill that gives booking-request bookings the canonical night
 * set every other booking already has.
 *
 * WHY THIS FIXTURE EARNS ITS KEEP. `Migration drift check` applies this file to
 * an EMPTY database, where an `INSERT ... SELECT` over `BookingGuest` selects
 * nothing: it is proven to parse and proven to do nothing. Every property that
 * matters here is a property of real rows.
 *
 * Two of those properties are load-bearing beyond the feature. The first is the
 * POPULATION: this migration is the exact complement of #1098's
 * (`20260704150000_backfill_booking_guest_nights`), which wrote rows for
 * everything EXCEPT bookings reachable from a `BookingRequest`. A predicate
 * flipped the wrong way here would either leave the whole defect in place or
 * start writing rows over a population #1098 already handled. The second is the
 * SPLIT: the per-night cents must sum to the guest's stored `priceCents`, with
 * the extra cent on the EARLIEST nights, because that is the vector
 * `evenlySplitCents` in `src/lib/xero-booking-invoices.ts` already synthesises
 * for a night-less guest and bills from. Get it wrong and a backfilled booking's
 * next invoice-update diff reads as a change to push to Xero — real money
 * movement produced by a migration that was only supposed to make guests
 * visible on the bed board.
 *
 * Cases seed their own rows: the migration chain leaves `Booking`,
 * `BookingGuest` and `BookingRequest` empty, and `Lodge` already holds the
 * default row that `Booking.lodgeId`'s `default_lodge_id()` resolves to.
 */
const OWNER_SEED = `
  INSERT INTO "Member" ("id", "email", "passwordHash", "firstName", "lastName", "updatedAt")
  VALUES ('mem-2739', 'requester-2739@example.test', 'x', 'Ada', 'Requester',
          TIMESTAMP '2026-01-01 00:00:00');
`;

/**
 * One booking, one request pointing at it, and guests with no night rows — the
 * shape every booking-request approval left behind before #2739.
 */
function convertedBooking(options: {
  bookingId: string;
  requestId: string;
  status: string;
  /** `convertedBookingId` (an approved request) or `heldBookingId` (a live hold). */
  link: "convertedBookingId" | "heldBookingId";
  deleted?: boolean;
  guests: { id: string; priceCents: number }[];
}): string {
  const deletedAt = options.deleted ? "TIMESTAMP '2026-06-01 00:00:00'" : "NULL";
  const guestRows = options.guests
    .map(
      (guest) => `
      ('${guest.id}', '${options.bookingId}', 'Guest', '${guest.id}', 'ADULT',
       DATE '2026-09-01', DATE '2026-09-04', ${guest.priceCents})`,
    )
    .join(",");
  return `
    INSERT INTO "Booking"
      ("id", "memberId", "checkIn", "checkOut", "status", "totalPriceCents",
       "finalPriceCents", "deletedAt", "updatedAt")
    VALUES ('${options.bookingId}', 'mem-2739', DATE '2026-09-01', DATE '2026-09-04',
            '${options.status}', 10001, 10001, ${deletedAt},
            TIMESTAMP '2026-01-01 00:00:00');

    INSERT INTO "BookingGuest"
      ("id", "bookingId", "firstName", "lastName", "ageTier", "stayStart", "stayEnd", "priceCents")
    VALUES ${guestRows};

    INSERT INTO "BookingRequest"
      ("id", "contactFirstName", "contactLastName", "contactEmail", "checkIn",
       "checkOut", "guests", "${options.link}", "updatedAt")
    VALUES ('${options.requestId}', 'Ada', 'Requester', 'requester-2739@example.test',
            DATE '2026-09-01', DATE '2026-09-04', '[]'::jsonb, '${options.bookingId}',
            TIMESTAMP '2026-01-01 00:00:00');
  `;
}

/** Every night row in the database, guest by guest, date by date. */
const ALL_NIGHTS_SQL = `
  SELECT n."bookingGuestId" AS "guest",
         to_char(n."stayDate", 'YYYY-MM-DD') AS "night",
         n."priceCents" AS "priceCents"
    FROM "BookingGuestNight" n
   ORDER BY n."bookingGuestId", n."stayDate"
`;

const verification: DataMigrationVerification = {
  migration: "20260810000000_backfill_booking_request_guest_nights",
  intent:
    "Give every guest on a live booking that came from a booking request the canonical BookingGuestNight set they were created without, over the guest's own stayStart..stayEnd envelope, with the stored price split across those nights to the exact cent — and touch nothing else: no guest that already has rows, no cancelled or soft-deleted booking, and no booking that never came from a request.",
  // A pure INSERT ... SELECT guarded by NOT EXISTS and ON CONFLICT DO NOTHING:
  // running the whole file again inserts nothing.
  idempotentReRun: true,
  cases: [
    {
      name: "a club with two guests on an approved public booking request, neither carrying a night row",
      seed: `
        ${OWNER_SEED}
        ${convertedBooking({
          bookingId: "bk-converted",
          requestId: "req-converted",
          status: "PENDING",
          link: "convertedBookingId",
          guests: [
            { id: "g-uneven", priceCents: 10001 },
            { id: "g-exact", priceCents: 9000 },
          ],
        })}
      `,
      expectations: [
        {
          claim:
            "each guest gets one row per night of the half-open [checkIn, checkOut) envelope — three nights for a 1 Sep to 4 Sep stay, and NOT a fourth on the check-out morning, which is a departure and not a night anybody holds a bed for",
          sql: ALL_NIGHTS_SQL,
          rows: [
            { guest: "g-exact", night: "2026-09-01", priceCents: 3000 },
            { guest: "g-exact", night: "2026-09-02", priceCents: 3000 },
            { guest: "g-exact", night: "2026-09-03", priceCents: 3000 },
            { guest: "g-uneven", night: "2026-09-01", priceCents: 3334 },
            { guest: "g-uneven", night: "2026-09-02", priceCents: 3334 },
            { guest: "g-uneven", night: "2026-09-03", priceCents: 3333 },
          ],
        },
        {
          claim:
            "the nights sum to each guest's stored price EXACTLY — 10001c over three nights is 3334/3334/3333, the extra cents on the earliest nights, which is the vector Xero line building already bills these bookings from. No money is created, destroyed or moved by this migration.",
          sql: `
            SELECT g."id" AS "guest",
                   g."priceCents" AS "guestPriceCents",
                   sum(n."priceCents")::int AS "nightsTotal"
              FROM "BookingGuest" g
              JOIN "BookingGuestNight" n ON n."bookingGuestId" = g."id"
             GROUP BY g."id", g."priceCents"
             ORDER BY g."id"
          `,
          rows: [
            { guest: "g-exact", guestPriceCents: 9000, nightsTotal: 9000 },
            { guest: "g-uneven", guestPriceCents: 10001, nightsTotal: 10001 },
          ],
        },
      ],
    },
    {
      name: "a guest whose night rows were only partly written, on an otherwise identical booking",
      seed: `
        ${OWNER_SEED}
        ${convertedBooking({
          bookingId: "bk-converted",
          requestId: "req-converted",
          status: "CONFIRMED",
          link: "convertedBookingId",
          guests: [{ id: "g-partial", priceCents: 10001 }],
        })}
        INSERT INTO "BookingGuestNight" ("id", "bookingGuestId", "stayDate", "priceCents")
        VALUES ('bgn-existing', 'g-partial', DATE '2026-09-01', 4200);
      `,
      expectations: [
        {
          claim:
            "a guest that already has ANY night row is left completely alone — the one stored row keeps its 4200c, and the two nights it does not cover are NOT filled in. The guard is per guest, not per night, deliberately: a partial set is somebody's edit, and half-completing it would invent prices beside prices a person chose.",
          sql: ALL_NIGHTS_SQL,
          rows: [
            { guest: "g-partial", night: "2026-09-01", priceCents: 4200 },
          ],
        },
      ],
    },
    {
      name: "a club whose request bookings are cancelled, bumped or in the recycle bin",
      seed: `
        ${OWNER_SEED}
        ${convertedBooking({
          bookingId: "bk-cancelled",
          requestId: "req-cancelled",
          status: "CANCELLED",
          link: "convertedBookingId",
          guests: [{ id: "g-cancelled", priceCents: 10001 }],
        })}
        ${convertedBooking({
          bookingId: "bk-bumped",
          requestId: "req-bumped",
          status: "BUMPED",
          link: "convertedBookingId",
          guests: [{ id: "g-bumped", priceCents: 10001 }],
        })}
        ${convertedBooking({
          bookingId: "bk-deleted",
          requestId: "req-deleted",
          status: "CONFIRMED",
          link: "convertedBookingId",
          deleted: true,
          guests: [{ id: "g-deleted", priceCents: 10001 }],
        })}
      `,
      expectations: [
        {
          claim:
            "not one row is written: a cancelled, bumped or soft-deleted booking holds no beds, so giving it a night set would put departed parties back on the bed board and its cents into the revenue reconciliation",
          sql: ALL_NIGHTS_SQL,
          rows: [],
        },
      ],
    },
    {
      name: "a club with an ordinary night-less booking that never came from a request",
      seed: `
        ${OWNER_SEED}
        INSERT INTO "Booking"
          ("id", "memberId", "checkIn", "checkOut", "status", "totalPriceCents",
           "finalPriceCents", "updatedAt")
        VALUES ('bk-direct', 'mem-2739', DATE '2026-09-01', DATE '2026-09-04',
                'CONFIRMED', 10001, 10001, TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "BookingGuest"
          ("id", "bookingId", "firstName", "lastName", "ageTier", "stayStart", "stayEnd", "priceCents")
        VALUES ('g-direct', 'bk-direct', 'Guest', 'Direct', 'ADULT',
                DATE '2026-09-01', DATE '2026-09-04', 10001);
      `,
      expectations: [
        {
          claim:
            "untouched — this migration is the exact complement of #1098's and owns only the population #1098 excluded. A direct booking still carrying no rows is #1098's business (it ran before this guest existed, or the guest is quote-priced by some other route), and writing over it here would make the two migrations overlap with no way to tell which wrote what.",
          sql: ALL_NIGHTS_SQL,
          rows: [],
        },
      ],
    },
    {
      name: "a club with a live capacity hold, linked by heldBookingId rather than convertedBookingId",
      seed: `
        ${OWNER_SEED}
        ${convertedBooking({
          bookingId: "bk-held",
          requestId: "req-held",
          status: "AWAITING_REVIEW",
          link: "heldBookingId",
          guests: [{ id: "g-held", priceCents: 9000 }],
        })}
      `,
      expectations: [
        {
          claim:
            "a hold is backfilled too: AWAITING_REVIEW holds capacity and an officer can already place beds on it, so a hold with no night set is a booking the board shows with nobody on it. #1098 excluded heldBookingId alongside convertedBookingId and this migration reverses both halves.",
          sql: ALL_NIGHTS_SQL,
          rows: [
            { guest: "g-held", night: "2026-09-01", priceCents: 3000 },
            { guest: "g-held", night: "2026-09-02", priceCents: 3000 },
            { guest: "g-held", night: "2026-09-03", priceCents: 3000 },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "flip the population back to #1098's (EXISTS -> NOT EXISTS on the BookingRequest link)",
      harm:
        "The whole defect stays in place — every booking-request booking keeps its empty night set and its guests stay invisible to the bed board — while the migration instead writes rows over the population #1098 already handled, so the two backfills overlap and nobody can tell afterwards which one wrote a given row.",
      find: `  AND EXISTS (
    SELECT 1
    FROM "BookingRequest" r`,
      replace: `  AND NOT EXISTS (
    SELECT 1
    FROM "BookingRequest" r`,
    },
    {
      name: "put the leftover cents on the LAST nights instead of the earliest",
      harm:
        "The per-night vector stops matching the one `evenlySplitCents` synthesises in xero-booking-invoices.ts, so a backfilled booking's next invoice-update diff reads as a changed invoice and pushes different line items to Xero — a migration moving money on live invoices. It also drops a cent on the floor: with three nights and a two-cent remainder only ONE night is topped up, so the guest's nights no longer sum to the guest's price.",
      find: `    WHEN (night.d::date - g."stayStart"::date)
           < (g."priceCents" - split.base * n.night_count)`,
      replace: `    WHEN (night.d::date - g."stayStart"::date)
           >= (g."priceCents" - split.base * n.night_count)`,
    },
    {
      name: "drop the per-guest already-has-rows guard",
      harm:
        "A guest whose night set was written by hand or by an edit is half-overwritten: the nights the stored set does not cover are filled in at a synthesised price, so somebody's chosen prices sit beside invented ones on the same stay, and the guest's nights no longer sum to their price.",
      find: `  AND NOT EXISTS (
    SELECT 1
    FROM "BookingGuestNight" existing
    WHERE existing."bookingGuestId" = g."id"
  )
`,
      replace: "",
    },
    {
      name: "drop the cancelled/bumped filter",
      harm:
        "Cancelled and bumped bookings get a night set, which puts parties that are not coming back onto the bed-allocation board as guests awaiting a bed, and puts their cents into the booking side of the finance revenue reconciliation against invoices that were never raised.",
      find: `  AND b."status" NOT IN ('CANCELLED', 'BUMPED')
`,
      replace: "",
    },
    {
      name: "drop the soft-delete filter",
      harm:
        "A booking an admin sent to the recycle bin comes back onto the bed board and into the revenue reconciliation, from a migration nobody would think to look at when the deleted booking reappears.",
      find: `  AND b."deletedAt" IS NULL
`,
      replace: "",
    },
  ],
};

export default verification;
