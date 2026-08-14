/**
 * #2859 — the date of birth a Xero contact carries in its NZBN field, both
 * directions.
 *
 * TWO DEFECTS ARE UNDER TEST HERE.
 *
 * A. The write did not exist. Every one of the twelve `companyNumber`
 *    references in the codebase was a READ, so a member's date of birth was
 *    never sent to Xero on any path — which is exactly what the club reported.
 *    `formatXeroContactDateOfBirth` and `buildXeroContactCompanyNumberPatch`
 *    are the outbound half that was missing.
 *
 * B. The read stored a day early. Two of the four copies of the `dd/mm/yyyy`
 *    parser built `new Date(\`${yyyy}-${mm}-${dd}T00:00:00\`)` — no `Z`, so
 *    SERVER-LOCAL midnight — and the `TZ=Pacific/Auckland` pin put the stored
 *    instant on the previous UTC day, every hour of every day.
 *
 * HOW THE DISCRIMINATION IS DONE, and why not with `TZ`. `APP_TIME_ZONE` is
 * `process.env.TZ || …` (docs/TESTING.md rule 6), so setting `TZ=UTC` to
 * "simulate CI" also moves the CLUB's zone to UTC and the premise guard fires
 * first — thirty identical date mismatches that read exactly like the product
 * bug. The zone is therefore passed EXPLICITLY to the formatter instead, and
 * the assertion that actually separates the fixed code from the broken code is
 * the UTC one: the old value rendered `1985-06-14` there and the new one
 * renders `1985-06-15`.
 */

import { describe, expect, it } from "vitest";

import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import {
  buildXeroContactCompanyNumberPatch,
  formatXeroContactDateOfBirth,
  isXeroContactDateOfBirthShape,
  parseXeroContactDateOfBirth,
} from "@/lib/xero-contact-date-of-birth";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";

