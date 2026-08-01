import { APP_TIME_ZONE } from "@/config/operational";

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function buildDateOnly(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

export function isDateOnlyString(dateStr: string): boolean {
  if (!DATE_ONLY_REGEX.test(dateStr)) {
    return false;
  }

  const parsed = buildDateOnly(dateStr);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateStr;
}

export function parseDateOnly(dateStr: string): Date {
  return isDateOnlyString(dateStr) ? buildDateOnly(dateStr) : new Date(NaN);
}

function getDateParts(dateStr: string) {
  if (!isDateOnlyString(dateStr)) {
    return null;
  }

  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const readPart = (type: string) => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : NaN;
  };
  const asUtc = Date.UTC(
    readPart("year"),
    readPart("month") - 1,
    readPart("day"),
    readPart("hour"),
    readPart("minute"),
    readPart("second")
  );

  return asUtc - date.getTime();
}

function zonedDateOnlyTimeToUtc(
  dateStr: string,
  timeZone: string,
  hours = 0,
  minutes = 0,
  seconds = 0,
  milliseconds = 0
): Date {
  const parts = getDateParts(dateStr);
  if (!parts) return new Date(NaN);

  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hours,
    minutes,
    seconds,
    milliseconds
  );
  let result = new Date(localAsUtc - getTimeZoneOffsetMs(new Date(localAsUtc), timeZone));
  result = new Date(localAsUtc - getTimeZoneOffsetMs(result, timeZone));
  return result;
}

export function startOfDateOnlyForTimeZone(
  dateStr: string,
  timeZone = APP_TIME_ZONE
): Date {
  return zonedDateOnlyTimeToUtc(dateStr, timeZone);
}

