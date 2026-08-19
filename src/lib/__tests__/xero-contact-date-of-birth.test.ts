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
 *    instant on the previous UTC day, every hour of every day. It reached 10 of
 *    the 375 members who hold a date of birth on the live site, six at `11:00`
 *    and four at `12:00`; the bulk of the membership came in through one of the
 *    two copies that were already correct.
 *
 * HOW THE DISCRIMINATION IS DONE, and why the club-zone premise guard is not
 * the tool for it. `new Date("yyyy-mm-ddT00:00:00")` reads the HOST zone, and
 * `expectClubTimeZonePremise()` checks `APP_TIME_ZONE` — which is
 * `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`, so with `TZ` unset
 * it reports `Pacific/Auckland` on a runner whose actual zone is UTC. Nothing in
 * `.github/workflows/`, `vitest.config.mts`, `vitest.setup.ts` or `package.json`
 * sets `TZ`, so on CI that guard passes while the host is UTC — and under a UTC
 * host the defective parser and the fixed one produce the IDENTICAL instant.
 * Every assertion here that claims to prove the zone fix was therefore inert on
 * the runner that has to catch it.
 *
 * So the host zone is FORCED, explicitly, with the shared helper from
 * docs/TESTING.md rules 6 and 7, and each claim is made in three zones at once:
 * UTC (the runner), Pacific/Auckland (the club, and the zone that actually
 * separates the fixed parse from the broken one) and a west-of-UTC zone (which
 * separates it in the other direction). `withTimeZone` restores by ASSIGNMENT
 * rather than by deleting, so no zone leaks into the next suite in the worker.
 */

import { describe, expect, it } from "vitest";

import {
  buildXeroContactCompanyNumberPatch,
  formatXeroContactDateOfBirth,
  parseXeroContactDateOfBirth,
} from "@/lib/xero-contact-date-of-birth";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * The three host zones that decide this module's behaviour: the CI runner, the
 * club's own server pin, and a deployment west of UTC. A stored date of birth
 * is a calendar day at UTC midnight (INV-DATE-024), so every assertion below
 * must hold identically in all three — that is the property, not an
 * implementation detail.
 */
const RUNNER_ZONES = ["UTC", "Pacific/Auckland", "America/Denver"] as const;

function inEveryRunnerZone(assert: (zone: string) => void): void {
  for (const zone of RUNNER_ZONES) {
    withTimeZone(zone, () => assert(zone));
  }
}

