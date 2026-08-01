/**
 * Recurring-event rule + occurrence generation (#calendar-recurring).
 *
 * Pure and client-safe (no prisma, no zod, no server-only imports): the same
 * module powers server-side occurrence materialisation and the client-side
 * "Repeat" picker labels.
 *
 * TIMEZONE: all date math is done with local `Date` component APIs
 * (getFullYear/getMonth/getDate + `new Date(y, m, d, …)`). In production the
 * server runs in the club timezone (docker `TZ=Pacific/Auckland`), so stepping
 * whole days/months in local components lands each occurrence on the intended
 * wall-clock day even across DST. In local dev the browser and dev server share
 * one timezone, so it stays self-consistent. Anchor instants therefore keep
 * their wall-clock day/time across the whole series.
 *
 * The human-readable labels at the bottom of the file are the exception: they
 * render through formatters pinned to the club locale and timezone (#2264), so
 * a browser outside New Zealand still describes the pattern in club time.
 */

import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import { formatNZDate } from "@/lib/nzst-date";

export const CALENDAR_RECURRENCE_FREQUENCIES = [
  "DAILY",
  "WEEKLY",
  "MONTHLY_DAY_OF_MONTH",
  "MONTHLY_NTH_WEEKDAY",
] as const;

export type CalendarRecurrenceFrequency =
  (typeof CALENDAR_RECURRENCE_FREQUENCIES)[number];

export type RecurrenceEndMode = "never" | "until" | "count";

export interface RecurrenceRule {
  frequency: CalendarRecurrenceFrequency;
  /** Every N units (weeks/months/days). >= 1. */
  interval: number;
  endMode: RecurrenceEndMode;
  /** Inclusive last date (ISO) when endMode === "until". */
  until?: string | null;
  /** Number of occurrences when endMode === "count". */
  count?: number | null;
}

/** Hard ceiling on generated rows, so an open-ended rule can never run away. */
export const MAX_OCCURRENCES = 366;
/** Horizon for an open-ended ("never") rule, from the anchor. */
const NEVER_HORIZON_MONTHS = 24;
/** Loop guard: months/weeks/days we are willing to probe before giving up. */
const MAX_ITERATIONS = 4000;

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** The 1-based ordinal of a date's weekday within its month (1st..5th). */
export function weekdayOrdinalInMonth(date: Date): number {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

/**
 * The day-of-month for the nth occurrence of `weekday` in the given month, or
 * null when that month has no such nth weekday (e.g. a 5th Tuesday).
 */
function nthWeekdayDayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
  nth: number,
): number | null {
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const firstOccurrence = 1 + ((weekday - firstWeekday + 7) % 7);
  const day = firstOccurrence + (nth - 1) * 7;
  return day <= daysInMonth(year, monthIndex) ? day : null;
}

/**
 * Compute the kth candidate start instant for a rule anchored at `anchor`.
 * Returns null when that cycle has no occurrence (only possible for
 * MONTHLY_NTH_WEEKDAY when the nth weekday does not exist that month).
 */
function occurrenceForCycle(
  anchor: Date,
  frequency: CalendarRecurrenceFrequency,
  interval: number,
  k: number,
): Date | null {
  const y = anchor.getFullYear();
  const mo = anchor.getMonth();
  const d = anchor.getDate();
  const hh = anchor.getHours();
  const mm = anchor.getMinutes();
  const ss = anchor.getSeconds();
  const ms = anchor.getMilliseconds();

  switch (frequency) {
    case "DAILY":
      return new Date(y, mo, d + k * interval, hh, mm, ss, ms);
    case "WEEKLY":
      return new Date(y, mo, d + k * 7 * interval, hh, mm, ss, ms);
    case "MONTHLY_DAY_OF_MONTH": {
      const targetMonth = mo + k * interval;
      const targetYear = y + Math.floor(targetMonth / 12);
      const normalizedMonth = ((targetMonth % 12) + 12) % 12;
      // Clamp the day into the target month (e.g. the 31st becomes the 30th /
      // 28th) rather than letting Date roll over into the following month.
      const day = Math.min(d, daysInMonth(targetYear, normalizedMonth));
      return new Date(targetYear, normalizedMonth, day, hh, mm, ss, ms);
    }
    case "MONTHLY_NTH_WEEKDAY": {
      const weekday = anchor.getDay();
      const nth = weekdayOrdinalInMonth(anchor);
      const targetMonth = mo + k * interval;
      const targetYear = y + Math.floor(targetMonth / 12);
      const normalizedMonth = ((targetMonth % 12) + 12) % 12;
      const day = nthWeekdayDayOfMonth(
        targetYear,
        normalizedMonth,
        weekday,
        nth,
      );
      return day === null
        ? null
        : new Date(targetYear, normalizedMonth, day, hh, mm, ss, ms);
    }
  }
}

/**
 * All occurrence start instants for a rule, in ascending order, INCLUDING the
 * anchor itself as the first. Bounded by the rule's end condition and the
 * MAX_OCCURRENCES safety cap.
 */
