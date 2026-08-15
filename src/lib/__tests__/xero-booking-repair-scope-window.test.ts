/**
 * The window an operator asks the Xero booking-repair sweep for, against the
 * window it actually binds (#2868, INV-DATE-013).
 *
 * ## What was wrong
 *
 * `--from 2026-07-01 --to 2026-07-31` used to become a single local-midnight
 * `Date` pair, bound unchanged against all four columns the scope `OR` matches.
 * `Booking.checkIn` is `DateTime @db.Date`, and `@prisma/adapter-pg` narrows a
 * bound value against such a column to its UTC calendar date with the time
 * thrown away — so under the deployment's `TZ=Pacific/Auckland` pin, club
 * midnight on 1 July (`2026-06-30T12:00Z`) arrived as the DATE `2026-06-30`.
 * The sweep covered `[30 Jun, 30 Jul]`. A booking checking in on the last day
 * the operator named was outside the repair unless it happened to have been
 * created or updated inside the window.
 *
 * ## The four consumers are not one comparison
 *
 * | arm                                | column type in `prisma/schema.prisma` | bound value |
 * | ---------------------------------- | ------------------------------------- | ----------- |
 * | `Booking.checkIn`                  | `DateTime @db.Date`                   | date-only (`parseDateOnly`) |
 * | `Booking.createdAt`                | `DateTime @default(now())`            | club-day start (`startOfDateOnlyForTimeZone`) |
 * | `Booking.updatedAt`                | `DateTime @updatedAt`                 | club-day start |
 * | `BookingModification.createdAt`    | `DateTime @default(now())`            | club-day start |
 *
 * The two values differ by the club's UTC offset — twelve hours in NZST — and
 * each is wrong in the other's place. Giving the three instants a date-only
 * value would sit their boundary at club MIDDAY, which is the mistake #2838
 * avoided by deliberately keeping `startOfDateOnlyForTimeZone` for
 * `draftExpiresAt`. So this suite asserts BOTH halves; a fix that moves only
 * the date column is half a fix.
 *
 * ## Verified by binding, not by reasoning
 *
 * The real generated Prisma Client, the real query compiler and the real
 * `PrismaPg` adapter, over a `pg.Pool` whose `query` is a recorder. Nothing
 * connects: the pool's address is a port nothing listens on and no path here
 * asks it for a connection. What is asserted is the `values` array the adapter
 * hands the driver, one hop before the wire — the same technique as
 * `prisma-date-column-binding.test.ts`, and for the same reason. Modelling the
 * narrowing in a local `boundDay()` helper and asserting against the model is
 * exactly what that file exists to stop.
 *
 * ## Why the host time zone is pinned, and what each pin is worth
 *
 * `APP_TIME_ZONE` is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`
 * and is read once at import (`src/config/operational.ts`), so assigning
 * `process.env.TZ` inside a test moves the HOST's zone — what `setHours` and
 * `new Date("...T00:00:00")` mean — while the CLUB's zone stays whatever it was
 * at import. `expectClubTimeZonePremise()` is what makes a host with `TZ`
 * already set say so out loud instead of arriving as a bare date mismatch
 * (docs/TESTING.md rule 6).
 *
 * The fixed code has NO host-zone input left — `parseDateOnly` builds an
 * explicit `Z` instant and `startOfDateOnlyForTimeZone` takes the club zone
 * explicitly — so every pin below must produce the identical binding. That
 * invariance is the assertion. Measured by restoring the defect (one shared
 * local-midnight range across all four arms) and re-running this file:
 *
 * | host zone pinned              | assertions red with the defect restored |
 * | ----------------------------- | --------------------------------------- |
 * | `Pacific/Auckland` (UTC+12, the production pin) | the `checkIn` half |
 * | `America/New_York` (UTC-4)    | the three instant arms |
 * | `UTC` (the CI runner)         | the three instant arms |
 *
 * Read that table carefully, because it is the whole reason there are two
 * zones. East of UTC, local midnight is the previous UTC day, so the DATE
 * narrowing is wrong and the instants coincidentally agree with the club's.
 * West of UTC — and at UTC — local midnight is the same UTC day, so the DATE
 * comes out right by accident and only the instants move. **Either zone alone
 * passes a half-fixed implementation.** New York is not a claim about how this
 * is deployed; it is the pin that can see the half Auckland cannot.
 */
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { RepairDependencies } from "@/lib/xero-booking-repair-deps";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";
import { loadAuditData } from "@/lib/xero-booking-repair-load";
import { withTimeZoneAsync } from "@/lib/__tests__/helpers/timezone";