describe("parseXeroContactDateOfBirth", () => {
  it("stores UTC midnight on the day the member was born, not the evening before, in any host zone", () => {
    inEveryRunnerZone((zone) => {
      const parsed = parseXeroContactDateOfBirth("15/06/1985");

      // The discriminating assertion. Under the old local-midnight parse this
      // was 1985-06-14T12:00:00.000Z with the host in Pacific/Auckland and
      // 1985-06-15T06:00:00.000Z with the host in America/Denver — and, on a
      // UTC host, exactly the value below, which is why a suite that did not
      // force the zone proved nothing on CI.
      expect(
        parsed?.toISOString(),
        `parsed the wrong instant with the host zone forced to ${zone}`,
      ).toBe("1985-06-15T00:00:00.000Z");
    });
  });

  it("keeps a 1 January birthday in its own year, in any host zone", () => {
    inEveryRunnerZone((zone) => {
      const parsed = parseXeroContactDateOfBirth("01/01/2000");

      // The year-boundary case. The old parse stored 1999-12-31T11:00:00.000Z
      // under the club's own pin, so the error moved the YEAR as well as the
      // day — a member born on the first of the millennium was recorded as born
      // in the previous one.
      expect(
        parsed?.toISOString(),
        `parsed the wrong instant with the host zone forced to ${zone}`,
      ).toBe("2000-01-01T00:00:00.000Z");
    });
  });

  it("stores the same day whether or not the birthday falls in New Zealand daylight time", () => {
    // The two live shapes came from this. New Zealand keeps UTC+12 in standard
    // time and UTC+13 in daylight time, and a local midnight is stored as
    // (local 00:00 - offset), so a June birthday landed on the previous day at
    // 12:00 UTC and a March one at 11:00 UTC — the six `11:00` and four `12:00`
    // rows measured in production. Neither offset may survive into the stored
    // value.
    inEveryRunnerZone(() => {
      expect(parseXeroContactDateOfBirth("14/06/1985")?.toISOString()).toBe(
        "1985-06-14T00:00:00.000Z",
      );
      expect(parseXeroContactDateOfBirth("15/03/2010")?.toISOString()).toBe(
        "2010-03-15T00:00:00.000Z",
      );
    });
  });

  it("refuses everything that is not this club's date-of-birth shape", () => {
    expect(parseXeroContactDateOfBirth(null)).toBeNull();
    expect(parseXeroContactDateOfBirth(undefined)).toBeNull();
    expect(parseXeroContactDateOfBirth("")).toBeNull();
    // A real New Zealand Business Number, which is what the field is for.
    expect(parseXeroContactDateOfBirth("9429041234567")).toBeNull();
    expect(parseXeroContactDateOfBirth("1985-06-15")).toBeNull();
    expect(parseXeroContactDateOfBirth("5/6/1985")).toBeNull();
  });

  it("trims, so the guard and the six importers cannot disagree about one stored string", () => {
    // The trim lives in this reader rather than at any call site. It used to
    // live only in `buildXeroContactCompanyNumberPatch`, so a Xero field
    // holding " 15/06/1985" was `null` to every importer — not a date of birth
    // — and simultaneously a date the guard was willing to overwrite. Same
    // string, two answers, which is the disagreement this module exists to end.
    expect(parseXeroContactDateOfBirth(" 15/06/1985")?.toISOString()).toBe(
      "1985-06-15T00:00:00.000Z",
    );
    expect(parseXeroContactDateOfBirth("15/06/1985 ")?.toISOString()).toBe(
      "1985-06-15T00:00:00.000Z",
    );
    expect(parseXeroContactDateOfBirth("  ")).toBeNull();
    // And a padded value the reader accepts is one the guard must NOT
    // overwrite, because it IS a date of birth.
    expect(
      buildXeroContactCompanyNumberPatch(
        new Date("1990-01-01T00:00:00.000Z"),
        " 15/06/1985",
      ),
    ).toEqual({ companyNumber: "01/01/1990" });
    // A padded NZBN is still an NZBN.
    expect(
      buildXeroContactCompanyNumberPatch(
        new Date("1990-01-01T00:00:00.000Z"),
        " 9429041234567 ",
      ),
    ).toEqual({});
  });

  it("refuses a day that does not exist rather than rolling it over, which is a DELIBERATE tightening", () => {
    // Not parity with the four predecessors — every one of them rolled over
    // silently, and the values on the right are what they used to store:
    //
    //   Date.UTC(1990, 1, 31)           -> 1990-03-03
    //   new Date("1990-02-31T00:00:00") -> 1990-03-03
    //   Date.UTC(1990, 12, 1)           -> 1991-01-01
    //
    // So a Xero contact reading `31/02/1990` produced a stored birthday of
    // 3 March, and `01/13/1990` — a US-ordered date an administrator could
    // plausibly type — produced 1 January 1991. A field nobody can read as a
    // calendar day is not a date of birth, and importing none is better than
    // inventing one.
    expect(parseXeroContactDateOfBirth("31/02/1990")).toBeNull();
    expect(parseXeroContactDateOfBirth("31/04/1990")).toBeNull();
    expect(parseXeroContactDateOfBirth("01/13/1990")).toBeNull();
    expect(parseXeroContactDateOfBirth("06/15/1985")).toBeNull();
    expect(parseXeroContactDateOfBirth("12/34/5678")).toBeNull();
    expect(parseXeroContactDateOfBirth("00/00/0000")).toBeNull();
    expect(parseXeroContactDateOfBirth("99/99/9999")).toBeNull();
    // A real leap day still is a date of birth.
    expect(parseXeroContactDateOfBirth("29/02/1988")?.toISOString()).toBe(
      "1988-02-29T00:00:00.000Z",
    );
    expect(parseXeroContactDateOfBirth("29/02/1989")).toBeNull();
  });
});

