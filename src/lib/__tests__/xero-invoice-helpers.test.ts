import { describe, expect, it } from "vitest";

import {
  getBookingInvoiceDueDate,
  getBookingInvoiceIssueDate,
} from "@/lib/xero-invoice-helpers";

/**
 * `Booking.createdAt` is a `DateTime` instant; `Booking.checkIn` is a `@db.Date`
 * lodge night. The two need opposite treatment, and getting them the same way was
 * the defect (#2697): a booking made in the New Zealand morning falls on the
 * PREVIOUS UTC day, so Xero received a due date one day early.
 */
describe("getBookingInvoiceDueDate", () => {
  it("uses the club calendar day for a booking made in the NZ morning (NZST)", () => {
    // 2026-06-15 09:30 in Pacific/Auckland (UTC+12) — the UTC day is still the 14th.
    const createdAt = new Date("2026-06-14T21:30:00.000Z");

    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-06-14");
    expect(getBookingInvoiceDueDate({ createdAt })).toBe("2026-06-15");
  });

  it("uses the club calendar day across the daylight-saving offset (NZDT)", () => {
    // 2026-01-15 11:00 in Pacific/Auckland (UTC+13) — the UTC day is still the 14th.
    const createdAt = new Date("2026-01-14T22:00:00.000Z");

    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-01-14");
    expect(getBookingInvoiceDueDate({ createdAt })).toBe("2026-01-15");
  });

  it("is unchanged when the UTC day and the club day already agree", () => {
    // 2026-06-15 14:00 in Pacific/Auckland — afternoon, so both calendars agree.
    const createdAt = new Date("2026-06-15T02:00:00.000Z");

    expect(getBookingInvoiceDueDate({ createdAt })).toBe("2026-06-15");
  });

  it("accepts a serialised instant as well as a Date", () => {
    expect(getBookingInvoiceDueDate({ createdAt: "2026-06-14T21:30:00.000Z" })).toBe(
      "2026-06-15"
    );
  });
});

describe("getBookingInvoiceIssueDate", () => {
  it("reads a date-only lodge night back as the day it encodes", () => {
    // checkIn is `@db.Date`: UTC midnight is the encoding of a calendar day, not
    // an instant (INV-DATE-010), so it must NOT be shifted into club time.
    expect(
      getBookingInvoiceIssueDate({ checkIn: new Date("2026-06-15T00:00:00.000Z") })
    ).toBe("2026-06-15");
  });

  it("reads a date-only lodge night back the same way across the DST boundary", () => {
    expect(
      getBookingInvoiceIssueDate({ checkIn: new Date("2026-01-15T00:00:00.000Z") })
    ).toBe("2026-01-15");
  });
});
