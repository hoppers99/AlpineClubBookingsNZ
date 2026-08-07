import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
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
