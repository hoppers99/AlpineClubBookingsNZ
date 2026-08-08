import { expect, type Page } from "@playwright/test";

export type CalendarMonthDirection = "current" | "next" | "previous";

function monthOrdinal(dateOnly: string): number {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(dateOnly);
  if (!match) {
    throw new Error(`Expected a YYYY-MM-DD date, received ${dateOnly}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Expected a valid month in ${dateOnly}`);
  }

  return year * 12 + month - 1;
}

/** Direction from the month the calendar currently shows to the target month. */
export function calendarMonthDirection(
  displayedDateOnly: string,
  targetDateOnly: string,
): CalendarMonthDirection {
  const displayed = monthOrdinal(displayedDateOnly);
  const target = monthOrdinal(targetDateOnly);
  if (target === displayed) return "current";
  return target < displayed ? "previous" : "next";
}

/** The booking calendar's month heading, e.g. "August 2026". */
export function calendarMonthHeading(dateOnly: string): string {
  const [year, month] = dateOnly.split("-").map(Number);
  return new Date(year, month - 1).toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
  });
}

// How long ONE calendar click may spend becoming actionable (#2626) — a
// "Prev ‹"/"Next ›" hop here, or the day button a caller clicks on arrival.
//
// This exists because a bounded loop is not a bounded WAIT. `playwright.config.ts`
// sets no `actionTimeout`, so Playwright's default of 0 — "no timeout, wait until
// the test itself is killed" — applies to every `locator.click()`. A month walk
// bounded by a hop count therefore has no time bound at all: if the nav control
// never becomes actionable, hop 0's click alone burns the whole 90 s test budget
// and the walk's own arrival assertion is never even reached. That is exactly how
// #2626 presented — a three-hop loop dying on `locator.click: Target page,
// context or browser has been closed`, which reads as a browser crash and says
// nothing about the calendar.
//
// Matches `expect: { timeout: 15_000 }`, so a stuck control and a failed
// assertion cost the same and several hops still fit inside one test budget.
//
// EXPORTED because the walk always hands off to a day click the caller makes
// itself (`selectCalendarDay` in `e2e/helpers/booking.ts`,
// `selectPastCalendarDay` in `e2e/admin-retroactive-booking.spec.ts`), and that
// click has the identical failure mode. Asserting arrival removes the COMMON
// cause — the month is now verified before the day is clicked — but not a day
// that resolves and is still not actionable: a past or out-of-season day
// rendered `disabled` (`isPast` against `minSelectableStr`,
// `src/components/booking-calendar.tsx`), or availability still loading.
// Unbounded, that waits out the whole test budget and reports `Target page,
// context or browser has been closed` — the exact pathology
// docs/E2E_PLAYWRIGHT.md §5 declares must never recur. One constant for both, so
// the walk and the day it walks to can never drift apart.
export const CALENDAR_CLICK_TIMEOUT_MS = 15_000;

/**
 * Walk the booking calendar to the month holding `target` and return how many
 * hops it spent. 0 means it was already there.
 *
 * Two failures are made loud, in the order they can happen:
 *  - the nav control never becomes actionable — the calendar is not on the page,
 *    or something (a modal overlay, an unmounted step) is sitting over it;
 *  - the bound is exhausted without arriving — fails naming the month it could
 *    not reach, rather than leaving the caller to time out on a day button.
 *
 * `direction: "current"` clicks nothing at all and asserts arrival only.
 *
 * @param maxHops the caller's own bound — the number of months it can need to
 *   cross, plus margin. Failing on it is the point, so keep it tight.
 * @param context what the caller is walking towards, quoted back in the failure.
 */
export async function walkCalendarToMonth(
  page: Page,
  {
    target,
    direction,
    maxHops,
    context,
  }: {
    target: string;
    direction: CalendarMonthDirection;
    maxHops: number;
    context: string;
  },
): Promise<number> {
  const monthHeading = calendarMonthHeading(target);
  // getByRole, not getByText: the streamed (hidden) copy of a Suspense boundary
  // is out of the accessibility tree, so this cannot resolve to the template.
  const heading = page.getByRole("heading", { name: monthHeading });
  const control = direction === "previous" ? "Prev" : "Next";
  const navigationButton = direction === "previous" ? /Prev/ : /Next/;

  // "current" has NO correct control to click: the caller is telling us the
  // calendar is already on the target month, and both `Prev` and `Next` walk
  // away from it. The loop's `heading.isVisible()` is a single, non-retrying
  // probe, so one miss on a transient re-render used to become a `Next` click
  // that left a month already on screen — and then the retrying arrival
  // assertion failed with "walking current to July 2026". Skipping the loop
  // entirely leaves that transient to the arrival assertion, which does retry.
  // Not hypothetical: `selectPastCalendarDay`
  // (`e2e/admin-retroactive-booking.spec.ts`) yields "current" whenever the
  // check-out shares the check-in's month, which is the common case.
  const clickableHops = direction === "current" ? 0 : maxHops;

  let hops = 0;
  for (; hops < clickableHops; hops += 1) {
    if (await heading.isVisible().catch(() => false)) {
      break;
    }
    const nav = page.getByRole("button", { name: navigationButton });
    // Assert the control is THERE and usable before clicking it, so "the
    // calendar is not reachable" fails as itself inside the expect budget
    // instead of as an unbounded click that outlives the test.
    await expect(
      nav,
      `the booking calendar's "${control}" control never became actionable on ` +
        `hop ${hops} while walking ${direction} to ${monthHeading} (${context}). ` +
        `Either the calendar is not rendered on this page, or something is over ` +
        `it — an open modal (the "Confirm member details" onboarding gate is the ` +
        `usual one) puts the whole page behind an overlay and out of the ` +
        `accessibility tree`,
    ).toBeEnabled();
    await nav.click({ timeout: CALENDAR_CLICK_TIMEOUT_MS });
  }

  await expect(
    heading,
    direction === "current"
      ? `calendar is not showing ${monthHeading}, which the caller expected it to ` +
          `be on already, and no "Prev"/"Next" hop can help (${context})`
      : `calendar never reached ${monthHeading} within ${maxHops} "${control}" hops ` +
          `(${context})`,
  ).toBeVisible();
  return hops;
}