export function generateOccurrenceStarts(
  anchor: Date,
  rule: RecurrenceRule,
): Date[] {
  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const results: Date[] = [];

  let untilEnd: number | null = null;
  if (rule.endMode === "until" && rule.until) {
    const untilDate = new Date(rule.until);
    if (!Number.isNaN(untilDate.getTime())) {
      // Inclusive: allow anything up to the end of the `until` local day.
      untilEnd = new Date(
        untilDate.getFullYear(),
        untilDate.getMonth(),
        untilDate.getDate(),
        23,
        59,
        59,
        999,
      ).getTime();
    }
  }

  const horizonEnd =
    rule.endMode === "never"
      ? new Date(
          anchor.getFullYear(),
          anchor.getMonth() + NEVER_HORIZON_MONTHS,
          anchor.getDate(),
          23,
          59,
          59,
          999,
        ).getTime()
      : null;

  const targetCount =
    rule.endMode === "count" && rule.count
      ? Math.max(1, Math.min(MAX_OCCURRENCES, Math.floor(rule.count)))
      : MAX_OCCURRENCES;

  for (let k = 0; k < MAX_ITERATIONS && results.length < targetCount; k++) {
    const occurrence = occurrenceForCycle(
      anchor,
      rule.frequency,
      interval,
      k,
    );
    if (!occurrence) continue; // skipped cycle (missing nth weekday)

    const t = occurrence.getTime();
    if (untilEnd !== null && t > untilEnd) break;
    if (horizonEnd !== null && t > horizonEnd) break;

    results.push(occurrence);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Labels for the "Repeat" picker (client-safe)
// ---------------------------------------------------------------------------

const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th"];

function ordinal(n: number): string {
  return ORDINALS[n] ?? `${n}th`;
}

// Bare long weekday ("Tuesday") — none of the shared `nzst-date` helpers render
// a weekday on its own, so this pattern-description label keeps its own pinned
// formatter rather than gaining a date it does not want.
const RECURRENCE_LABEL_PARTS = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  weekday: "long",
  day: "numeric",
});

/**
 * The anchor's weekday AND day-of-month as the CLUB sees them (#2264).
 *
 * Both come out of one club-pinned formatter on purpose. Reading the weekday in
 * club time while taking the day number from `anchor.getDate()` (the browser's
 * zone) would let a label contradict itself for an overseas admin — "Monthly on
 * day 16 … on the 3rd Tuesday" where the 16th is a Wednesday. Occurrences are
 * materialised by a server pinned to `TZ=Pacific/Auckland`, so the club zone is
 * also the zone the generated series actually follows: describing the pattern
 * this way makes the label agree with the events it will produce, whoever is
 * reading it.
 *
 * `weekdayOrdinalInMonth` above is deliberately NOT changed — it is the
 * generation-side date math, and that stays on the local components the rest of
 * this module steps through.
 */
function clubZoneLabelParts(date: Date): { weekday: string; day: number } {
  const parts = RECURRENCE_LABEL_PARTS.formatToParts(date);
  return {
    weekday: parts.find((part) => part.type === "weekday")?.value ?? "",
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

/** The 1-based ordinal of a weekday within its month, from a day number. */
function ordinalFromDayOfMonth(day: number): number {
  return Math.floor((day - 1) / 7) + 1;
}

/** "Repeat" options for a given selected date, labelled from that date. */
export function recurrenceOptionsForDate(
  date: Date,
): Array<{ value: CalendarRecurrenceFrequency | "NONE"; label: string }> {
  const { weekday, day } = clubZoneLabelParts(date);
  const nth = ordinalFromDayOfMonth(day);
  return [
    { value: "NONE", label: "Does not repeat" },
    { value: "DAILY", label: "Daily" },
    { value: "WEEKLY", label: `Weekly on ${weekday}` },
    { value: "MONTHLY_DAY_OF_MONTH", label: `Monthly on day ${day}` },
    {
      value: "MONTHLY_NTH_WEEKDAY",
      label: `Monthly on the ${ordinal(nth)} ${weekday}`,
    },
  ];
}

/** The unit noun for an interval input ("week", "month", "day"). */
export function recurrenceUnitLabel(
  frequency: CalendarRecurrenceFrequency,
): string {
  switch (frequency) {
    case "DAILY":
      return "day";
    case "WEEKLY":
      return "week";
    default:
      return "month";
  }
}

/** Human summary of a rule anchored at a date, e.g. "Every 2 weeks on Tuesday". */
export function describeRecurrence(rule: RecurrenceRule, anchor: Date): string {
  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const every = interval === 1 ? "" : `Every ${interval} `;
  const { weekday: anchorWeekday, day: anchorDay } = clubZoneLabelParts(anchor);
  const anchorNth = ordinalFromDayOfMonth(anchorDay);
  let base: string;
  switch (rule.frequency) {
    case "DAILY":
      base = interval === 1 ? "Daily" : `${every}days`;
      break;
    case "WEEKLY":
      base =
        interval === 1
          ? `Weekly on ${anchorWeekday}`
          : `${every}weeks on ${anchorWeekday}`;
      break;
    case "MONTHLY_DAY_OF_MONTH":
      base =
        interval === 1
          ? `Monthly on day ${anchorDay}`
          : `${every}months on day ${anchorDay}`;
      break;
    case "MONTHLY_NTH_WEEKDAY":
      base =
        interval === 1
          ? `Monthly on the ${ordinal(anchorNth)} ${anchorWeekday}`
          : `${every}months on the ${ordinal(anchorNth)} ${anchorWeekday}`;
      break;
  }

  if (rule.endMode === "until" && rule.until) {
    // #2264: `Intl.format` THROWS a RangeError on an invalid Date, where the
    // `toLocaleDateString` call this replaced quietly returned the string
    // "Invalid Date". A malformed `until` must not take the whole "Repeat"
    // picker down with it, so fall back to the raw value — the same defensive
    // shape the occurrence generator above already applies to this field.
    const untilDate = new Date(rule.until);
    const untilLabel = Number.isNaN(untilDate.getTime())
      ? rule.until
      : formatNZDate(untilDate);
    return `${base}, until ${untilLabel}`;
  }
  if (rule.endMode === "count" && rule.count) {
    return `${base}, ${rule.count} times`;
  }
  return base;
}
