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
 * Shift an NZ date-only key by whole days.
 *
 * Re-anchored at UTC midnight, which is midday NZ (UTC+12/+13), so the shift
 * can never land on a daylight-saving transition and roll the calendar day the
 * wrong way — the same reason `shortDay` hands its dates over at UTC midnight.
 */
export function shiftDateOnly(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** A status plus the run of nights it was read from. */
export interface StaySegment {
  status: StayStatus;
  /** This segment's own first night. */
  stayStart: string;
  /** This segment's own check-out morning — the day after its last night. */
  stayEnd: string;
}

/**
 * Classify a stay on one window date `date`, AND return the run of nights that
 * classification came from.
 *
 * A stay occupies the MORNING half of `date` when night `date - 1` is one of
 * its nights, and the EVENING half when night `date` is (INV-DATE-004). The
 * three statuses are nothing but which halves those are:
 *
 * - `arriving`   — evening only: they come in this afternoon;
 * - `departing`  — morning only: they are here until midday and then gone;
 * - `staying`    — both: already in, and in again tonight;
 * - `null`       — neither: the stay does not touch `date` at all.
 *
 * `nights` (#2735) is the authoritative per-night set the payload now carries,
 * and it is what makes this per SEGMENT: a guest booked on nights {10, 12} is
 * `departing` on the 11th and `arriving` again on the 12th, instead of reading
 * as one unbroken stay that leaves only once.
 *
 * THE SEGMENT IS RETURNED WITH THE STATUS, not derived separately, because the
 * two have to agree. A panel that classified per segment while labelling with
 * the row's overall check-out printed "Leaving today · Gappy G · Mon 13 – Thu
 * 16" — a check-out three days after the day it says they leave — and one
 * look-ahead panel said "→ Thu 16" in the 13th's column and "leaves" in the
 * 14th's. Every board that prints dates beside the status labels from
 * `stayStart`/`stayEnd` HERE: `Mon 13 – Tue 14` on the 14th, `Wed 15 – Thu 16`
 * when they come back.
 *
 * Which run: the one containing night `date` when they sleep here tonight,
 * otherwise the one ending on night `date - 1`. Those are the same run whenever
 * both are booked, because a run is contiguous by construction — so there is
 * never a choice to make.
 *
 * When `nights` is absent the same rule is evaluated against the half-open
 * envelope `[stayStart, stayEnd)`, and the whole envelope is returned as the
 * segment. That is the classification this has always made — evening-only is
 * `stayStart` and nothing else, morning-only is `stayEnd` and nothing else, and
 * both is strictly between them — so the two branches agree on every contiguous
 * stay and differ only where an envelope cannot say what a night set can. Same
 * fallback shape as `computeBarSegments`, and for the same reason: every row the
 * serialiser emits carries its nights, so it is for direct unit tests and for a
 * payload served by an older deploy.
 */
export function staySegmentOn(
  stay: { stayStart: string; stayEnd: string; nights?: readonly string[] },
  date: string
): StaySegment | null {
  if (stay.nights) {
    const nights = new Set(stay.nights);
    const previous = shiftDateOnly(date, -1);
    const evening = nights.has(date);
    const morning = nights.has(previous);
    if (!evening && !morning) return null;
    // Walk out from the night we matched to the ends of its contiguous run.
    const anchor = evening ? date : previous;
    let first = anchor;
    while (nights.has(shiftDateOnly(first, -1))) first = shiftDateOnly(first, -1);
    let last = anchor;
    while (nights.has(shiftDateOnly(last, 1))) last = shiftDateOnly(last, 1);
    return {
      status: evening ? (morning ? "staying" : "arriving") : "departing",
      stayStart: first,
      stayEnd: shiftDateOnly(last, 1),
    };
  }
  const envelope = { stayStart: stay.stayStart, stayEnd: stay.stayEnd };
  if (stay.stayStart === date) return { status: "arriving", ...envelope };
  if (stay.stayEnd === date) return { status: "departing", ...envelope };
  if (stay.stayStart < date && stay.stayEnd > date) {
    return { status: "staying", ...envelope };
  }
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