type CapturedQuery = { text: string; values: unknown[] };

const captured: CapturedQuery[] = [];

/**
 * A real `pg.Pool` — `PrismaPg` treats an argument as an external pool only when
 * it passes `instanceof pg.Pool` — with its `query` swapped for a recorder,
 * pointed at a port nothing listens on.
 */
const pool = new pg.Pool({
  connectionString: "postgresql://unused:unused@127.0.0.1:1/unused",
});
pool.query = (async (config: unknown) => {
  captured.push(config as CapturedQuery);
  return { fields: [], rows: [], rowCount: 0, command: "SELECT" };
}) as typeof pool.query;

const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

/** The operator's request, in the two forms this file talks about it. */
const FIRST_REQUESTED_DAY = "2026-07-01";
const LAST_REQUESTED_DAY = "2026-07-31";

/**
 * The eight window parameters of the scope statement, in the order the compiled
 * SQL uses them.
 *
 * `loadAuditData` emits several statements (the selected relations are fetched
 * separately, with an empty id list once the recorder returns no rows). The one
 * that carries the window is picked by name rather than by position, and the
 * SQL text is asserted alongside so "the leading eight" is anchored to the
 * right operands rather than to an ordering that could silently change meaning.
 */
function windowParameters(): {
  createdAt: [unknown, unknown];
  updatedAt: [unknown, unknown];
  checkIn: [unknown, unknown];
  modificationCreatedAt: [unknown, unknown];
} {
  const scopeQueries = captured.filter((query) =>
    query.text.includes('FROM "public"."Booking" WHERE'),
  );
  expect(
    scopeQueries.length,
    "Expected exactly one statement carrying the scope filter. If the client " +
      "now emits more, select the one carrying the window rather than " +
      "relaxing this.",
  ).toBe(1);

  const { text, values } = scopeQueries[0];
  // Anchor each parameter index to the operand it belongs to. Without this the
  // tuple assertions below would pass just as happily if the compiler reordered
  // the OR arms and every arm silently swapped windows.
  expect(text).toContain('"public"."Booking"."createdAt" >= $1');
  expect(text).toContain('"public"."Booking"."createdAt" < $2');
  expect(text).toContain('"public"."Booking"."updatedAt" >= $3');
  expect(text).toContain('"public"."Booking"."updatedAt" < $4');
  expect(text).toContain('"public"."Booking"."checkIn" >= $5');
  expect(text).toContain('"public"."Booking"."checkIn" < $6');
  expect(text).toContain('"t0"."createdAt" >= $7');
  expect(text).toContain('"t0"."createdAt" < $8');
  expect(text).toContain('FROM "public"."BookingModification" AS "t0"');

  return {
    createdAt: [values[0], values[1]],
    updatedAt: [values[2], values[3]],
    checkIn: [values[4], values[5]],
    modificationCreatedAt: [values[6], values[7]],
  };
}

async function bindScopeWindow(hostTimeZone: string) {
  captured.length = 0;
  await withTimeZoneAsync(hostTimeZone, async () => {
    await loadAuditData(
      { from: FIRST_REQUESTED_DAY, to: LAST_REQUESTED_DAY },
      { prisma } as unknown as RepairDependencies,
    );
  });
  return windowParameters();
}

/**
 * The DATE bounds the `checkIn` arm binds, as the calendar days they are.
 *
 * Comparing two `yyyy-MM-dd` strings is Postgres's own ordering of two `date`
 * values — fixed width, most significant field first — not a model of the
 * adapter. The adapter's behaviour is the thing being MEASURED here (that a
 * `@db.Date` parameter arrives as a bare day at all), never assumed.
 */
function admitsCheckInDay(bounds: [unknown, unknown], day: string): boolean {
  const [gte, lt] = bounds as [string, string];
  return day >= gte && day < lt;
}

/**
 * Whether an instant falls in an instant arm's window, given as the UTC wall
 * clock the adapter itself formats (`yyyy-MM-dd HH:mm:ss`) — the format the
 * captured bounds below are asserted to be in, so the same fixed-width
 * lexicographic order applies.
 */
function admitsInstant(bounds: [unknown, unknown], utcWallClock: string): boolean {
  const [gte, lt] = bounds as [string, string];
  return utcWallClock >= gte && utcWallClock < lt;
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  expectClubTimeZonePremise();
  captured.length = 0;
});

