/**
 * What actually reaches Postgres when a `Date` is bound against a `@db.Date`
 * column, and against a plain `DateTime` one (#2838).
 *
 * WHY THIS EXISTS. Every date-boundary suite in this repository — the club-day
 * ones added by #2838, and the older windows they sit beside — models the
 * adapter's narrowing in a local helper (`boundDay`: "its UTC date, time
 * discarded") and reasons from there. That model is the load-bearing premise of
 * INV-DATE-013: it is the single step that turns "the value is twelve hours
 * early" into "the query asks about the wrong DAY". Nothing in the tree
 * exercised it. A change to how `@prisma/adapter-pg` binds a date would move
 * production behaviour with the whole suite green, because every one of those
 * files would go on asserting against its own copy of the assumption.
 *
 * HOW. The real generated Prisma Client, the real query compiler and the real
 * `PrismaPg` adapter, over a `pg.Pool` whose `query` is replaced by a recorder.
 * Nothing connects to anything: the pool is given an unreachable address and is
 * never asked for a connection. What is asserted is the `values` array the
 * adapter hands the driver — one hop before the wire.
 *
 * This is deliberately NOT a re-implementation of `mapArg`. Asserting that
 * `formatDate` calls `getUTCDate()` would only restate the mechanism; driving
 * the client is what makes the assertion fail if a future version stops doing
 * it, for whatever reason.
 */
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getTodayDateOnly, startOfDateOnlyForTimeZone } from "@/lib/date-only";

type CapturedQuery = { text: string; values: unknown[] };

const captured: CapturedQuery[] = [];

/**
 * A real `pg.Pool` — `PrismaPg` treats an argument as an external pool only when
 * it passes `instanceof pg.Pool`, and the factory attaches an `error` listener
 * to it — with its `query` swapped for a recorder. The connection string points
 * at a port nothing listens on, and no path here ever asks the pool to connect.
 */
const pool = new pg.Pool({
  connectionString: "postgresql://unused:unused@127.0.0.1:1/unused",
});
pool.query = (async (config: unknown) => {
  captured.push(config as CapturedQuery);
  return { fields: [], rows: [], rowCount: 0, command: "SELECT" };
}) as typeof pool.query;

const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  captured.length = 0;
});

/**
 * The WHERE parameters of the one statement the client emitted.
 *
 * The compiler appends its own `LIMIT`/`OFFSET` placeholders after the filter's,
 * so the filter parameters are the leading `count` of them. The SQL text is
 * asserted alongside, which is what anchors "leading" to the right operands
 * rather than to a position that could silently change meaning.
 */
function whereValues(count: number, sqlContains: string): unknown[] {
  expect(
    captured.length,
    "Expected exactly one statement. If the client now emits more (a " +
      "transaction wrapper, a preamble), select the one carrying the filter " +
      "rather than relaxing this.",
  ).toBe(1);
  expect(captured[0].text).toContain(sqlContains);
  return captured[0].values.slice(0, count);
}

describe("a @db.Date column is bound as a calendar DAY (#2838, INV-DATE-013)", () => {
  it("throws the time away and sends the value's UTC date", async () => {
    // 12:00Z on 1 July is midnight on 2 July in NZST — the exact instant the old
    // `new Date()` + `setHours(0, 0, 0, 0)` produced under the server's
    // `TZ=Pacific/Auckland` pin, and the one INV-DATE-013 says lands a day early.
    await prisma.booking.findMany({
      where: { checkIn: { gte: new Date("2026-07-01T12:00:00.000Z") } },
    });

    expect(
      whereValues(1, '"checkIn" >= $1'),
      "INV-DATE-013: `Booking.checkIn` is `@db.Date`, and the adapter narrows a " +
        "bound Date to its UTC calendar date (`formatDate` in `mapArg`). If this " +
        "is no longer a bare `yyyy-MM-dd`, every club-day boundary suite in this " +
        "repository is reasoning from a model of the adapter that no longer holds.",
    ).toEqual(["2026-07-01"]);
  });

  it("THE DEFECT: the old and new values for the SAME club day bind as different days", async () => {
    // Club day 2 July 2026, spelled both ways.
    const clubDay = "2026-07-02";
    const localMidnightUnderNzPin = new Date("2026-07-01T12:00:00.000Z");
    const dateOnly = new Date(`${clubDay}T00:00:00.000Z`);
    // Both name midnight at the start of the same NZ day; only the encoding
    // differs. (`getTodayDateOnly()` produces the second shape — UTC midnight.)
    expect(getTodayDateOnly().toISOString()).toMatch(/T00:00:00\.000Z$/);

    await prisma.booking.findMany({ where: { checkIn: { gte: localMidnightUnderNzPin } } });
    const old = whereValues(1, '"checkIn" >= $1');

    captured.length = 0;
    await prisma.booking.findMany({ where: { checkIn: { gte: dateOnly } } });
    const fixed = whereValues(1, '"checkIn" >= $1');

    expect(old).toEqual(["2026-07-01"]);
    expect(fixed).toEqual([clubDay]);
    expect(
      old,
      "INV-DATE-013: this inequality IS #2838. Two spellings of the same NZ " +
        "midnight reach Postgres as different calendar days, so a window built " +
        "on the local-midnight one runs a day behind — all day, every day.",
    ).not.toEqual(fixed);
  });

  it("binds a two-ended window as the two days the dashboard means", async () => {
    // The dashboard's staying-guest read, in the shape it actually compiles to:
    // `checkIn <= tomorrow AND checkOut >= today`, both `@db.Date`.
    const today = new Date("2026-07-02T00:00:00.000Z");
    const tomorrow = new Date("2026-07-03T00:00:00.000Z");

    await prisma.booking.findFirst({
      where: { checkIn: { lte: tomorrow }, checkOut: { gte: today } },
      select: { id: true },
    });

    expect(whereValues(2, '"checkIn" <= $1')).toEqual(["2026-07-03", "2026-07-02"]);
  });
});

describe("a plain DateTime column keeps the whole instant (#2838, INV-DATE-013)", () => {
  it("sends the time as well as the date", async () => {
    // `Booking.draftExpiresAt` is a real moment, so it is NOT narrowed. This is
    // the other half of the rule the dashboard states: handing this column a
    // date-only value would bind UTC midnight, which is club MIDDAY, and hide a
    // draft expiring that morning.
    const startOfClubDay = startOfDateOnlyForTimeZone("2026-07-02");
    expect(startOfClubDay.toISOString()).toBe("2026-07-01T12:00:00.000Z");

    await prisma.booking.findMany({
      where: { draftExpiresAt: { gt: startOfClubDay } },
    });

    expect(
      whereValues(1, '"draftExpiresAt" > $1'),
      "INV-DATE-013: a `DateTime` column must keep its time. If this were " +
        "narrowed to a day, the two encodings the dashboard keeps apart would " +
        "have collapsed into one and the distinction it documents would be dead " +
        "code.",
    ).toEqual(["2026-07-01 12:00:00"]);
  });

  it("would sit at club MIDDAY if given a date-only value", async () => {
    // The mistake in the other direction, made executable rather than described.
    await prisma.booking.findMany({
      where: { draftExpiresAt: { gt: new Date("2026-07-02T00:00:00.000Z") } },
    });

    // 00:00Z on 2 July is midday on 2 July in NZ — twelve hours past the start
    // of the club day the value was meant to name.
    expect(whereValues(1, '"draftExpiresAt" > $1')).toEqual(["2026-07-02 00:00:00"]);
  });
});
