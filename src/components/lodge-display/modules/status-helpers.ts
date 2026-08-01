// Shared stay-status derivation for the tonight/look-ahead display modules
// (room-cards, night-columns, status-board). Pure functions of the
// privacy-reduced DisplayState rows — no queries, no server imports.
//
// A stay is [stayStart, stayEnd) where stayEnd is the CHECK-OUT date and is
// EXCLUSIVE (the morning they leave — not a night). Dates are NZ date-only
// "YYYY-MM-DD" strings, so a plain string compare is a calendar compare.

import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";

/**
 * Not one of the shared `nzst-date` helpers (#2264). A lobby-display column head
 * is as terse as the wall allows — short weekday plus a bare day-of-month, no
 * month and no year — because the window is only ever a few days wide and the
 * screen is read from across the room. The zone is pinned to club time so a TV
 * whose browser sits in the wrong zone can no longer name the wrong weekday.
 *
 * This is the CANONICAL copy of the pattern: the boards in this folder
 * (welcome-panel, chores-board, arrivals-board, occupancy-grid, singles-board)
 * all repeat it and must stay byte-identical to it.
 */
export const DISPLAY_SHORT_WEEKDAY = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  weekday: "short",
});

export type StayStatus = "arriving" | "staying" | "departing";

/**
 * Classify a stay on one window date `date` (date-only string compare):
 * - `arriving`   — the stay starts on `date` (`stayStart === date`);
 * - `departing`  — `date` is the check-out morning (`stayEnd === date`);
 * - `staying`    — already in and staying again (`stayStart < date < stayEnd`);
 * - `null`       — the stay does not touch `date` at all.
 *
 * Arrival wins over departure for a same-day edge (a stay can't both start and
 * check out on the same date given an exclusive end, but the order is explicit
 * so the classification is total and deterministic).
 */
export function stayStatusOn(
  stay: { stayStart: string; stayEnd: string },
  date: string
): StayStatus | null {
  if (stay.stayStart === date) return "arriving";
  if (stay.stayEnd === date) return "departing";
  if (stay.stayStart < date && stay.stayEnd > date) return "staying";
  return null;
}

/** Rendering order within a status-grouped list: arrivals, then staying, then
 * departures — matching the approved mockups (O3/O4/C1a). */
export const STAY_STATUS_ORDER: Record<StayStatus, number> = {
  arriving: 0,
  staying: 1,
  departing: 2,
};

/** "Fri 10" — short weekday + day-of-month, NZ locale. Shared with the bar
 * boards' own private formatter; kept here so these modules never import from
 * arrivals-board (which a sibling change owns). */
export function shortDay(date: string): string {
  // Handed over at UTC midnight rather than parsed in the browser's own zone
  // (#2264): a bare `T00:00:00` parse slides the whole label back a day for a
  // viewer at UTC+13/+14. Read back in club time, UTC midnight is midday the
  // SAME calendar day (NZ is UTC+12/+13), so the formatted weekday and
  // `getUTCDate()` always name the same day.
  const day = new Date(`${date}T00:00:00Z`);
  return `${DISPLAY_SHORT_WEEKDAY.format(day)} ${day.getUTCDate()}`;
}