describe("parseXeroContactDateOfBirth", () => {
  it("stores UTC midnight on the day the member was born, not the evening before", () => {
    expectClubTimeZonePremise();

    const parsed = parseXeroContactDateOfBirth("15/06/1985");

    expect(parsed?.toISOString()).toBe("1985-06-15T00:00:00.000Z");
    // The club's calendar and the UTC calendar agree on the day. Under the old
    // local-midnight parse the stored instant was 1985-06-14T12:00:00.000Z, so
    // this second assertion read "1985-06-14" and the two disagreed.
    expect(formatDateOnlyForTimeZone(parsed!, "Pacific/Auckland")).toBe(
      "1985-06-15",
    );
    expect(formatDateOnlyForTimeZone(parsed!, "UTC")).toBe("1985-06-15");
  });

  it("keeps a 1 January birthday in its own year", () => {
    expectClubTimeZonePremise();

    const parsed = parseXeroContactDateOfBirth("01/01/2000");

    // The year-boundary case. The old parse stored 1999-12-31T11:00:00.000Z, so
    // the error moved the YEAR as well as the day — a member born on the first
    // of the millennium was recorded as born in the previous one.
    expect(parsed?.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(formatDateOnlyForTimeZone(parsed!, "UTC")).toBe("2000-01-01");
    expect(formatDateOnlyForTimeZone(parsed!, "Pacific/Auckland")).toBe(
      "2000-01-01",
    );
  });

  it("stores the same day whether or not the birthday falls in New Zealand daylight time", () => {
    // The two live shapes came from this: a June birthday parsed at +12 (NZST)
    // and a March one at +13 (NZDT), which is why the defective rows sit at
    // 12:00 and 13:00 UTC. Neither offset may survive into the stored value.
    expect(parseXeroContactDateOfBirth("14/06/1985")?.toISOString()).toBe(
      "1985-06-14T00:00:00.000Z",
    );
    expect(parseXeroContactDateOfBirth("15/03/2010")?.toISOString()).toBe(
      "2010-03-15T00:00:00.000Z",
    );
  });

  it("refuses everything that is not this club's date-of-birth shape", () => {
    expect(parseXeroContactDateOfBirth(null)).toBeNull();
    expect(parseXeroContactDateOfBirth(undefined)).toBeNull();
    expect(parseXeroContactDateOfBirth("")).toBeNull();
    // A real New Zealand Business Number, which is what the field is for.
    expect(parseXeroContactDateOfBirth("9429041234567")).toBeNull();
    expect(parseXeroContactDateOfBirth("1985-06-15")).toBeNull();
    expect(parseXeroContactDateOfBirth("5/6/1985")).toBeNull();
    // A day that does not exist is not a date of birth.
    expect(parseXeroContactDateOfBirth("31/02/1990")).toBeNull();
    expect(parseXeroContactDateOfBirth("31/04/1990")).toBeNull();
    // A real leap day still is.
    expect(parseXeroContactDateOfBirth("29/02/1988")?.toISOString()).toBe(
      "1988-02-29T00:00:00.000Z",
    );
    expect(parseXeroContactDateOfBirth("29/02/1989")).toBeNull();
  });
});

describe("formatXeroContactDateOfBirth", () => {
  it("renders the stored day as dd/mm/yyyy, zero-padded", () => {
    expect(
      formatXeroContactDateOfBirth(new Date("1985-06-05T00:00:00.000Z")),
    ).toBe("05/06/1985");
    expect(
      formatXeroContactDateOfBirth(new Date("2000-01-01T00:00:00.000Z")),
    ).toBe("01/01/2000");
  });

  it("round-trips every parsed value back to the string Xero holds", () => {
    for (const companyNumber of [
      "15/06/1985",
      "01/01/2000",
      "29/02/1988",
      "31/12/1946",
    ]) {
      expect(
        formatXeroContactDateOfBirth(
          parseXeroContactDateOfBirth(companyNumber),
        ),
      ).toBe(companyNumber);
    }
  });

  it("has nothing to send when there is no date of birth", () => {
    expect(formatXeroContactDateOfBirth(null)).toBeNull();
    expect(formatXeroContactDateOfBirth(undefined)).toBeNull();
    expect(formatXeroContactDateOfBirth(new Date(Number.NaN))).toBeNull();
  });
});

describe("isXeroContactDateOfBirthShape", () => {
  it("separates this club's date-of-birth shape from a real NZBN", () => {
    expect(isXeroContactDateOfBirthShape("15/06/1985")).toBe(true);
    expect(isXeroContactDateOfBirthShape("9429041234567")).toBe(false);
    expect(isXeroContactDateOfBirthShape("NZBN 9429041234567")).toBe(false);
    expect(isXeroContactDateOfBirthShape("")).toBe(false);
    expect(isXeroContactDateOfBirthShape(null)).toBe(false);
  });
});

describe("buildXeroContactCompanyNumberPatch", () => {
  const dateOfBirth = new Date("1985-06-15T00:00:00.000Z");

  it("sends the date of birth when Xero holds nothing", () => {
    expect(buildXeroContactCompanyNumberPatch(dateOfBirth, null)).toEqual({
      companyNumber: "15/06/1985",
    });
    expect(buildXeroContactCompanyNumberPatch(dateOfBirth, "")).toEqual({
      companyNumber: "15/06/1985",
    });
    expect(buildXeroContactCompanyNumberPatch(dateOfBirth, "   ")).toEqual({
      companyNumber: "15/06/1985",
    });
  });

  it("sends it when nothing is known about the field — a contact being created, or one never cached", () => {
    expect(buildXeroContactCompanyNumberPatch(dateOfBirth)).toEqual({
      companyNumber: "15/06/1985",
    });
  });

  it("overwrites a DIFFERENT date already in Xero: an administrator maintains this here", () => {
    expect(
      buildXeroContactCompanyNumberPatch(dateOfBirth, "16/06/1985"),
    ).toEqual({ companyNumber: "15/06/1985" });
  });

  it("emits NO KEY AT ALL for a member with no date of birth, so an empty string can never blank a real NZBN", () => {
    // The decisive case: an organisation or school account has no date of birth
    // by definition and may carry a genuine New Zealand Business Number in this
    // very field. `{ companyNumber: "" }` would delete it.
    expect(buildXeroContactCompanyNumberPatch(null, "9429041234567")).toEqual(
      {},
    );
    expect(buildXeroContactCompanyNumberPatch(undefined, null)).toEqual({});
    expect(
      Object.hasOwn(buildXeroContactCompanyNumberPatch(null, null), "companyNumber"),
    ).toBe(false);
  });

  it("leaves a value that is not a date alone, even when the member has a date of birth", () => {
    // A date of birth does not get to overwrite the club's accounting data.
    expect(
      buildXeroContactCompanyNumberPatch(dateOfBirth, "9429041234567"),
    ).toEqual({});
    expect(
      buildXeroContactCompanyNumberPatch(dateOfBirth, "NZBN pending"),
    ).toEqual({});
  });
});
