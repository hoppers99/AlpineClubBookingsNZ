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
