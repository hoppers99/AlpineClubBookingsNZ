import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGE_UNAVAILABLE_LABEL,
  calculateMemberAgeParts,
  formatAgeYearsMonths,
  formatMemberIdentityAge,
} from "@/lib/member-age";

// Every case below pins its own reference date, so nothing here depends on the
// real calendar. The block at the end deliberately moves the system clock to
// prove the DEFAULT reference date is the New Zealand calendar day; it restores
// the suite-wide frozen instant afterwards (AGENTS.md frozen-clock convention).
const NZ_TODAY = "2026-07-01";

describe("formatAgeYearsMonths", () => {
  it("formats a normal date of birth", () => {
    expect(formatAgeYearsMonths("1990-01-01", "2026-05-10")).toBe(
      "36 years 4 months"
    );
  });

  it("handles a birthday that has not occurred this month", () => {
    expect(formatAgeYearsMonths("1990-05-20", "2026-05-10")).toBe(
      "35 years 11 months"
    );
  });

  it("handles a birthday today", () => {
    expect(formatAgeYearsMonths("1990-05-10", "2026-05-10")).toBe(
      "36 years 0 months"
    );
  });

  it("handles leap-day dates of birth in non-leap years", () => {
    expect(formatAgeYearsMonths("2000-02-29", "2026-02-28")).toBe(
      "26 years 0 months"
    );
  });

  it("returns null for a null date of birth", () => {
    expect(formatAgeYearsMonths(null, "2026-05-10")).toBeNull();
  });

  it("singularises one year and one month", () => {
    expect(formatAgeYearsMonths("2025-06-01", "2026-07-01")).toBe(
      "1 year 1 month"
    );
  });
});

describe("formatMemberIdentityAge — generations in one family group (#2568)", () => {
  it("separates an adult child from an older parent", () => {
    // The case the issue opens with: two ADULTs, three decades apart.
    expect(formatMemberIdentityAge("2007-06-15", NZ_TODAY)).toBe("19 years");
    expect(formatMemberIdentityAge("1974-03-02", NZ_TODAY)).toBe("52 years");
  });

  it("separates three adult generations", () => {
    expect(formatMemberIdentityAge("1948-11-20", NZ_TODAY)).toBe("77 years");
    expect(formatMemberIdentityAge("1974-03-02", NZ_TODAY)).toBe("52 years");
    expect(formatMemberIdentityAge("2007-06-15", NZ_TODAY)).toBe("19 years");
  });

  it("gives two same-named members different ages when their births differ", () => {
    // Same first name, same surname, same age tier — the age is the only
    // separator an admin has.
    const olderJohnSmith = formatMemberIdentityAge("1969-04-04", NZ_TODAY);
    const youngerJohnSmith = formatMemberIdentityAge("1998-04-04", NZ_TODAY);
    expect(olderJohnSmith).toBe("57 years");
    expect(youngerJohnSmith).toBe("28 years");
    expect(olderJohnSmith).not.toBe(youngerJohnSmith);
  });

  it("gives two members born in the same year the same label", () => {
    // Two members of the same age are NOT distinguishable by age, and the label
    // must not pretend otherwise — email and age tier carry the rest.
    expect(formatMemberIdentityAge("2007-01-05", NZ_TODAY)).toBe("19 years");
    expect(formatMemberIdentityAge("2007-06-15", NZ_TODAY)).toBe("19 years");
  });
});

describe("formatMemberIdentityAge — years versus years-and-months (#2568)", () => {
  it("shows completed years and months under five", () => {
    expect(formatMemberIdentityAge("2022-10-20", NZ_TODAY)).toBe(
      "3 years 8 months"
    );
  });

  it("counts only COMPLETED months", () => {
    // Born on the 10th; the reference date is the 1st, so the month in progress
    // does not count.
    expect(formatMemberIdentityAge("2022-11-10", NZ_TODAY)).toBe(
      "3 years 7 months"
    );
  });

  it("shows years and months for an infant under one", () => {
    expect(formatMemberIdentityAge("2026-01-01", NZ_TODAY)).toBe(
      "0 years 6 months"
    );
  });

  it("switches to years only on the fifth birthday", () => {
    expect(formatMemberIdentityAge("2021-07-01", "2026-06-30")).toBe(
      "4 years 11 months"
    );
    expect(formatMemberIdentityAge("2021-07-01", "2026-07-01")).toBe("5 years");
  });
});

describe("formatMemberIdentityAge — birthdays around the reference date (#2568)", () => {
  it("counts a birthday that falls on the reference date", () => {
    expect(formatMemberIdentityAge("2007-07-01", NZ_TODAY)).toBe("19 years");
  });

  it("does not count a birthday that falls tomorrow", () => {
    expect(formatMemberIdentityAge("2007-07-02", NZ_TODAY)).toBe("18 years");
  });

  it("counts a birthday that fell yesterday", () => {
    expect(formatMemberIdentityAge("2007-06-30", NZ_TODAY)).toBe("19 years");
  });
});

