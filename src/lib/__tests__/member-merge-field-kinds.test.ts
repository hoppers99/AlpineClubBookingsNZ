import { describe, expect, it } from "vitest";

import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";
import {
  formatMergeFieldValue,
  mergeFieldValueKind,
  MERGE_FIELD_VALUE_KINDS,
  type MergeFieldValueKind,
} from "@/lib/member-merge-field-kinds";
import { mergeMemberFields } from "@/lib/member-merge";

/**
 * The member-merge comparison screen dates each value by what the field MEANS,
 * not by what its runtime type is (#2860, INV-DATE-019 / INV-DATE-010).
 *
 * The screen is the last thing a Full Admin reads before an IRREVERSIBLE merge,
 * and it exists so a human can judge which of two records should survive. It
 * used to truncate every date-shaped value to its UTC day, so `photoUpdatedAt`
 * and `hutLeaderEligibleAt` — real instants — read as the PREVIOUS day for
 * roughly the first half of every New Zealand day. `photoUpdatedAt` is a recency
 * signal by construction, so the wrong day landed exactly where the decision is
 * made.
 *
 * The fix is not "swap the helper". The two kinds need OPPOSITE operations:
 *
 * - an instant must be read on the club's calendar (`formatDateOnlyForTimeZone`);
 * - a calendar day is already pinned at UTC midnight and must be TRUNCATED
 *   (`formatDateOnly`) — routing it through the club-zone formatter agrees in
 *   New Zealand, which is why an NZ-only assertion cannot catch it, and is a day
 *   wrong for a club sitting behind UTC.
 *
 * Both halves are proved below, and the discrimination is verified by calling
 * the formatters with EXPLICIT zones rather than by setting `TZ`: `TZ` also
 * moves `APP_TIME_ZONE` (docs/TESTING.md rule 6), so a suite that sets it goes
 * red on the premise guard and proves nothing about the instants themselves.
 *
 * The instants are chosen so a wrong zone FAILS them. A comfortable mid-morning
 * instant passes under any zone from roughly UTC+10 up and pins nothing, so each
 * case is either the first instant of a club day or 00:30 NZDT, and each carries
 * a companion one millisecond EARLIER whose club day is the previous one. The
 * pair brackets the offset from both sides: a shallower zone gets the first
 * instant wrong, a deeper zone gets the companion wrong.
 */

const CLUB_DAY_CASES = [
  {
    label: "NZST (UTC+12), the first instant of a club day",
    instant: new Date("2026-06-14T12:00:00.000Z"),
    utcDay: "2026-06-14",
    clubDay: "2026-06-15",
    // One millisecond before the club day starts.
    justBefore: new Date("2026-06-14T11:59:59.999Z"),
    justBeforeClubDay: "2026-06-14",
    // Shallower than UTC+12, no daylight saving: reads the boundary instant as
    // the UTC day.
    shallowZone: "Australia/Brisbane",
    // Deeper than UTC+13, no daylight saving: has already rolled over at the
    // companion instant.
    deeperZone: "Pacific/Kiritimati",
  },
  {
    label: "NZDT (UTC+13), 00:30 on a club day",
    instant: new Date("2026-01-14T11:30:00.000Z"),
    utcDay: "2026-01-14",
    clubDay: "2026-01-15",
    justBefore: new Date("2026-01-14T10:59:59.999Z"),
    justBeforeClubDay: "2026-01-14",
    // A FIXED UTC+12 with no daylight saving is 30 minutes short of the club
    // day here, which is what makes this case catch a zone that ignores NZDT.
    // (POSIX sign convention: `Etc/GMT-12` is UTC+12.)
    shallowZone: "Etc/GMT-12",
    deeperZone: "Pacific/Kiritimati",
  },
] as const;

// A calendar day as its writers store it: `yyyy-MM-dd` pinned to UTC midnight
// (`parseDateOnly` / `new Date("yyyy-MM-dd")`).
const CALENDAR_DAY = new Date("1985-06-15T00:00:00.000Z");
const CALENDAR_DAY_STRING = "1985-06-15";
// A zone BEHIND UTC. Nothing about the club is American; this is simply where
// the two operations stop agreeing, and the only place the calendar-day
// assertions become decidable.
const ZONE_BEHIND_UTC = "America/New_York";

