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

// How long ONE "Prev ‹"/"Next ›" click may spend becoming actionable (#2626).
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
const NAV_CLICK_TIMEOUT_MS = 15_000;

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

  let hops = 0;
  for (; hops < maxHops; hops += 1) {
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
    await nav.click({ timeout: NAV_CLICK_TIMEOUT_MS });
  }

  await expect(
    heading,
    `calendar never reached ${monthHeading} within ${maxHops} "${control}" hops ` +
      `(${context})`,
  ).toBeVisible();
  return hops;
}
