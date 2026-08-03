import { APP_TIME_ZONE } from "@/config/operational";
import { formatDateOnlyForTimeZone, todayDateOnlyForTimeZone } from "@/lib/date-only";

/**
 * THE shared member-age helper (#2568).
 *
 * Every surface that needs a member's age — the member-detail summary strip and
 * the identity-sensitive Family Group admin workflows — resolves it here.
 * Nothing recomputes age in a component, a route, or a Prisma mapper, and no
 * calculated age is ever stored: it changes on its own every day.
 *
 * Semantics, all deliberate:
 *
 * - **Date-only, on the New Zealand calendar.** A date of birth is a calendar
 *   day, not an instant. `Date` inputs are read through the club time zone with
 *   the same `formatDateOnlyForTimeZone` the family-group screens already use to
 *   RENDER a date of birth, so a displayed date and the age derived from it can
 *   never disagree by a day. "Today" defaults to the club's calendar date
 *   (`todayDateOnlyForTimeZone`), never the server's or the browser's UTC date —
 *   reading `new Date()` in UTC puts "today" a day behind New Zealand for the
 *   first 12-13 hours of every NZ day, which is exactly the off-by-one that
 *   would show an admin "18 years" on the morning of a member's 19th birthday.
 * - **Reference date is injectable** so tests are deterministic (and so a caller
 *   with an explicit as-at date can pass it).
 * - **29 February birthdays clamp to 28 February in a non-leap year.** The
 *   anniversary day is `min(dobDay, daysInTargetMonth)`, so a leap-day member
 *   counts the new year on 28 February rather than on 1 March. This is the
 *   behaviour the member-detail strip has always had, and for an identity check
 *   a one-day convention difference cannot change which person a name matches.
 * - **A date of birth in the future has no age**, so it resolves to `null` /
 *   "Age unavailable" rather than "0 years" — a mistyped year must read as
 *   unusable, not as a newborn.
 */

interface DateParts {
  year: number;
  month: number;
  day: number;
}

const EXACT_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// A bare date-only value that carries a time as well — what a `Date` becomes on
// the way through JSON. Nothing else is accepted as a string: `new Date()` still
// falls back to a locale-dependent legacy parser, and "01/02/2003" silently
// resolving to 2 January (US reading) rather than 1 February is exactly the kind
// of ambiguity an identity check must refuse instead of guess at.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]/;

function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of `month`.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0);
  return probe.getUTCDate();
}

function partsFromDateOnlyString(value: string): DateParts | null {
  const match = value.match(EXACT_DATE_ONLY);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return { year, month, day };
}

/**
 * The calendar day a date-of-birth value denotes, in the club time zone.
 *
 * A bare `yyyy-MM-dd` string is already a calendar day and is taken as written.
 * Anything else (a Prisma `Date`, or the ISO timestamp that same value becomes
 * once it is JSON-serialised) is resolved through the club zone, so the two
 * representations of one stored value always agree.
 */
function parseDateOnlyParts(value: Date | string | null | undefined): DateParts | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "string") {
    const exact = partsFromDateOnlyString(value);
    if (exact) return exact;
    if (!ISO_DATE_TIME.test(value)) return null;
  }

  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return null;

  try {
    return partsFromDateOnlyString(formatDateOnlyForTimeZone(instant, APP_TIME_ZONE));
  } catch {
    return null;
  }
}

function comparableDay(parts: DateParts): number {
  return parts.year * 10_000 + parts.month * 100 + parts.day;
}

function anniversaryDay(dateOfBirth: DateParts, year: number, month: number) {
  return Math.min(dateOfBirth.day, daysInMonth(year, month));
}

function isBeforeBirthdayInYear(dateOfBirth: DateParts, asOfDate: DateParts) {
  const birthdayDay = anniversaryDay(dateOfBirth, asOfDate.year, dateOfBirth.month);
  return (
    asOfDate.month < dateOfBirth.month ||
    (asOfDate.month === dateOfBirth.month && asOfDate.day < birthdayDay)
  );
}

/** Completed years, and completed months since the last birthday. */
export interface MemberAgeParts {
  years: number;
  months: number;
}

/**
 * Completed years and months between a date of birth and a reference date, or
 * `null` when the date of birth is missing, unparseable, or in the future.
 *
 * `referenceDate` defaults to the club's current calendar date.
 */
export function calculateMemberAgeParts(
  dateOfBirth: Date | string | null | undefined,
  referenceDate?: Date | string
): MemberAgeParts | null {
  const dob = parseDateOnlyParts(dateOfBirth);
  const asOf =
    referenceDate === undefined
      ? partsFromDateOnlyString(todayDateOnlyForTimeZone())
      : parseDateOnlyParts(referenceDate);
  if (!dob || !asOf) return null;

  // No age exists before a person is born; a future value is bad data.
  if (comparableDay(dob) > comparableDay(asOf)) return null;

  let years = asOf.year - dob.year;
  if (isBeforeBirthdayInYear(dob, asOf)) {
    years -= 1;
  }

  let months = asOf.month - dob.month;
  if (months < 0) months += 12;

  // Only whole months count: the monthly anniversary has to have passed.
  const monthlyAnniversaryDay = anniversaryDay(dob, asOf.year, asOf.month);
  if (asOf.day < monthlyAnniversaryDay) {
    months -= 1;
  }
  if (months < 0) months += 12;

  return { years, months };
}

function pluralise(value: number, noun: "year" | "month") {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function formatYearsMonths(parts: MemberAgeParts) {
  return `${pluralise(parts.years, "year")} ${pluralise(parts.months, "month")}`;
}

/**
 * Completed years and months, always both, or `null` when no age can be
 * derived. Used by the member-detail summary strip, which shows the exact age
 * beside the stored date of birth.
 */
export function formatAgeYearsMonths(
  dateOfBirth: Date | string | null | undefined,
  asOfDate?: Date | string
): string | null {
  const parts = calculateMemberAgeParts(dateOfBirth, asOfDate);
  return parts ? formatYearsMonths(parts) : null;
}

/** Rendered whenever a member's age cannot be derived (#2568). */
export const AGE_UNAVAILABLE_LABEL = "Age unavailable";

/**
 * Below this age the months component is shown too: for an infant or toddler
 * "3 years" is not enough to tell two siblings apart, and a bare "0 years"
 * says almost nothing.
 */
export const AGE_MONTHS_SHOWN_BELOW_YEARS = 5;

/**
 * The age label an authorised administrator sees while confirming WHICH member
 * record an identity-sensitive Family Group action applies to (#2568).
 *
 * "47 years" from 5 years old up, "3 years 8 months" below that, and
 * "Age unavailable" when there is no usable date of birth. Always computed
 * server-side and sent as this finished string, so the date of birth itself
 * does not have to reach the browser.
 */
export function formatMemberIdentityAge(
  dateOfBirth: Date | string | null | undefined,
  referenceDate?: Date | string
): string {
  const parts = calculateMemberAgeParts(dateOfBirth, referenceDate);
  if (!parts) return AGE_UNAVAILABLE_LABEL;
  if (parts.years >= AGE_MONTHS_SHOWN_BELOW_YEARS) {
    return pluralise(parts.years, "year");
  }
  return formatYearsMonths(parts);
}