describe("#2860 the premise: the club zone is New Zealand and each instant really is divergent", () => {
  it("runs with the club time zone actually set to New Zealand", () => {
    expectClubTimeZonePremise();
  });

  it.each(CLUB_DAY_CASES)(
    "$label: the UTC day is the day before the club day",
    ({ instant, utcDay, clubDay }) => {
      // The first reading IS the pre-#2860 renderer's operation, spelled out:
      // `value.toISOString().slice(0, 10)`. Both readings are executed rather
      // than asserted against each other as literals, so a fixture that drifted
      // out of the divergence window fails here instead of quietly passing.
      expect(instant.toISOString().slice(0, 10)).toBe(utcDay);
      expect(formatDateOnlyForTimeZone(instant)).toBe(clubDay);
    },
  );

  it.each(CLUB_DAY_CASES)(
    "$label: a SHALLOWER zone reads the same instant as the UTC day, so a wrong zone fails these tests",
    ({ instant, utcDay, shallowZone }) => {
      expect(formatDateOnlyForTimeZone(instant, shallowZone)).toBe(utcDay);
    },
  );

  it.each(CLUB_DAY_CASES)(
    "$label: one millisecond earlier is still the previous club day, and a DEEPER zone gets that wrong",
    ({ justBefore, justBeforeClubDay, clubDay, deeperZone }) => {
      expect(formatDateOnlyForTimeZone(justBefore)).toBe(justBeforeClubDay);
      // UTC+14 has already rolled over, so the pair brackets the club offset
      // from both sides rather than only proving "deep enough".
      expect(formatDateOnlyForTimeZone(justBefore, deeperZone)).toBe(clubDay);
    },
  );
});

describe("#2860 the other half of the premise: a calendar day is read by TRUNCATION, which is a DIFFERENT operation", () => {
  it("agrees with the club-zone formatter in New Zealand, which is exactly why an NZ-only assertion cannot decide it", () => {
    expect(formatDateOnly(CALENDAR_DAY)).toBe(CALENDAR_DAY_STRING);
    expect(formatDateOnlyForTimeZone(CALENDAR_DAY)).toBe(CALENDAR_DAY_STRING);
  });

  it("disagrees in a zone BEHIND UTC — the club-zone formatter would move a stored calendar day a day early", () => {
    // Verified by passing the zone explicitly, not by setting `TZ`. This is the
    // reason `dateOfBirth`, `lifeMemberDate` and `joinedDate` are deliberately
    // NOT routed through `formatDateOnlyForTimeZone` (INV-DATE-010).
    expect(formatDateOnly(CALENDAR_DAY)).toBe(CALENDAR_DAY_STRING);
    expect(formatDateOnlyForTimeZone(CALENDAR_DAY, ZONE_BEHIND_UTC)).toBe(
      "1985-06-14",
    );
  });
});