describe.each([
  ["Pacific/Auckland", "the production pin, UTC+12 — east of UTC"],
  ["America/New_York", "UTC-4 — west of UTC"],
  ["UTC", "the CI runner"],
])("the repair sweep's [from, to] window, host pinned to %s (%s)", (hostZone) => {
  it("sweeps exactly the club days the operator named", async () => {
    const bound = await bindScopeWindow(hostZone);

    expect(
      bound.checkIn,
      "INV-DATE-013: `Booking.checkIn` is `@db.Date`, so its bounds must be the " +
        "operator's calendar days themselves. The half-open upper bound is the " +
        "day AFTER `--to`, which is what makes `--to` an included day.",
    ).toEqual(["2026-07-01", "2026-08-01"]);

    expect(
      admitsCheckInDay(bound.checkIn, FIRST_REQUESTED_DAY),
      "a booking checking in on the FIRST day of --from/--to must be swept",
    ).toBe(true);
    expect(
      admitsCheckInDay(bound.checkIn, LAST_REQUESTED_DAY),
      "#2868: a booking checking in on the LAST day of --from/--to must be " +
        "swept. This is the assertion the defect failed — the window ended at " +
        "30 July for a sweep asked to run to the 31st.",
    ).toBe(true);
    expect(
      admitsCheckInDay(bound.checkIn, "2026-06-30"),
      "#2868: the day BEFORE --from must not be swept. The defect pulled it " +
        "in, which is the other end of the same one-day shift.",
    ).toBe(false);
    expect(
      admitsCheckInDay(bound.checkIn, "2026-08-01"),
      "the day after --to must not be swept",
    ).toBe(false);
  });

  it("bounds the three instant columns at the START of those club days, not at their UTC midnight", async () => {
    const bound = await bindScopeWindow(hostZone);

    // 1 July 2026 in New Zealand begins at 2026-06-30T12:00Z (NZST, UTC+12),
    // and 1 August begins at 2026-07-31T12:00Z. A date-only value would have
    // put both boundaries twelve hours late — club MIDDAY — and dropped every
    // booking created or edited in the first half of the first requested day.
    const clubDayStarts = ["2026-06-30 12:00:00", "2026-07-31 12:00:00"];

    expect(
      bound.createdAt,
      "INV-DATE-013: `Booking.createdAt` is a bare `DateTime` — a real instant, " +
        "not narrowed by the adapter — so it takes the instant the club day " +
        "starts, never the date-only value the `@db.Date` arm beside it takes.",
    ).toEqual(clubDayStarts);
    expect(bound.updatedAt, "`Booking.updatedAt` is the same kind of column").toEqual(
      clubDayStarts,
    );
    expect(
      bound.modificationCreatedAt,
      "`BookingModification.createdAt` is the same kind of column, and is the " +
        "fourth consumer of this one window — the issue's brief said three",
    ).toEqual(clubDayStarts);

    expect(
      admitsInstant(bound.createdAt, "2026-06-30 12:30:00"),
      "a booking created at 00:30 NZ on the first requested day must be swept",
    ).toBe(true);
    expect(
      admitsInstant(bound.createdAt, "2026-06-30 11:30:00"),
      "a booking created at 23:30 NZ on the day BEFORE must not be swept",
    ).toBe(false);
    expect(
      admitsInstant(bound.createdAt, "2026-07-31 11:30:00"),
      "a booking created at 23:30 NZ on the last requested day must be swept",
    ).toBe(true);
    expect(
      admitsInstant(bound.createdAt, "2026-07-31 12:30:00"),
      "a booking created at 00:30 NZ on the day AFTER must not be swept",
    ).toBe(false);
  });
});

describe("the bound window does not depend on the host's time zone (#2868)", () => {
  it("binds identically east of UTC, west of UTC, and at UTC", async () => {
    const auckland = await bindScopeWindow("Pacific/Auckland");
    const newYork = await bindScopeWindow("America/New_York");
    const utc = await bindScopeWindow("UTC");

    expect(
      newYork,
      "The operator names club calendar days, so nothing about the window may " +
        "come from wherever the process happens to be pinned. A difference here " +
        "means a host-zone input has come back into the derivation — which is " +
        "what `setHours(0, 0, 0, 0)` was.",
    ).toEqual(auckland);
    expect(utc).toEqual(auckland);
  });
});
