/**
 * The frozen test clock (#2481, absorbing #2443).
 *
 * ## Why this exists
 *
 * Four times CI went red on `main` and on every open pull request at once
 * because the calendar moved on: #2426, #2401, #2443 and #2479. The shape is
 * always identical — a suite fixes a date ("a booking on 2026-08-01", "a link
 * that expires in 48 hours"), the code under test asks the REAL clock, and the
 * day the real date passes the fixture the suite starts failing with nothing in
 * any diff to blame. The vacuous variant is worse: a `not.toBe(403)` assertion
 * that starts passing off an unrelated 400 tests nothing at all.
 *
 * So every test run gets one fixed "today", installed from `vitest.setup.ts`
 * for every file, and no test can depend on what the real date happens to be.
 *
 * ## The instant, and why this one
 *
 * `2026-07-01T00:00:00.000Z` (owner decision, 2 Aug 2026). Midnight UTC is
 * midday in NZ (12:00 NZST), so the runner's own zone and the club's zone agree
 * on the calendar date — the property the #2426/#2401 fixes already proved, and
 * the reason a "safer looking" midnight-NZ instant would in fact be worse. It
 * sits before every mid-2026 fixture in the repo. **It never advances**: the
 * canary below owns forward-looking risk, not a per-release bump.
 *
 * ## Only `Date` is faked, never timers
 *
 * `toFake: ["Date"]` — `setTimeout`/`setInterval`/`queueMicrotask` and
 * `performance.now()` stay real, so awaited promises resolve normally and
 * elapsed-time measurements still work. This is the approach #2479 proved on
 * `payment-link.test.ts` before it was generalised here.
 *
 * ## Overriding the instant (the rollover canary)
 *
 * `.github/workflows/clock-rollover-canary.yml` re-runs the whole unit suite
 * with the clock wound forward, so anything that escapes the freeze surfaces on
 * a nightly job instead of turning `main` red on some arbitrary morning:
 *
 * - `TEST_CLOCK_OFFSET_DAYS` — integer days added to the base instant (may be
 *   negative). The canary uses `1`, `30` and `365`.
 * - `TEST_CLOCK_ISO` — an absolute ISO-8601 instant replacing the base entirely.
 *   Handy locally to reproduce a specific rollover, e.g.
 *   `TEST_CLOCK_ISO=2026-12-02T00:00:00.000Z npx vitest run <suite>` reproduces
 *   the #2443 breakage on demand.
 *
 * Both are read fresh on every `frozenTestNow()` call and validated loudly — a
 * typo fails the run rather than silently falling back to the base instant.
 *
 * ## Opting out
 *
 * A file that genuinely needs the real wall clock calls
 * `optOutOfFrozenClock("<reason>")` at module top level. The reason is
 * mandatory, and `frozen-test-clock.test.ts` pins the exact list and count of
 * opted-out files, so widening the opt-out is always a deliberate, reviewed
 * diff. A file that mixes real-time and frozen-time tests gets split rather than
 * opted out wholesale.
 *
 * A suite that just wants a DIFFERENT fixed instant does not opt out: it pins
 * its own with `vi.setSystemTime(...)` (or the `vi.mock("@/lib/date-only", …)`
 * idiom) in its own `beforeAll`/`beforeEach`, which runs after this one and
 * therefore wins. `vitest.config.ts` pins `sequence.hooks: "stack"` so that
 * ordering is a declared contract rather than a default we happen to inherit.
 */
import { vi } from "vitest";

/**
 * The frozen "today" every test run gets by default. Never advances — see the
 * module comment.
 */
export const FROZEN_TEST_CLOCK_BASE_ISO = "2026-07-01T00:00:00.000Z";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Set by `optOutOfFrozenClock` during the test file's module evaluation, which
 * always completes before any `beforeAll` hook runs — including this setup
 * file's, which is registered first but executed later.
 */
let realClockReason: string | null = null;

/**
 * Declare that THIS test file needs the real wall clock, with a reason.
 *
 * Call it once at module top level (not inside a hook or a test — by the time
 * those run the freeze is already installed):
 *
 * ```ts
 * optOutOfFrozenClock("measures real elapsed time across a retry backoff");
 * ```
 *
 * Adding a call here also means adding the file to the allowlist in
 * `src/lib/__tests__/frozen-test-clock.test.ts`, which is the point: the
 * opt-out cannot quietly become the norm.
 */
export function optOutOfFrozenClock(reason: string): void {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed) {
    throw new Error(
      "optOutOfFrozenClock(reason) requires a non-empty reason explaining why this " +
        "file needs the real wall clock. See src/lib/__tests__/helpers/clock.ts."
    );
  }
  realClockReason = trimmed;
}

/** The opt-out reason for the current test file, or `null` when frozen. */
export function frozenClockOptOutReason(): string | null {
  return realClockReason;
}

function readOffsetDays(): number {
  const raw = process.env.TEST_CLOCK_OFFSET_DAYS?.trim();
  if (!raw) {
    return 0;
  }

  const days = Number(raw);
  if (!Number.isInteger(days)) {
    throw new Error(
      `TEST_CLOCK_OFFSET_DAYS must be an integer number of days, got ${JSON.stringify(raw)}.`
    );
  }

  return days;
}

/**
 * The instant the test clock is frozen at: the base instant, shifted by the
 * canary's environment overrides when they are set.
 */
export function frozenTestNow(): Date {
  const absolute = process.env.TEST_CLOCK_ISO?.trim();
  const base = new Date(absolute || FROZEN_TEST_CLOCK_BASE_ISO);
  if (Number.isNaN(base.getTime())) {
    throw new Error(
      `TEST_CLOCK_ISO must be a parseable ISO-8601 instant, got ${JSON.stringify(absolute)}.`
    );
  }

  return new Date(base.getTime() + readOffsetDays() * MS_PER_DAY);
}

/**
 * Install the frozen clock for the current test file. Called once from
 * `vitest.setup.ts`; a file that opted out is left on the real clock.
 */
export function installFrozenTestClock(): void {
  if (realClockReason) {
    return;
  }

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(frozenTestNow());
}

/**
 * Hand the clock back after the file's tests. Safe to call when the file opted
 * out or already restored real timers itself.
 */
export function restoreRealTestClock(): void {
  if (realClockReason) {
    return;
  }

  vi.useRealTimers();
}