describe("#2860 every merged field is classified, and only merged fields are", () => {
  // The classification is only as good as its coverage: a merged field with no
  // declared kind would fall back to the raw value, and a stray declaration
  // would be classification nobody reads. Both directions are pinned against
  // what `mergeMemberFields` actually emits.
  const emittedFields = () => {
    // Populate BOTH sides of every merged field so no conditional row is
    // skipped: the photo group needs the master blank and the loser populated,
    // `hutLeaderEligibleAt` needs eligibility, and `joinedDate` is always
    // emitted.
    const master: Record<string, unknown> = {
      hutLeaderEligible: true,
      hutLeaderEligibleAt: new Date("2026-06-14T12:00:00.000Z"),
      joinedDate: new Date("2020-01-01T00:00:00.000Z"),
    };
    const loser: Record<string, unknown> = {
      photoImageId: "img_loser",
      photoUpdatedAt: new Date("2026-01-14T11:30:00.000Z"),
      photoUpdatedByMemberId: "member_loser",
      hutLeaderEligible: true,
      hutLeaderEligibleAt: new Date("2019-06-14T12:00:00.000Z"),
      joinedDate: new Date("2019-01-01T00:00:00.000Z"),
    };
    return mergeMemberFields(master, loser).diff.map((row) => row.field);
  };

  it("declares a kind for every field the merge emits", () => {
    const undeclared = emittedFields().filter(
      (field) => !(field in MERGE_FIELD_VALUE_KINDS),
    );
    expect(undeclared).toEqual([]);
  });

  it("declares no kind for a field the merge no longer emits", () => {
    const emitted = new Set(emittedFields());
    const strays = Object.keys(MERGE_FIELD_VALUE_KINDS).filter(
      (field) => !emitted.has(field),
    );
    expect(strays).toEqual([]);
  });

  it("classifies the three instants and the three calendar days as such", () => {
    // The classification is proved from the schema and the write paths in
    // `member-merge-field-kinds.ts`; this pins the conclusions so a later edit
    // cannot flip one silently. `lifeMemberDate` is a calendar day: every writer
    // validates `^\d{4}-\d{2}-\d{2}$` or calls `parseDateOnly`, and none stamps
    // a clock.
    expect(mergeFieldValueKind("photoUpdatedAt")).toBe("instant");
    expect(mergeFieldValueKind("hutLeaderEligibleAt")).toBe("instant");
    expect(mergeFieldValueKind("dateOfBirth")).toBe("calendarDay");
    expect(mergeFieldValueKind("lifeMemberDate")).toBe("calendarDay");
    expect(mergeFieldValueKind("joinedDate")).toBe("calendarDay");
    expect(mergeFieldValueKind("occupation")).toBe("plain");
  });

  it("falls back to the raw value for an unknown field, which can be odd but never a day wrong", () => {
    expect(mergeFieldValueKind("someFutureField")).toBe("plain");
  });
});

