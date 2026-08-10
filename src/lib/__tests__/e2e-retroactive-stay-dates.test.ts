import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  pastStayLeftoverCheckIns,
  pastStayWindowForAttempt,
  seasonForWindow,
} from "../../../e2e/helpers/stay-dates";
import { DEMO_BOOKING_WINDOWS } from "../../../prisma/e2e-fixtures";

describe("admin retroactive booking retry windows (#2610)", () => {
  it("gives every hosted Playwright attempt distinct past member nights", () => {
    const windows = [0, 1, 2].map((retry) =>
      pastStayWindowForAttempt(retry),
    );

    expect(windows.map((window) => window.checkIn)).toEqual([
      "2026-06-24",
      "2026-06-20",
      "2026-06-16",
    ]);
    expect(new Set(windows.flatMap((window) => window.nights)).size).toBe(6);
    expect(windows.every((window) => window.checkOut < "2026-07-01")).toBe(
      true,
    );
    expect(windows.map(seasonForWindow)).toEqual([
      "winter",
      "winter",
      "winter",
    ]);
    expect(
      windows.every(
        (window) =>
          window.checkIn >= DEMO_BOOKING_WINDOWS.aliceDraft.checkOut ||
          window.checkOut <= DEMO_BOOKING_WINDOWS.aliceDraft.checkIn,
      ),
    ).toBe(true);
  });

  it("fails closed rather than borrowing another attempt's blocked window", () => {
    expect(() =>
      pastStayWindowForAttempt(0, [["2026-06-24", "2026-06-26"]]),
    ).toThrow(/No conflict-free seeded past window/);
  });

  it("fails closed outside Playwright's configured retry range", () => {
    expect(() => pastStayWindowForAttempt(-1)).toThrow(
      /integer from 0 to 2/,
    );
    expect(() => pastStayWindowForAttempt(1.5)).toThrow(
      /integer from 0 to 2/,
    );
    expect(() => pastStayWindowForAttempt(3)).toThrow(
      /integer from 0 to 2/,
    );
  });

  it("threads the actual retry number into the browser journey", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "e2e/admin-retroactive-booking.spec.ts"),
      "utf8",
    );

    expect(source).toContain(
      "pastStayWindowForAttempt(testInfo.retry, SEEDED_BLOCKED_RANGES)",
    );
  });
});

describe("admin retroactive booking leftover sweep (#2625)", () => {
  // A two-night stay checking in on `c` occupies nights `c` and `c + 1`, so it
  // collides with an attempt window at offset `o` (nights `o`, `o + 1`) exactly
  // when `c` is `o - 1`, `o` or `o + 1`. This is the independent restatement of
  // that arithmetic, against the frozen clock.
  const dayOffset = (offsetDays: number): string => {
    const day = new Date();
    day.setDate(day.getDate() + offsetDays);
    const y = day.getFullYear();
    const m = String(day.getMonth() + 1).padStart(2, "0");
    const d = String(day.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };

  it("sweeps every check-in that can still hold one of this run's nights", () => {
    const swept = pastStayLeftoverCheckIns();

    // Today's own three attempts, plus a day either side of each: yesterday's
    // run (the -8/-12/-16 case the issue observed on a real stack) and an
    // attempt/retry pair that straddled NZ midnight.
    const mustCover = [-7, -11, -15].flatMap((offset) =>
      [offset - 1, offset, offset + 1].map(dayOffset),
    );
    for (const checkIn of mustCover) {
      expect(swept, `sweep must cover ${checkIn}`).toContain(checkIn);
    }

    // Contiguous -16…-6 on any run date, oldest first.
    expect(swept).toEqual([
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
      "2026-06-23",
      "2026-06-24",
      "2026-06-25",
    ]);
    expect(new Set(swept).size).toBe(swept.length);
  });

  it("covers each attempt's own window, so a re-run is never self-blocked", () => {
    const swept = pastStayLeftoverCheckIns();
    for (const retry of [0, 1, 2]) {
      expect(swept).toContain(pastStayWindowForAttempt(retry).checkIn);
    }
  });

  it("never reaches Alice's seeded DRAFT booking", () => {
    // The sweep matches the booker as OWNER, and Alice also owns a seeded DRAFT
    // that other specs rely on. Clearing it would trade one dirty-database bug
    // for another, so the band must stay clear of that window entirely.
    const swept = pastStayLeftoverCheckIns();
    const { checkIn, checkOut } = DEMO_BOOKING_WINDOWS.aliceDraft;
    for (const day of swept) {
      expect(day >= checkOut || day < checkIn, `${day} vs seeded aliceDraft`).toBe(
        true,
      );
    }
  });

  it("is wired into the spec's idempotent group beforeAll", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "e2e/admin-retroactive-booking.spec.ts"),
      "utf8",
    );

    // The sweep is worthless outside a hook that re-runs on every attempt, and
    // worthless if it only covers attempt 0's window.
    const beforeAll = source.slice(source.indexOf("test.beforeAll"));
    expect(beforeAll).toContain("cancelMemberBookingsOnDate(adminContext.request, {");
    expect(beforeAll).toContain("checkIn: pastStayLeftoverCheckIns(),");
  });
});
