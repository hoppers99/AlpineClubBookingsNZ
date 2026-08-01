import { describe, it, expect } from "vitest";
import {
  formatNZDate,
  formatNZDateTime,
  formatNZLongDate,
  formatNZMonthYear,
  formatNZTime,
  formatNZWeekdayDate,
} from "../nzst-date";

// The NZST "today"/"tomorrow" helpers were removed in #1878 (they parsed
// `${y}-${m}-${d}T00:00:00` in the server's LOCAL zone, shifting Prisma
// @db.Date comparisons a day back under the production TZ=Pacific/Auckland
// pin). Cron "today"/"tomorrow" coverage now lives in date-only.test.ts
// ("NZ cron date boundary (#1878)"). Only the display formatters remain here.
//
// 2026-04-15T23:30:00Z is 2026-04-16 11:30 in Pacific/Auckland (NZST, +12):
// the NZ calendar date differs from the UTC one, so these assertions fail if
// the formatters ever stop rendering in the club time zone.
const INSTANT = new Date("2026-04-15T23:30:00.000Z");

describe("formatNZDate", () => {
  it("renders the NZ calendar date, not the UTC date", () => {
    expect(formatNZDate(INSTANT)).toBe("16 Apr 2026");
  });
});

describe("formatNZDateTime", () => {
  it("renders the NZ-local date and time", () => {
    const formatted = formatNZDateTime(INSTANT);
    expect(formatted).toContain("16 Apr 2026");
    // \s tolerates the narrow no-break space some ICU versions emit.
    expect(formatted).toMatch(/11:30\sam/);
  });
});

// #2264 — the three shapes below existed only as hand-rolled
// `toLocaleTimeString`/`toLocaleDateString` calls, several of which had no
// `timeZone` at all. Each assertion is chosen so that the UTC answer and the
// NZ answer DIFFER: a helper that lost its zone pin fails here rather than
// passing on a UTC continuous-integration runner and misreporting in Auckland.

describe("formatNZTime", () => {
  it("renders the NZ-local time of day, without seconds", () => {
    // 23:30 UTC is 11:30 the NEXT morning in Auckland.
    expect(formatNZTime(INSTANT)).toMatch(/^11:30\sam$/);
  });

  it("crosses the NZ midnight boundary rather than the UTC one", () => {
    // 12:30 UTC on 15 April is 00:30 on 16 April in Auckland.
    expect(formatNZTime(new Date("2026-04-15T12:30:00.000Z"))).toMatch(
      /^12:30\sam$/,
    );
  });
});

describe("formatNZMonthYear", () => {
  it("renders the NZ calendar month, not the UTC month", () => {
    // 31 March 23:30 UTC is already 1 April in Auckland.
    expect(formatNZMonthYear(new Date("2026-03-31T23:30:00.000Z"))).toBe(
      "April 2026",
    );
  });

  it("renders the NZ calendar year, not the UTC year", () => {
    // 31 December 23:30 UTC is already 1 January in Auckland.
    expect(formatNZMonthYear(new Date("2026-12-31T23:30:00.000Z"))).toBe(
      "January 2027",
    );
  });
});

describe("formatNZWeekdayDate", () => {
  it("renders the NZ weekday and calendar date, not the UTC ones", () => {
    // 15 April 2026 is a Wednesday in UTC; 23:30 UTC is Thursday 16 in NZ.
    expect(formatNZWeekdayDate(INSTANT)).toBe("Thu, 16 Apr 2026");
  });
});

// #2264, owner decision (2 Aug 2026): the member-facing surfaces keep the LONG
// spelled-out month. A regression to the medium house form ("16 Apr 2026")
// fails here, and the call sites themselves are pinned in
// `member-facing-long-dates.test.ts`.
describe("formatNZLongDate", () => {
  it("renders the long spelled-out month, not the medium abbreviation", () => {
    expect(formatNZLongDate(INSTANT)).toBe("16 April 2026");
    expect(formatNZLongDate(INSTANT)).not.toBe(formatNZDate(INSTANT));
  });

  it("renders the NZ calendar date, not the UTC date", () => {
    // 23:30 UTC on 15 April is already 16 April in Auckland.
    expect(formatNZLongDate(new Date("2026-04-15T11:30:00.000Z"))).toBe(
      "15 April 2026",
    );
  });
});
