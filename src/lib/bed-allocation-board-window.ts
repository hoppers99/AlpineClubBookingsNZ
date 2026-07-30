import {
  addDaysDateOnly,
  addMonthsDateOnly,
  countNightsDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";

/*
 * Read-window arithmetic for every bed-allocation surface.
 *
 * Lives in src/lib (moved out of the board's `_components/` by #2252) for the
 * same reason the range dialog does: the in-booking Bed allocation panel pages
 * its reads through the identical 31-night bound, and a client component under
 * src/components must not reach into the admin route tree for it. One module,
 * two surfaces — not a second copy of the same limit drifting apart.
 */

// Mirrors MAX_BED_ALLOCATION_RANGE_NIGHTS in src/lib/admin-bed-allocation.ts.
// This is the READ window only (the dashboard GET 400s above it). Assignment
// writes are bounded separately and far more generously — see
// MAX_RANGE_ASSIGN_NIGHTS (#2251).
export const MAX_RANGE_NIGHTS = 31;

/*
 * #2251: the old clampRange() silently shortened a too-long window, so the board
 * quietly showed something other than what was typed. Silent truncation is gone.
 * Two honest behaviours replace it:
 *   - a window the ADMIN typed is REFUSED, with the reason on screen
 *     (boardWindowError) and the fetch withheld until it is fixed;
 *   - a window the app itself derives — a deep link, or the snap onto a focused
 *     booking (#1302), which may be a stay of any length — is narrowed to the
 *     31-night maximum and SAYS SO (fitBoardWindow().narrowed → a visible note).
 */
export function boardWindowError(from: string, to: string): string | null {
  if (!isDateOnlyString(from) || !isDateOnlyString(to)) {
    return "Enter a valid Date In and Date Out.";
  }
  if (parseDateOnly(to) <= parseDateOnly(from)) {
    return "Date Out must be after Date In.";
  }
  // Counted arithmetically, never enumerated: a mistyped year-3000 date-out is
  // refused without building a column per night first.
  const nights = countNightsDateOnly(parseDateOnly(from), parseDateOnly(to));
  if (nights > MAX_RANGE_NIGHTS) {
    return `The board shows at most ${MAX_RANGE_NIGHTS} nights; that window is ${nights}. Narrow Date In / Date Out, or step a month at a time with the arrows.`;
  }
  return null;
}

/**
 * The night columns the board renders for a window — EMPTY whenever
 * `boardWindowError` refuses that window.
 *
 * A refused window has no columns at all. Enumerating it anyway would build one
 * column per night of whatever was typed (a year, a century) and hand the board
 * a table it must lay out, underneath an Alert saying the window is invalid.
 * The refusal is the whole answer.
 */
export function boardNights(from: string, to: string): string[] {
  if (boardWindowError(from, to)) return [];
  return eachDateOnlyInRange(parseDateOnly(from), parseDateOnly(to)).map(
    formatDateOnly,
  );
}

export function fitBoardWindow(
  from: string,
  to: string,
): { toDate: string; narrowed: boolean } {
  if (!isDateOnlyString(from) || !isDateOnlyString(to)) {
    return { toDate: to, narrowed: false };
  }

  const fromDate = parseDateOnly(from);
  const requested = parseDateOnly(to);
  const earliest = addDaysDateOnly(fromDate, 1);
  const latest = addDaysDateOnly(fromDate, MAX_RANGE_NIGHTS);

  if (requested <= earliest) {
    return { toDate: formatDateOnly(earliest), narrowed: false };
  }
  if (requested > latest) {
    return { toDate: formatDateOnly(latest), narrowed: true };
  }
  return { toDate: formatDateOnly(requested), narrowed: false };
}

// One press of ‹ / › steps the whole window a calendar month. Month lengths
// differ, so the shifted window can come out a few nights wider than 31; it is
// then narrowed back to the maximum and the note says so (the owner accepted the
// slightly-varying width when the steppers were signed off).
export function stepBoardWindowByMonths(
  from: string,
  to: string,
  months: number,
): { fromDate: string; toDate: string; narrowed: boolean } {
  if (!isDateOnlyString(from) || !isDateOnlyString(to)) {
    return { fromDate: from, toDate: to, narrowed: false };
  }
  const nextFrom = formatDateOnly(
    addMonthsDateOnly(parseDateOnly(from), months),
  );
  const nextTo = formatDateOnly(addMonthsDateOnly(parseDateOnly(to), months));
  const fitted = fitBoardWindow(nextFrom, nextTo);
  return {
    fromDate: nextFrom,
    toDate: fitted.toDate,
    narrowed: fitted.narrowed,
  };
}

/**
 * One page of a stay's nights, for the in-booking Bed allocation panel (#2252).
 *
 * A booking has no maximum length, and the dashboard read refuses anything over
 * {@link MAX_RANGE_NIGHTS}, so a long stay cannot be read in one go. The panel
 * therefore PAGES the stay — and the page is always labelled on screen with the
 * night numbers and the dates it covers, so what is missing from the rows is
 * never silently missing. Same rule as the board's `narrowed` note: no window
 * is ever quietly shortened.
 *
 * Unlike the board's calendar-month steppers, paging is anchored to the stay
 * itself: a page never wanders outside `checkIn` → `checkOut`, because nothing
 * outside the stay belongs to this booking.
 */
export interface StayWindowPage {
  fromDate: string;
  toDate: string;
  /** 0-based page. */
  pageIndex: number;
  pageCount: number;
  totalNights: number;
  /** 1-based inclusive night numbers, for the on-screen label. */
  firstNight: number;
  lastNight: number;
}

export function stayWindowPage(
  checkIn: string,
  checkOut: string,
  pageIndex: number,
): StayWindowPage | null {
  if (!isDateOnlyString(checkIn) || !isDateOnlyString(checkOut)) return null;
  const start = parseDateOnly(checkIn);
  const end = parseDateOnly(checkOut);
  if (end <= start) return null;

  // Counted arithmetically, never enumerated — a stay is bounded by nothing, so
  // building a Date per night just to count them is not an option.
  const totalNights = countNightsDateOnly(start, end);
  const pageCount = Math.ceil(totalNights / MAX_RANGE_NIGHTS);
  const page = Math.min(Math.max(pageIndex, 0), pageCount - 1);

  const from = addDaysDateOnly(start, page * MAX_RANGE_NIGHTS);
  const nightsOnPage = Math.min(
    MAX_RANGE_NIGHTS,
    totalNights - page * MAX_RANGE_NIGHTS,
  );
  const to = addDaysDateOnly(from, nightsOnPage);

  return {
    fromDate: formatDateOnly(from),
    toDate: formatDateOnly(to),
    pageIndex: page,
    pageCount,
    totalNights,
    firstNight: page * MAX_RANGE_NIGHTS + 1,
    lastNight: page * MAX_RANGE_NIGHTS + nightsOnPage,
  };
}

/**
 * Collapse a sorted night list into contiguous runs, as inclusive first/last
 * night pairs. The panel shows "3 Jun → 9 Jun" rather than seven identical
 * rows, which is the only way a 90-night stay stays readable.
 */
export function collapseNightRuns(
  nights: string[],
): { firstNight: string; lastNight: string; nights: string[] }[] {
  const sorted = [...new Set(nights)].sort();
  const runs: { firstNight: string; lastNight: string; nights: string[] }[] = [];

  for (const night of sorted) {
    const current = runs[runs.length - 1];
    if (
      current &&
      formatDateOnly(addDaysDateOnly(parseDateOnly(current.lastNight), 1)) ===
        night
    ) {
      current.lastNight = night;
      current.nights.push(night);
      continue;
    }
    runs.push({ firstNight: night, lastNight: night, nights: [night] });
  }

  return runs;
}
