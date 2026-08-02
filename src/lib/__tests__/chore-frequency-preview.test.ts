import { describe, expect, it } from "vitest";

import {
  computeFrequencyInfo,
  type ChoreFrequencyPreviewInput,
} from "../chore-frequency-preview";
import { withTimeZone as withHostTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * #2478 — the lodge kiosk's "is this chore due tonight?" preview.
 *
 * This is the one place in the chore-roster work that an operator actually
 * notices going wrong, because it runs on whatever browser the kiosk is: the
 * setup screen reads the gap between two roster nights and either offers a
 * chore or explains that it is not due yet. Both nights are calendar days, so
 * the gap must be counted between UTC midnights. Counted between the BROWSER's
 * local midnights, a spring-forward sitting between the two nights left the gap
 * an hour short of a whole number of days, `Math.floor` lost a day, and a chore
 * that was due tonight was held back as "next due in 1 day".
 */

// `withHostTimeZone` (aliased from the shared `withTimeZone` helper) restores
// the host zone by ASSIGNING it back, not by deleting `process.env.TZ` — a
// bare delete does not invalidate Node's cached zone and would leave the
// whole worker on whichever zone this file set last (#2485).

function makeChore(
  overrides: Partial<ChoreFrequencyPreviewInput> = {},
): ChoreFrequencyPreviewInput {
  return { id: "c1", frequencyMode: "DAILY", ...overrides };
}

describe("computeFrequencyInfo — EVERY_X_DAYS across the NZ clock change", () => {
  const everyThreeDays = makeChore({
    frequencyMode: "EVERY_X_DAYS",
    frequencyDays: 3,
  });

  it("counts three whole nights across the spring-forward, so the chore is due", () => {
    // New Zealand moves to NZDT on Sunday 27 September 2026. A chore last done
    // on the 26th, on a three-day cycle, is due again on the 29th.
    withHostTimeZone("Pacific/Auckland", () => {
      // Harness guard, and the bug itself: on this host the two LOCAL midnights
      // are 71 hours apart, not 72, because an hour disappeared between them.
      const naiveGapDays = Math.floor(
        (new Date("2026-09-29T00:00:00").getTime() -
          new Date("2026-09-26T00:00:00").getTime()) /
          86_400_000,
      );
      expect(naiveGapDays).toBe(2);

      const info = computeFrequencyInfo(
        everyThreeDays,
        { c1: "2026-09-26" },
        "2026-09-29",
      );
      expect(info).toEqual({ choreId: "c1", excluded: false, reason: null });
    });
  });

  it("still holds the chore back the night before it is due", () => {
    // The night before — genuinely two nights on, not three. The fix must not
    // simply make everything due.
    withHostTimeZone("Pacific/Auckland", () => {
      const info = computeFrequencyInfo(
        everyThreeDays,
        { c1: "2026-09-26" },
        "2026-09-28",
      );
      expect(info).toEqual({
        choreId: "c1",
        excluded: true,
        reason: "Last done 2 days ago, next due in 1 day",
      });
    });
  });

  it("counts the 25-hour autumn night correctly too", () => {
    // The fall-back on Sunday 5 April 2026 leaves the gap an hour LONG, which
    // always floored correctly — pinned so the fix is not credited with
    // repairing something that was never broken.
    withHostTimeZone("Pacific/Auckland", () => {
      const info = computeFrequencyInfo(
        everyThreeDays,
        { c1: "2026-04-03" },
        "2026-04-06",
      );
      expect(info.excluded).toBe(false);
    });
  });

  it("offers a chore that has never been rostered", () => {
    expect(computeFrequencyInfo(everyThreeDays, {}, "2026-09-29").excluded).toBe(
      false,
    );
  });
});

describe("computeFrequencyInfo — SPECIFIC_DAYS weekday", () => {
  const mondayOnly = makeChore({
    frequencyMode: "SPECIFIC_DAYS",
    frequencyDaysOfWeek: [1],
  });

  // Two hosts on opposite sides of UTC. The guarded numbers are what the host
  // clock makes of the roster night: on Los Angeles, UTC midnight on Monday the
  // 6th is still Sunday evening locally, so a preview that read the weekday off
  // the host would offer the wrong night.
  it.each([
    ["Pacific/Auckland", 1],
    ["America/Los_Angeles", 0],
  ] as const)(
    "reads the roster night's weekday the same way on a %s host",
    (timeZone, hostDayOfMondayNight) => {
      withHostTimeZone(timeZone, () => {
        expect(new Date("2026-04-06T00:00:00.000Z").getDay()).toBe(
          hostDayOfMondayNight,
        );

        // 2026-04-06 is a Monday; 2026-04-05 the Sunday before it.
        expect(computeFrequencyInfo(mondayOnly, {}, "2026-04-06")).toEqual({
          choreId: "c1",
          excluded: false,
          reason: null,
        });
        expect(computeFrequencyInfo(mondayOnly, {}, "2026-04-05")).toEqual({
          choreId: "c1",
          excluded: true,
          reason: "Scheduled for Mon only",
        });
      });
    },
  );

  it("names every scheduled day in the reason, Sunday as ISO day 7", () => {
    const thursdayAndSunday = makeChore({
      frequencyMode: "SPECIFIC_DAYS",
      frequencyDaysOfWeek: [4, 7],
    });
    // 2026-04-05 is a Sunday, so the Thu/Sun chore is offered on it.
    expect(computeFrequencyInfo(thursdayAndSunday, {}, "2026-04-05").excluded).toBe(
      false,
    );
    expect(computeFrequencyInfo(thursdayAndSunday, {}, "2026-04-06")).toEqual({
      choreId: "c1",
      excluded: true,
      reason: "Scheduled for Thu, Sun only",
    });
  });
});

describe("computeFrequencyInfo — fallbacks", () => {
  it("treats a daily chore, a missing mode, and an interval below 2 as always due", () => {
    for (const chore of [
      makeChore(),
      makeChore({ frequencyMode: null }),
      makeChore({ frequencyMode: "EVERY_X_DAYS", frequencyDays: 1 }),
      makeChore({ frequencyMode: "SPECIFIC_DAYS", frequencyDaysOfWeek: [] }),
    ]) {
      expect(
        computeFrequencyInfo(chore, { c1: "2026-09-28" }, "2026-09-29"),
      ).toEqual({ choreId: "c1", excluded: false, reason: null });
    }
  });
});