export function endOfDateOnlyForTimeZone(
  dateStr: string,
  timeZone = APP_TIME_ZONE
): Date {
  const nextDate = addDaysDateOnly(parseDateOnly(dateStr), 1);
  if (Number.isNaN(nextDate.getTime())) return new Date(NaN);
  const nextStart = startOfDateOnlyForTimeZone(formatDateOnly(nextDate), timeZone);
  return new Date(nextStart.getTime() - 1);
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatLocalDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Re-encode a `Date` that carries an ABSTRACT CALENDAR DAY at the browser's
 * local midnight as the UTC-midnight instant the rest of the system uses for a
 * date-only value.
 *
 * #2264. A date picker hands back `new Date(year, month, day)` — midnight where
 * the BROWSER is — and the value it submits is read back out with local getters
 * by `formatLocalDateOnly`, so that round trip is exact wherever the member
 * sits. A club-pinned display formatter is not part of that round trip: given
 * the raw instant it renders the day as Auckland sees it, and local midnight on
 * 1 April is still 31 March in Auckland for anyone at UTC+13. The screen would
 * then name a different night than the one being booked.
 *
 * Passing the picker's `Date` through here first removes that whole class of
 * mismatch: New Zealand is UTC+12/+13, so a UTC-midnight instant always renders
 * as midday the SAME calendar day in club time.
 *
 * Use this ONLY for a Date that encodes a calendar day. A real instant (a
 * `createdAt`, a payment time) must be formatted as it is.
 */
export function localCalendarDayToDateOnly(date: Date): Date {
  return parseDateOnly(formatLocalDateOnly(date));
}

// Intl.DateTimeFormat construction costs ~0.1ms; the capacity, pricing, and
// finance loops call this once per (booking, night) pair, so a fresh formatter
// per call dominated those paths. Instances are stateless for formatToParts,
// so one per time zone is shared safely.
const dateOnlyFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDateOnlyFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateOnlyFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateOnlyFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function formatDateOnlyForTimeZone(
  date: Date,
  timeZone = APP_TIME_ZONE
): string {
  const parts = getDateOnlyFormatter(timeZone).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive date-only value for timezone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

// Returns "now" as a yyyy-MM-dd string in the given time zone. Admin default
// activity windows are interpreted server-side via start/endOfDateOnlyForTimeZone
// (club time), so seeding those defaults from the browser's local date hides
// post-midnight activity for operators (or CI) whose clock trails NZ. Deriving
// the default in the club time zone keeps the seed and the interpretation aligned.
export function todayDateOnlyForTimeZone(timeZone = APP_TIME_ZONE): string {
  return formatDateOnlyForTimeZone(new Date(), timeZone);
}

export function normalizeDateOnlyForTimeZone(
  date: Date,
  timeZone = APP_TIME_ZONE
): Date {
  const normalized = parseDateOnly(formatDateOnlyForTimeZone(date, timeZone));

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(`Invalid date-only value: ${date.toISOString()}`);
  }

  return normalized;
}

export function addDaysDateOnly(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Build a UTC date-only value from calendar parts, WITHOUT `Date.UTC`.
 *
 * `Date.UTC` applies the legacy two-digit-year rule: years 0-99 are mapped onto
 * 1900-1999, so `Date.UTC(47, 0, 1)` is 1947, not 0047. `setUTCFullYear` has no
 * such rule, so every date-only value derived from parts is built this way.
 * `monthIndex` and `day` may be out of range and roll over as usual (month 12 is
 * January of the next year; day 0 is the last day of the previous month).
 */
export function dateOnlyFromParts(
  year: number,
  monthIndex: number,
  day: number,
): Date {
  const result = new Date(0);
  result.setUTCFullYear(year, monthIndex, day);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

// Steps a date-only value by whole calendar months (#2251, the bed-allocation
// board's month stepper). Pure UTC date-only arithmetic — no time zone
// conversion, matching addDaysDateOnly. The day-of-month is clamped to the
// target month's length so the result is always a real date: 31 Jan + 1 month
// is 28 Feb (29 in a leap year), never an overflow into March. Clamping means
// the operation is NOT reversible for such days (31 Jan → 28 Feb → 28 Jan);
// callers that need to step back and forth should keep their own anchor.
export function addMonthsDateOnly(date: Date, months: number): Date {
  if (Number.isNaN(date.getTime())) return new Date(NaN);

  const day = date.getUTCDate();
  const target = dateOnlyFromParts(
    date.getUTCFullYear(),
    date.getUTCMonth() + months,
    1,
  );
  // Day 0 of the following month is the last day of the target month.
  const daysInTargetMonth = dateOnlyFromParts(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    0,
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTargetMonth));
  return target;
}

/**
 * How many nights a date-only range covers, WITHOUT materialising them.
 *
 * Both ends are UTC midnight, so the span is an exact whole number of days and
 * no time-zone or DST correction applies. Every cap on a range length checks
 * this first (#2251): `eachDateOnlyInRange` on a mistyped year-3000 date-out
 * would build a million `Date` objects before anyone could refuse it.
 * Returns `NaN` for an invalid endpoint, which fails every comparison.
 */
export function countNightsDateOnly(
  startInclusive: Date,
  endExclusive: Date,
): number {
  const spanMs = endExclusive.getTime() - startInclusive.getTime();
  return Number.isFinite(spanMs) ? Math.round(spanMs / 86_400_000) : NaN;
}

export function eachDateOnlyInRange(startInclusive: Date, endExclusive: Date): Date[] {
  const dates: Date[] = [];

  for (
    let current = new Date(startInclusive);
    current < endExclusive;
    current = addDaysDateOnly(current, 1)
  ) {
    dates.push(current);
  }

  return dates;
}

export function getTodayDateOnly(timeZone = APP_TIME_ZONE): Date {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive current date for timezone ${timeZone}`);
  }

  const today = parseDateOnly(`${year}-${month}-${day}`);
  if (Number.isNaN(today.getTime())) {
    throw new Error(`Unable to derive current date for timezone ${timeZone}`);
  }

  return today;
}