describe("formatMemberIdentityAge — 29 February (#2568)", () => {
  it("counts the birthday on 29 February in a leap year", () => {
    expect(formatMemberIdentityAge("2000-02-29", "2028-02-28")).toBe("27 years");
    expect(formatMemberIdentityAge("2000-02-29", "2028-02-29")).toBe("28 years");
  });

  it("counts the birthday on 28 February in a non-leap year", () => {
    // Documented convention: the anniversary clamps to the last day of the
    // month, so a leap-day member turns over on 28 February rather than 1 March.
    expect(formatMemberIdentityAge("2000-02-29", "2027-02-27")).toBe("26 years");
    expect(formatMemberIdentityAge("2000-02-29", "2027-02-28")).toBe("27 years");
    expect(formatMemberIdentityAge("2000-02-29", "2027-03-01")).toBe("27 years");
  });

  it("handles a leap-day toddler in the years-and-months band", () => {
    expect(formatMemberIdentityAge("2024-02-29", "2027-03-01")).toBe(
      "3 years 0 months"
    );
    expect(formatMemberIdentityAge("2024-02-29", "2027-02-28")).toBe(
      "3 years 0 months"
    );
    expect(formatMemberIdentityAge("2024-02-29", "2027-02-27")).toBe(
      "2 years 11 months"
    );
  });

  it("accepts a 29 February reference date", () => {
    expect(formatMemberIdentityAge("2020-01-31", "2028-02-29")).toBe("8 years");
  });
});

describe("formatMemberIdentityAge — missing and invalid dates (#2568)", () => {
  it("reports a missing date of birth as unavailable", () => {
    expect(formatMemberIdentityAge(null, NZ_TODAY)).toBe(AGE_UNAVAILABLE_LABEL);
    expect(formatMemberIdentityAge(undefined, NZ_TODAY)).toBe(
      AGE_UNAVAILABLE_LABEL
    );
    expect(formatMemberIdentityAge("", NZ_TODAY)).toBe(AGE_UNAVAILABLE_LABEL);
    expect(AGE_UNAVAILABLE_LABEL).toBe("Age unavailable");
  });

  it("reports an unparseable date of birth as unavailable", () => {
    for (const bad of [
      "not-a-date",
      "01/02/2003",
      "2020-13-05",
      "2021-02-30",
      "2021-00-10",
      "0000-00-00",
    ]) {
      expect(formatMemberIdentityAge(bad, NZ_TODAY)).toBe(AGE_UNAVAILABLE_LABEL);
    }
    expect(formatMemberIdentityAge(new Date("nonsense"), NZ_TODAY)).toBe(
      AGE_UNAVAILABLE_LABEL
    );
  });

  it("reports a future date of birth as unavailable rather than as a newborn", () => {
    // A mistyped year must read as unusable. "0 years 0 months" would look like
    // a real infant and could be approved as one.
    expect(formatMemberIdentityAge("2030-01-01", NZ_TODAY)).toBe(
      AGE_UNAVAILABLE_LABEL
    );
    expect(formatMemberIdentityAge("2026-07-02", NZ_TODAY)).toBe(
      AGE_UNAVAILABLE_LABEL
    );
    expect(calculateMemberAgeParts("2026-07-02", NZ_TODAY)).toBeNull();
  });

  it("reports an unusable reference date as unavailable", () => {
    expect(formatMemberIdentityAge("2000-01-01", "not-a-date")).toBe(
      AGE_UNAVAILABLE_LABEL
    );
  });
});

describe("member age — date-only semantics, no timezone drift (#2568)", () => {
  it("reads a UTC-midnight Date as its own calendar day", () => {
    // A stored date-only value is pinned to UTC midnight, which is midday in New
    // Zealand — the same calendar day. Reading it with local getters on a server
    // west of UTC would move it back a day and report an age a year short on a
    // birthday.
    expect(
      formatMemberIdentityAge(new Date("2007-07-01T00:00:00.000Z"), NZ_TODAY)
    ).toBe("19 years");
  });

  it("agrees between a Date, its ISO string, and a bare date-only string", () => {
    expect(
      formatMemberIdentityAge(new Date("2007-07-01T00:00:00.000Z"), NZ_TODAY)
    ).toBe("19 years");
    expect(formatMemberIdentityAge("2007-07-01T00:00:00.000Z", NZ_TODAY)).toBe(
      "19 years"
    );
    expect(formatMemberIdentityAge("2007-07-01", NZ_TODAY)).toBe("19 years");
  });

  it("accepts a Date as the reference date", () => {
    expect(
      formatMemberIdentityAge("2007-07-01", new Date("2026-07-01T00:00:00.000Z"))
    ).toBe("19 years");
  });

  it("exposes the parts as completed years and months", () => {
    expect(calculateMemberAgeParts("2022-10-20", NZ_TODAY)).toEqual({
      years: 3,
      months: 8,
    });
  });
});

describe("member age — the default reference date is the NZ calendar day (#2568)", () => {
  afterEach(() => {
    // Hand the clock back to the suite-wide frozen instant (midday NZ, where UTC
    // and NZ agree), so nothing after this block inherits a pinned edge case.
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
  });

  it("uses the NZ date when UTC is still on the previous day", () => {
    // 2026-06-30 13:00 UTC is 2026-07-01 01:00 in New Zealand. A member born on
    // 1 July has their birthday TODAY in club terms; deriving "today" from the
    // UTC date would report them a year younger for the first 12 hours of it.
    vi.setSystemTime(new Date("2026-06-30T13:00:00.000Z"));
    expect(formatMemberIdentityAge("2007-07-01")).toBe("19 years");
    expect(formatMemberIdentityAge("2007-07-02")).toBe("18 years");
  });

  it("uses the NZ date when UTC has already moved to the next day", () => {
    // 2026-07-01 23:00 UTC is 2026-07-02 11:00 NZ — one NZ day past the 1st, so
    // a 2 July birthday has landed.
    vi.setSystemTime(new Date("2026-07-01T23:00:00.000Z"));
    expect(formatMemberIdentityAge("2007-07-02")).toBe("19 years");
  });

  it("uses the NZ date for the years-and-months band too", () => {
    vi.setSystemTime(new Date("2026-06-30T13:00:00.000Z"));
    expect(formatMemberIdentityAge("2022-10-20")).toBe("3 years 8 months");
  });
});
