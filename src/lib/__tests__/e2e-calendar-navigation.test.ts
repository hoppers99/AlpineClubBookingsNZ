import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  calendarMonthDirection,
  calendarMonthHeading,
} from "../../../e2e/helpers/calendar-navigation";

const source = (file: string): string =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("retroactive-booking calendar navigation", () => {
  it("moves forward when a past stay crosses from July into August", () => {
    expect(calendarMonthDirection("2026-07-30", "2026-08-01")).toBe("next");
  });

  it("distinguishes the current and previous month", () => {
    expect(calendarMonthDirection("2026-08-06", "2026-08-01")).toBe("current");
    expect(calendarMonthDirection("2026-08-06", "2026-07-30")).toBe("previous");
  });

  it("rejects malformed dates instead of choosing the wrong direction", () => {
    expect(() => calendarMonthDirection("2026-08-06", "2026-13-01")).toThrow(
      "Expected a valid month",
    );
  });

  it("names the month the way the calendar heading does", () => {
    expect(calendarMonthHeading("2026-07-07")).toBe("July 2026");
    expect(calendarMonthHeading("2026-12-31")).toBe("December 2026");
  });
});

// #2626. The member past-days test timed out at 90 s on `locator.click: Target
// page, context or browser has been closed` while "stepping back" a three-hop
// loop that had, measurably, completed ZERO hops. Two things made that possible
// and each is pinned here, because both are invisible in a passing run.
describe("calendar month walk cannot burn a test budget (#2626)", () => {
  const walk = source("e2e/helpers/calendar-navigation.ts");
  const spec = source("e2e/admin-retroactive-booking.spec.ts");

  it("checks the nav control is actionable before clicking, and bounds the click", () => {
    // `playwright.config.ts` sets no `actionTimeout`, so Playwright's default of
    // 0 — wait until the TEST is killed — applies to every bare `click()`. A hop
    // count bounds the number of clicks, never the time, so the walk's own
    // arrival assertion is unreachable unless each click is bounded too.
    expect(walk).toContain("toBeEnabled()");
    expect(walk).toMatch(/\.click\(\{\s*timeout:/);
    expect(walk).toContain("never became actionable");
    expect(walk).toContain("calendar never reached");
  });

  it("leaves no hand-rolled walk or gate dismissal in the retroactive spec", () => {
    // The gate opens on its PROFILE step for the demo-seed personas, which the
    // spec's private copy had no branch for — so it returned with the modal still
    // over the calendar. The shared helper is the only correct one.
    expect(spec).toContain("completeMemberDetailsGateIfShown");
    expect(spec).not.toContain("dismissDetailsGateIfShown");
    // Both of this spec's walks go through the shared, bounded one.
    expect(spec).not.toMatch(/getByRole\("button", \{ name: \/Prev\/ \}\)/);
    expect(spec.match(/walkCalendarToMonth\(page, \{/g) ?? []).toHaveLength(2);
  });

  it("keeps the shared forward walk on the same bounded path", () => {
    const booking = source("e2e/helpers/booking.ts");
    expect(booking).toContain("walkCalendarToMonth(page, {");
    expect(booking).not.toMatch(/getByRole\("button", \{ name: \/Next\/ \}\)/);
  });

  // The walk bounds its own hops, then hands the DAY click back to its caller.
  // Both callers are checked here because an unbounded one is invisible in a
  // passing run and costs the whole 90 s budget in a failing one: arrival being
  // asserted removes the common cause (wrong month) but not a day that resolves
  // and is not actionable — disabled as past, out of season, availability still
  // loading. Grep both call sites, since the bound has no runtime enforcement.
  it("bounds the day click each walk hands back to its caller", () => {
    const dayClick =
      /calendarDayLabel\(dateOnly\) \}\)\s*\.click\(\{\s*timeout: CALENDAR_CLICK_TIMEOUT_MS,?\s*\}\)/;
    const bareDayClick = /calendarDayLabel\(\w+\) \}\)\s*\.click\(\)/;
    for (const file of [
      "e2e/helpers/booking.ts",
      "e2e/admin-retroactive-booking.spec.ts",
    ]) {
      const text = source(file);
      expect(text, `${file} must bound its calendar day click`).toMatch(dayClick);
      expect(text, `${file} has an unbounded calendar day click`).not.toMatch(
        bareDayClick,
      );
    }
    // One constant for the hop click and the day click, so they cannot drift.
    expect(walk).toContain("export const CALENDAR_CLICK_TIMEOUT_MS = 15_000;");
  });

  // `direction: "current"` has no control that keeps the calendar where it is —
  // the walk maps anything not "previous" onto /Next/ — and the loop's
  // `isVisible()` probe does not retry, so a transient miss used to click "Next"
  // and walk AWAY from a month already on screen. `selectPastCalendarDay` yields
  // "current" whenever the check-out shares the check-in's month, the common case.
  it("clicks nothing when the target month is the one already displayed", () => {
    expect(walk).toMatch(/direction === "current" \? 0 : maxHops/);
    expect(walk).toMatch(/for \(; hops < clickableHops; hops \+= 1\)/);
  });
});
