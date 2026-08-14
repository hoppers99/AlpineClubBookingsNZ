import { formatDateOnly } from "@/lib/date-only";

/**
 * Date-only arithmetic for the edit panel's stay envelope.
 *
 * Moved verbatim from `edit-booking-panel.tsx` (#2690). Every value here is an
 * NZ date-only lodge night (`yyyy-mm-dd`), shifted through UTC midnight and
 * re-encoded by the shared `formatDateOnly` — never through a local-time Date,
 * which is what makes the day slide for a booker browsing from overseas.
 */

export function shiftDateKey(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return formatDateOnly(parsed);
}

/** All night keys (yyyy-mm-dd) from checkIn (inclusive) to checkOut (exclusive). */
export function eachNightKey(checkIn: string, checkOut: string): string[] {
  const keys: string[] = [];
  let current = checkIn;
  for (let i = 0; current < checkOut && i < 1000; i++) {
    keys.push(current);
    current = shiftDateKey(current, 1);
  }
  return keys;
}

export function previousDateOnly(dateString: string | null) {
  if (!dateString) return null;
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return formatDateOnly(date);
}

export function shiftDateOnly(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateString;
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}
