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

/**
 * The NZ calendar day a date-only value encodes, as `yyyy-MM-dd`.
 *
 * THE CANONICAL ENCODER, and the only place in `src/` allowed to write the
 * truncation by hand (#2684). The receiver must be a date-only value — a
 * `@db.Date` column, or a `Date` this module produced — whose instant is UTC
 * midnight, because that is what makes the UTC reading and the NZ calendar day
 * the same day (INV-DATE-010).
 *
 * It is NOT the encoder for a real instant. `createdAt`, `updatedAt` and every
 * other bare `DateTime` column is a moment, and its UTC calendar day is the
 * PREVIOUS NZ day for roughly the first half of every New Zealand day — the
 * defect #2697 fixed on a Xero due date and a finance export. Deriving a club
 * calendar day from an instant is `formatDateOnlyForTimeZone`'s job
 * (INV-DATE-019).
 */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The calendar MONTH a date-only value falls in, as `yyyy-MM`.
 *
 * Same receiver contract as `formatDateOnly`: a date-only value, never an
 * instant. Month keys are the finance subsystem's period identity (the
 * `@db.Date` `FinanceMonthlyFact.month`, a reconciliation window's start), and
 * they were the one hand-written ISO truncation left over once the day-level
 * ones were single-sourced — a neighbouring hole in a rule that claims to close
 * the class, so it lives here too (#2684).
 */
export function formatMonthOnly(date: Date): string {
  return formatDateOnly(date).slice(0, 7);
}

/**
 * The `yyyy-MM-dd` day a SERIALISED date-only value carries.
 *
 * The same value as `formatDateOnly`, one hop later: once a `@db.Date` has
 * crossed a JSON boundary into a client component or an API payload it is a
 * string (`"2026-07-01T00:00:00.000Z"`, or already `"2026-07-01"`), and the
 * caller wants the day back out of it. Both shapes return their leading day,
 * which is why this is a plain fixed-width prefix rather than a parse: the
 * date-only prefix of an ISO value is exactly ten characters, so this and the
 * `.split("T")[0]` spelling it replaces agree on every input either can be
 * handed.
 *
 * It carries the SAME receiver contract as `formatDateOnly` and provides no
 * more safety than it: a serialised instant truncated here is the identical
 * off-by-one-day defect. If what you hold is a serialised `DateTime`, parse it
 * and go through `formatDateOnlyForTimeZone` instead.
 */
export function dateOnlyFromIsoString(value: string): string {
  return value.slice(0, 10);
}

/**
 * The NZ date-only key (`yyyy-MM-dd`) for a calendar day given as parts;
 * `monthIndex` is 0-based, matching `Date.getMonth()`.
 *
 * This is the CANONICAL client-side encoding of a lodge night (#2474). A lodge
 * night is an abstract calendar day, not an instant, so it is built straight
 * from its parts and never routed through `new Date(year, month, day)` — that
 * construction is midnight in the BROWSER's zone, and the moment such a value
 * reaches an instant-based API (a club-pinned `Intl` formatter, a UTC
 * serialiser, or day arithmetic across a DST boundary) it is off by a day for a
 * viewer whose zone sits far enough from New Zealand. This replaced the #2264
 * `localCalendarDayToDateOnly` bridge, which patched the display half of that
 * hazard while the fragile local-midnight encoding still existed; carrying the
 * string end-to-end removes the encoding itself. A consumer that genuinely needs
 * a `Date` calls `parseDateOnly` at the boundary, which pins the day to UTC
 * midnight — rendered as club midday, so the same calendar day in every zone.
 */
export function formatCalendarDayOnly(
  year: number,
  monthIndex: number,
  day: number,
): string {
  const month = String(monthIndex + 1).padStart(2, "0");
  const dayOfMonth = String(day).padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
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
