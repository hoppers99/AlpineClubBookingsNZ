import { describe, expect, it } from "vitest";
import {
  MAX_RANGE_NIGHTS,
  boardWindowError,
  fitBoardWindow,
  stepBoardWindowByMonths,
} from "@/app/(admin)/admin/bed-allocation/_components/board-window";
import { addMonthsDateOnly, formatDateOnly, parseDateOnly } from "@/lib/date-only";

/*
 * #2251: clampRange() used to shorten a too-long board window without saying so.
 * These pin the two honest replacements — refuse what the admin typed, label
 * what the app derived — so silent truncation cannot come back.
 */

describe("boardWindowError", () => {
  it("accepts a window inside the board's read limit", () => {
    expect(boardWindowError("2026-06-01", "2026-06-08")).toBeNull();
    expect(boardWindowError("2026-06-01", "2026-07-02")).toBeNull();
  });

  it("refuses a window longer than the limit instead of shortening it", () => {
    const error = boardWindowError("2026-06-01", "2026-09-01");
    expect(error).toContain(`at most ${MAX_RANGE_NIGHTS} nights`);
    expect(error).toContain("92");
  });

  it("refuses a date out that is not after date in", () => {
    expect(boardWindowError("2026-06-08", "2026-06-01")).toBe(
      "Date Out must be after Date In.",
    );
    expect(boardWindowError("2026-06-08", "2026-06-08")).toBe(
      "Date Out must be after Date In.",
    );
  });

  it("refuses a malformed date", () => {
    expect(boardWindowError("not-a-date", "2026-06-08")).toBe(
      "Enter a valid Date In and Date Out.",
    );
  });
});

describe("fitBoardWindow", () => {
  it("leaves a window inside the limit alone and reports no narrowing", () => {
    expect(fitBoardWindow("2026-06-01", "2026-06-08")).toEqual({
      toDate: "2026-06-08",
      narrowed: false,
    });
  });

  it("narrows a derived window to the limit and SAYS it narrowed", () => {
    // A deep link carrying a 92-night booking, or the focused-booking snap.
    expect(fitBoardWindow("2026-06-01", "2026-09-01")).toEqual({
      toDate: "2026-07-02",
      narrowed: true,
    });
  });

  it("pulls a backwards window forward to a single night without claiming it narrowed", () => {
    expect(fitBoardWindow("2026-06-08", "2026-06-01")).toEqual({
      toDate: "2026-06-09",
      narrowed: false,
    });
  });
});

describe("stepBoardWindowByMonths", () => {
  it("moves the whole window forward a calendar month", () => {
    expect(stepBoardWindowByMonths("2026-06-01", "2026-06-08", 1)).toEqual({
      fromDate: "2026-07-01",
      toDate: "2026-07-08",
      narrowed: false,
    });
  });

  it("moves the whole window back a calendar month", () => {
    expect(stepBoardWindowByMonths("2026-07-01", "2026-07-08", -1)).toEqual({
      fromDate: "2026-06-01",
      toDate: "2026-06-08",
      narrowed: false,
    });
  });

  it("narrows back to the limit, and says so, when month lengths widen the window", () => {
    // 31 Jan clamps to 28 Feb while 3 Mar steps to 3 Apr, so the stepped window
    // would be 35 nights — narrowed to 31, with the note raised.
    const stepped = stepBoardWindowByMonths("2026-01-31", "2026-03-03", 1);
    expect(stepped.fromDate).toBe("2026-02-28");
    expect(stepped.toDate).toBe("2026-03-31");
    expect(stepped.narrowed).toBe(true);
  });
});

describe("addMonthsDateOnly", () => {
  it("steps whole months in UTC date-only space", () => {
    expect(formatDateOnly(addMonthsDateOnly(parseDateOnly("2026-06-15"), 1))).toBe(
      "2026-07-15",
    );
    expect(
      formatDateOnly(addMonthsDateOnly(parseDateOnly("2026-06-15"), -1)),
    ).toBe("2026-05-15");
  });

  it("crosses a year boundary in both directions", () => {
    expect(
      formatDateOnly(addMonthsDateOnly(parseDateOnly("2026-12-10"), 1)),
    ).toBe("2027-01-10");
    expect(
      formatDateOnly(addMonthsDateOnly(parseDateOnly("2026-01-10"), -1)),
    ).toBe("2025-12-10");
  });

  it("clamps the day to the target month rather than overflowing", () => {
    expect(
      formatDateOnly(addMonthsDateOnly(parseDateOnly("2026-01-31"), 1)),
    ).toBe("2026-02-28");
    // 2028 is a leap year.
    expect(
      formatDateOnly(addMonthsDateOnly(parseDateOnly("2028-01-31"), 1)),
    ).toBe("2028-02-29");
    expect(
      formatDateOnly(addMonthsDateOnly(parseDateOnly("2026-05-31"), 1)),
    ).toBe("2026-06-30");
  });
});