describe("formatXeroContactDateOfBirth", () => {
  it("renders the stored day as dd/mm/yyyy, zero-padded, in any host zone", () => {
    inEveryRunnerZone((zone) => {
      expect(
        formatXeroContactDateOfBirth(new Date("1985-06-05T00:00:00.000Z")),
        `formatted the wrong day with the host zone forced to ${zone}`,
      ).toBe("05/06/1985");
      expect(
        formatXeroContactDateOfBirth(new Date("2000-01-01T00:00:00.000Z")),
      ).toBe("01/01/2000");
    });
  });

  it("reads the day the column actually holds, never a day recovered through the club zone", () => {
    // The value below is a date of birth that has NOT been repaired: the
    // local-midnight shape, still sitting an hour-count before UTC midnight.
    // `formatDateOnlyForTimeZone(value, "Pacific/Auckland")` would report
    // 15/06/1985 for it and look more careful for doing so. It is the wrong
    // rule, and this assertion is what stops the module being "tidied" into it:
    // the column's contract is UTC midnight (INV-DATE-024), the migration is
    // what repairs a row that breaks it, and a club deployed WEST of UTC would
    // have every correctly stored birthday moved a day by the zone-based
    // reading. A UTC-midnight input cannot tell the two apart, because New
    // Zealand is east of UTC and they agree there.
    inEveryRunnerZone((zone) => {
      expect(
        formatXeroContactDateOfBirth(new Date("1985-06-14T12:00:00.000Z")),
        `formatted through a zone rather than in UTC, host zone ${zone}`,
      ).toBe("14/06/1985");
    });
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

  it("has nothing to send for a year outside the four-digit form, rather than the word `undefined`", () => {
    // `formatDateOnly` is `toISOString().slice(0, 10)`, and ECMAScript renders
    // an expanded year as a sign and six digits — so the largest representable
    // Date slices to "+275760-09" and the naive split composes
    // "undefined/09/+275760". Unreachable through today's writers; one
    // comparison is cheaper than the day somebody writes that into a contact.
    expect(formatXeroContactDateOfBirth(new Date(8.64e15))).toBeNull();
    expect(formatXeroContactDateOfBirth(new Date(-8.64e15))).toBeNull();
  });
});

describe("buildXeroContactCompanyNumberPatch", () => {
  const dateOfBirth = new Date("1985-06-15T00:00:00.000Z");

  it("sends the date of birth when Xero is KNOWN to hold nothing", () => {
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

  it("sends NOTHING when nothing is known about the field", () => {
    // The blocker this replaced. `undefined` used to mean "write", justified by
    // "a contact this app created can hold nothing there but this app's own
    // writes" — and that premise is false. `findOrCreateXeroContact` links a
    // member onto a PRE-EXISTING Xero contact by email match, and failing that
    // by exact-name match, and no step on that path writes a contact-cache row.
    // So a contact carrying a genuine New Zealand Business Number an
    // administrator typed in Xero reaches an update as "no cache row", and the
    // old reading replaced that number with a birthday, unrecoverably from this
    // system. Absence of evidence is not permission.
    expect(buildXeroContactCompanyNumberPatch(dateOfBirth)).toEqual({});
    expect(buildXeroContactCompanyNumberPatch(dateOfBirth, undefined)).toEqual(
      {},
    );
    expect(
      Object.hasOwn(
        buildXeroContactCompanyNumberPatch(dateOfBirth),
        "companyNumber",
      ),
    ).toBe(false);
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

  it("asks the reader whether the field is a date, not whether it merely looks like one", () => {
    // The guard used to test a `dd/mm/yyyy` PATTERN while the importer tested
    // whether the day exists, so the module held two disagreeing answers to
    // "is this field a date of birth?" — and every value below lost that
    // disagreement: pattern-shaped, unreadable as a day, and overwritten. The
    // US-ordered one is the realistic case, because it is what an administrator
    // typing an American date into Xero produces.
    for (const notADate of [
      "12/34/5678",
      "31/02/1990",
      "00/00/0000",
      "99/99/9999",
      "06/15/1985",
    ]) {
      expect(
        buildXeroContactCompanyNumberPatch(dateOfBirth, notADate),
        `${notADate} is not a date this app can read, so it must not be overwritten`,
      ).toEqual({});
    }
  });
});
