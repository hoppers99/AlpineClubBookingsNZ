import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { formatNZMonthYear, formatNZTime } from "@/lib/nzst-date";

/**
 * Pure, client-safe date helpers for the month calendar. The grid arithmetic
 * (day keys, month grids, "is today") works in the browser's local time — for a
 * single-club NZ deployment that is the lodge's own timezone, so an event
 * created at "7pm" lands on the 7pm cell. The *display* formatters below
 * instead pin the club's locale and timezone (#2264), so an operator or a TV
 * browser sitting outside New Zealand still reads club time rather than its
 * own. No server-only imports may be added to this module (it is bundled to the
 * client).
 */

// Long weekday-bearing date, e.g. "Thursday, 16 April 2026". Deliberately
// wordier than the shared `formatNZWeekdayDate` ("Thu, 16 Apr 2026") because
// these are single-event headings, not scannable list rows.
const CALENDAR_LONG_DATE = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function weekdayLabels(): string[] {
  return WEEKDAY_LABELS;
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/** Local `YYYY-MM-DD` key for grouping events onto day cells. */
export function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The 6×7 grid of days covering the given month, weeks starting Monday. The
 * leading/trailing days spill into the previous/next month so every week is
 * full — the standard month-calendar layout.
 */
export function buildMonthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  // getDay(): 0=Sun..6=Sat. Convert to Monday-first offset (Mon=0..Sun=6).
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - mondayOffset);
  return Array.from({ length: 42 }, (_, i) => {
    return new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    );
  });
}

/** The inclusive [from, to] instants covering a month's full grid, for the API. */
export function monthGridRange(year: number, month: number): {
  from: Date;
  to: Date;
} {
  const grid = buildMonthGrid(year, month);
  const from = new Date(grid[0]);
  from.setHours(0, 0, 0, 0);
  const to = new Date(grid[grid.length - 1]);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/**
 * Cap on how many day-cells a single event may expand across. A well-formed
 * event never spans a year; this guards against a malformed `endsAt` (e.g. a
 * bad import putting the end centuries in the future) blowing up the loop and
 * the grid. 370 comfortably covers any legitimate multi-day event.
 */
const MAX_EVENT_SPAN_DAYS = 370;

/**
 * Group events by their (local) day key. A multi-day / midnight-spanning event
 * — one whose `endsAt` falls on a later LOCAL calendar day than its `startsAt`
 * — is added to EVERY day it covers, from its start day through its end day
 * inclusive, so it renders on each of those cells. Events with no `endsAt`, an
 * invalid/earlier `endsAt`, or an `endsAt` on the same local day stay in a
 * single bucket.
 */
export function groupEventsByDay(
  events: CalendarEventDTO[],
): Map<string, CalendarEventDTO[]> {
  const byDay = new Map<string, CalendarEventDTO[]>();

  const addToDay = (key: string, event: CalendarEventDTO) => {
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.push(event);
    } else {
      byDay.set(key, [event]);
    }
  };

  for (const event of events) {
    const start = new Date(event.startsAt);
    const startKey = dateKey(start);

    // Single-bucket fast paths: no end, unparseable dates, or an end that does
    // not reach a later local day than the start.
    if (!event.endsAt || Number.isNaN(start.getTime())) {
      addToDay(startKey, event);
      continue;
    }
    const end = new Date(event.endsAt);
    const endKey = dateKey(end);
    if (Number.isNaN(end.getTime()) || endKey <= startKey) {
      // `endKey <= startKey` (lexicographic on zero-padded YYYY-MM-DD works as
      // date order) covers same-day and any end-before-start data.
      addToDay(startKey, event);
      continue;
    }

    // Multi-day: walk local calendar days from the start day through the end
    // day inclusive, capped so a pathological span can't run away.
    const cursor = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
    );
    for (let i = 0; i <= MAX_EVENT_SPAN_DAYS; i++) {
      const key = dateKey(cursor);
      addToDay(key, event);
      if (key === endKey) break;
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // All-day events first, then chronological.
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
    });
  }
  return byDay;
}

export function isSameMonth(date: Date, year: number, month: number): boolean {
  return date.getFullYear() === year && date.getMonth() === month;
}

export function isToday(date: Date): boolean {
  return dateKey(date) === dateKey(new Date());
}

export function formatMonthTitle(year: number, month: number): string {
  // UTC midnight, not local midnight: the label is a pure calendar month, and a
  // local-midnight construction read back in club time would slip to the
  // previous month for a viewer east of New Zealand.
  return formatNZMonthYear(new Date(Date.UTC(year, month, 1)));
}

export function formatTime(iso: string): string {
  return formatNZTime(new Date(iso));
}

/** Short chip/list label for an event's time ("All day", "7:00 pm"). */
export function formatEventTime(event: CalendarEventDTO): string {
  if (event.allDay) return "All day";
  return formatTime(event.startsAt);
}

export function formatEventDateLong(event: CalendarEventDTO): string {
  return CALENDAR_LONG_DATE.format(new Date(event.startsAt));
}

/**
 * Long date label for a `YYYY-MM-DD` day key, used as the day-detail dialog
 * heading. Falls back to the raw key if it is malformed.
 */
export function formatDayKeyLong(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  // UTC midnight: `dayKey` is a date-only value, so a local-midnight parse read
  // back in club time would render the previous day east of New Zealand.
  return CALENDAR_LONG_DATE.format(new Date(Date.UTC(y, m - 1, d)));
}

/** `<input type="date">` value (local YYYY-MM-DD) for an ISO instant. */
export function toDateInputValue(iso: string): string {
  return dateKey(new Date(iso));
}

/** `<input type="time">` value (local HH:MM) for an ISO instant. */
export function toTimeInputValue(iso: string): string {
  const date = new Date(iso);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Build an ISO instant from local date + optional time inputs. */
export function isoFromDateTimeInputs(
  dateValue: string,
  timeValue?: string,
): string | null {
  if (!dateValue) return null;
  const composed = timeValue ? `${dateValue}T${timeValue}` : `${dateValue}T00:00`;
  const parsed = new Date(composed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Whether a save request should carry the recurrence rule.
 *
 * The rule is sent on create, when converting a standalone event to recurring,
 * and on a whole-series edit. It is dropped ONLY when editing a single
 * occurrence of an existing series (that path changes just this occurrence,
 * never the pattern). Extracted from the dialog so the exact decision that once
 * silently swallowed recurrence on create (#calendar-recurring) is unit-tested.
 */
export function shouldIncludeRecurrence(opts: {
  /** Selected repeat value ("NONE" or a frequency). */
  repeat: string;
  /** Editing an existing event (vs creating). */
  isEdit: boolean;
  /** The event being edited already belongs to a series. */
  isSeriesEvent: boolean;
  /** The chosen edit scope. */
  scope: "single" | "series";
}): boolean {
  if (opts.repeat === "NONE") return false;
  return !(opts.isEdit && opts.isSeriesEvent && opts.scope === "single");
}
