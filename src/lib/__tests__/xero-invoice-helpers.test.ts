import { describe, expect, it } from "vitest";

import { APP_TIME_ZONE } from "@/config/operational";
import {
  getBookingInvoiceDueDate,
  getBookingInvoiceIssueDate,
} from "@/lib/xero-invoice-helpers";

/**
 * `Booking.createdAt` is a `DateTime` instant; `Booking.checkIn` is a `@db.Date`
 * lodge night. The two need opposite treatment, and treating them the same way
 * was the defect (#2697): a booking made in the New Zealand morning falls on the
 * PREVIOUS UTC day, so Xero received a due date one day early (INV-DATE-019).
 *
 * The instants below are chosen so that a wrong zone FAILS them. A merely
 * "divergent" instant is not enough — 21:30Z sits ~9.5h into a 12h window, so it
 * passes under any zone from about UTC+10 upwards, including zones with no
 * daylight saving at all.
 */
describe("#2697 the club zone really is New Zealand", () => {
  it("runs with the club time zone actually set to New Zealand", () => {
    // docs/TESTING.md rule 6: setting TZ=UTC to imitate the CI runner ALSO moves
    // APP_TIME_ZONE, because it is `process.env.TZ || NEXT_PUBLIC_TZ ||
    // "Pacific/Auckland"`. Every assertion below would then go red and read like
    // the product bug this suite proves is fixed. Say what actually happened.
    expect(
      APP_TIME_ZONE,
      "This suite exists to prove the club day and the UTC day differ, so it needs the club zone to be New Zealand. TZ (or NEXT_PUBLIC_TZ) is overriding APP_TIME_ZONE — see docs/TESTING.md rule 6.",
    ).toBe("Pacific/Auckland");
  });
});

describe("getBookingInvoiceDueDate", () => {
  it("dates the first instant of a club day to that club day (NZST, UTC+12)", () => {
    // 2026-06-15 00:00:00 in Pacific/Auckland — the very start of the club day,
    // while UTC is still on the 14th. A zone shallower than +12 (Brisbane, +10)
    // returns 2026-06-14 and fails, so this pins the offset, not merely "ahead".
    const createdAt = new Date("2026-06-14T12:00:00.000Z");

    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-06-14");
    expect(getBookingInvoiceDueDate({ createdAt })).toBe("2026-06-15");
  });

  it("dates the last divergent instant of a club day to that club day", () => {
    // 2026-06-15 11:59:59.999 NZST — the last moment before UTC catches up.
    const createdAt = new Date("2026-06-14T23:59:59.999Z");

    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-06-14");
    expect(getBookingInvoiceDueDate({ createdAt })).toBe("2026-06-15");
  });

  it("is unchanged at the first instant where both calendars agree", () => {
    // 2026-06-15 12:00 NZST — UTC has rolled over to the 15th too.
    const createdAt = new Date("2026-06-15T00:00:00.000Z");

    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-06-15");
    expect(getBookingInvoiceDueDate({ createdAt })).toBe("2026-06-15");
  });

  it("proves the daylight-saving offset, not merely a positive one (NZDT, UTC+13)", () => {
    // 2026-01-15 00:30 in Pacific/Auckland, which is UTC+13 in January. A fixed
    // +12 zone with no daylight saving returns 2026-01-14 and fails, so this
    // test genuinely pins NZDT rather than passing anywhere east of UTC.
    const createdAt = new Date("2026-01-14T11:30:00.000Z");

    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-01-14");
    expect(getBookingInvoiceDueDate({ createdAt })).toBe("2026-01-15");
  });

  it("accepts a serialised instant as well as a Date", () => {
    expect(getBookingInvoiceDueDate({ createdAt: "2026-06-14T12:00:00.000Z" })).toBe(
      "2026-06-15"
    );
  });
});

describe("getBookingInvoiceIssueDate", () => {
  // These are round-trip tests, not guards: a UTC-midnight value read in a zone
  // AHEAD of UTC gives the same calendar day either way, so they would also pass
  // if this helper were (wrongly) routed through the club zone. The test that
  // actually discriminates the two receivers lives in
  // xero-invoice-helpers-zone-behind-utc.test.ts, which needs a different club
  // zone and therefore its own module registry.
  it("reads a date-only lodge night back as the day it encodes", () => {
    expect(
      getBookingInvoiceIssueDate({ checkIn: new Date("2026-06-15T00:00:00.000Z") })
    ).toBe("2026-06-15");
  });

  it("reads a date-only lodge night back the same way in the NZDT half of the year", () => {
    expect(
      getBookingInvoiceIssueDate({ checkIn: new Date("2026-01-15T00:00:00.000Z") })
    ).toBe("2026-01-15");
  });
});
