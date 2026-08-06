import { describe, expect, it } from "vitest";
import { calendarMonthDirection } from "../../../e2e/helpers/calendar-navigation";

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
});
