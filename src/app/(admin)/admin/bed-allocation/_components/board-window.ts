import {
  addDaysDateOnly,
  addMonthsDateOnly,
  countNightsDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";

// Mirrors MAX_BED_ALLOCATION_RANGE_NIGHTS in src/lib/admin-bed-allocation.ts.
// This is the board's READ window only. Assignment writes are bounded
// separately and far more generously — see MAX_RANGE_ASSIGN_NIGHTS (#2251).
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