describe.each(CLUB_DAY_CASES)(
  "#2860 the merge comparison table — $label",
  ({ instant, utcDay, clubDay }) => {
    // One table, both receiver kinds: the photo group's `photoUpdatedAt` and the
    // hut-leader `hutLeaderEligibleAt` are instants; `dateOfBirth`,
    // `lifeMemberDate` and `joinedDate` are calendar days. They are asserted
    // together because the defect was a single generic formatter applied to all
    // of them, and the fix has to move one set without moving the other.
    const master: Record<string, unknown> = {
      photoImageId: null,
      photoUpdatedAt: null,
      photoUpdatedByMemberId: null,
      dateOfBirth: null,
      lifeMemberDate: null,
      hutLeaderEligible: false,
      hutLeaderEligibleAt: null,
      joinedDate: new Date("2021-03-08T00:00:00.000Z"),
    };
    const loser: Record<string, unknown> = {
      photoImageId: "img_loser",
      photoUpdatedAt: instant,
      photoUpdatedByMemberId: "member_loser",
      dateOfBirth: CALENDAR_DAY,
      lifeMemberDate: new Date("2018-11-02T00:00:00.000Z"),
      hutLeaderEligible: true,
      hutLeaderEligibleAt: instant,
      joinedDate: new Date("2019-07-01T00:00:00.000Z"),
    };

    const rowsByField = () => {
      const byField = new Map<
        string,
        { result: unknown; kind: MergeFieldValueKind }
      >();
      for (const row of mergeMemberFields(master, loser).diff) {
        byField.set(row.field, { result: row.result, kind: row.kind });
      }
      return byField;
    };

    const rendered = (field: string) => {
      const row = rowsByField().get(field);
      if (!row) throw new Error(`the merge emitted no ${field} row`);
      return formatMergeFieldValue(row.result, row.kind);
    };

    it("dates the duplicate's photo on the club's calendar day, not the UTC day", () => {
      expect(rendered("photoUpdatedAt")).toBe(clubDay);
      expect(rendered("photoUpdatedAt")).not.toBe(utcDay);
    });

    it("dates hut-leader eligibility on the club's calendar day, not the UTC day", () => {
      expect(rendered("hutLeaderEligibleAt")).toBe(clubDay);
      expect(rendered("hutLeaderEligibleAt")).not.toBe(utcDay);
    });

    it("leaves the stored calendar days exactly as stored", () => {
      expect(rendered("dateOfBirth")).toBe(CALENDAR_DAY_STRING);
      expect(rendered("lifeMemberDate")).toBe("2018-11-02");
      expect(rendered("joinedDate")).toBe("2019-07-01");
    });

    it("renders the same days from the ISO strings the browser actually receives", () => {
      // The page is a client component fed by `/merge/preview`, so every value
      // arrives as a JSON string, never a `Date`. That was the live arm of the
      // old formatter, so it is the arm that most needs pinning.
      const overTheWire = JSON.parse(
        JSON.stringify(mergeMemberFields(master, loser).diff),
      ) as { field: string; result: unknown; kind: MergeFieldValueKind }[];
      const display = (field: string) => {
        const row = overTheWire.find((r) => r.field === field);
        if (!row) throw new Error(`the merge emitted no ${field} row`);
        expect(typeof row.result).toBe("string");
        return formatMergeFieldValue(row.result, row.kind);
      };

      expect(display("photoUpdatedAt")).toBe(clubDay);
      expect(display("hutLeaderEligibleAt")).toBe(clubDay);
      expect(display("dateOfBirth")).toBe(CALENDAR_DAY_STRING);
      expect(display("lifeMemberDate")).toBe("2018-11-02");
      expect(display("joinedDate")).toBe("2019-07-01");
    });

    it("would move the calendar days too if they were routed through the club-zone formatter — proved from a club BEHIND UTC", () => {
      // The load-bearing test for the OTHER half of the fix, and the only one
      // that can fail the mutation "render calendar days with
      // formatDateOnlyForTimeZone as well". In New Zealand that mutation is
      // invisible: UTC midnight is midday NZ, the same calendar day. Rendering
      // the same table for a club sitting behind UTC separates them — the
      // instants follow that club's day, and the stored calendar days do not
      // move at all.
      const byField = rowsByField();
      const behind = (field: string) => {
        const row = byField.get(field);
        if (!row) throw new Error(`the merge emitted no ${field} row`);
        return formatMergeFieldValue(row.result, row.kind, ZONE_BEHIND_UTC);
      };

      expect(behind("dateOfBirth")).toBe(CALENDAR_DAY_STRING);
      expect(behind("lifeMemberDate")).toBe("2018-11-02");
      expect(behind("joinedDate")).toBe("2019-07-01");
      // And the instants DO follow the club they are read in, which is what
      // makes the line above a real distinction rather than a no-op.
      expect(behind("photoUpdatedAt")).toBe(
        formatDateOnlyForTimeZone(instant, ZONE_BEHIND_UTC),
      );
      expect(behind("photoUpdatedAt")).not.toBe(clubDay);
    });

    it("carries the kind on the row, so the browser cannot classify a value differently from the server", () => {
      const byField = rowsByField();
      expect(byField.get("photoUpdatedAt")?.kind).toBe("instant");
      expect(byField.get("hutLeaderEligibleAt")?.kind).toBe("instant");
      expect(byField.get("dateOfBirth")?.kind).toBe("calendarDay");
      expect(byField.get("lifeMemberDate")?.kind).toBe("calendarDay");
      expect(byField.get("joinedDate")?.kind).toBe("calendarDay");
      expect(byField.get("occupation")?.kind).toBe("plain");
    });
  },
);

describe("#2860 the non-date cells are untouched", () => {
  it("renders blanks, booleans and plain values as before", () => {
    expect(formatMergeFieldValue(null, "plain")).toBe("—");
    expect(formatMergeFieldValue(undefined, "calendarDay")).toBe("—");
    expect(formatMergeFieldValue("", "instant")).toBe("—");
    expect(formatMergeFieldValue(true, "plain")).toBe("Yes");
    expect(formatMergeFieldValue(false, "plain")).toBe("No");
    expect(formatMergeFieldValue("Engineer", "plain")).toBe("Engineer");
    expect(formatMergeFieldValue("MR", "plain")).toBe("MR");
  });

  it("shows an unparsable date-kinded value rather than a made-up day", () => {
    expect(formatMergeFieldValue("not a date", "instant")).toBe("not a date");
    expect(formatMergeFieldValue(new Date(NaN), "calendarDay")).toBe(
      "Invalid Date",
    );
  });
});
