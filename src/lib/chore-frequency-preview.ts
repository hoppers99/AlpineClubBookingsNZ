import { parseDateOnly } from "@/lib/date-only";

/**
 * The kiosk roster setup wizard's PREVIEW of the server's chore-frequency
 * filter.
 *
 * `filterChoresByFrequency` (src/lib/chore-allocator.ts) decides which chores
 * are due on a roster night when the roster is generated. This function answers
 * the same question for the setup screen, which has to explain the answer
 * before generation happens ("Last done 2 days ago, next due in 1 day"). It
 * cannot simply call the allocator: it works from what the kiosk has in hand —
 * date-only strings from `/api/lodge/roster/[date]/frequency-info` — and it
 * returns a reason to show rather than a filtered list.
 *
 * Because the two must agree, they live as a matched pair: a change to one is a
 * change to the other. It lives here, not inside the page, so it can be tested
 * — a page component's local helper cannot be (#2478).
 */

/** Just the frequency fields, as the kiosk receives a chore template. */
export interface ChoreFrequencyPreviewInput {
  id: string;
  frequencyMode?: string | null;
  frequencyDays?: number | null;
  frequencyDaysOfWeek?: number[] | null;
}

export interface FrequencyInfo {
  choreId: string;
  excluded: boolean;
  reason: string | null;
}

const ISO_DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function computeFrequencyInfo(
  chore: ChoreFrequencyPreviewInput,
  lastRosteredDates: Record<string, string>,
  dateStr: string,
): FrequencyInfo {
  const included: FrequencyInfo = {
    choreId: chore.id,
    excluded: false,
    reason: null,
  };
  const mode = chore.frequencyMode ?? "DAILY";
  if (mode === "DAILY") return included;

  if (mode === "EVERY_X_DAYS") {
    const interval = chore.frequencyDays;
    if (!interval || interval < 2) return included;
    const lastDateStr = lastRosteredDates[chore.id];
    if (!lastDateStr) return included;

    // #2478: both ends are date-only roster nights, so both are parsed at UTC
    // midnight. Parsing them at the BROWSER's local midnight left the gap an
    // hour SHORT of a whole number of days whenever a spring-forward fell
    // between them — 71 hours where three nights had passed, not 72 — and
    // `Math.floor` then lost a whole day: a chore that was due tonight read
    // "next due in 1 day" and was held back. The error is one-sided. The autumn
    // fall-back leaves the gap an hour LONG (73 hours), which still floors to
    // 3, so only the September change misreports, and only until the
    // last-rostered night is itself on the far side of it. Parsing in UTC also
    // keeps this preview in step with the server allocator, which reads the
    // same nights in UTC.
    const lastDate = parseDateOnly(lastDateStr);
    const currentDate = parseDateOnly(dateStr);
    const daysSince = Math.floor(
      (currentDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (daysSince < interval) {
      const due = interval - daysSince;
      return {
        choreId: chore.id,
        excluded: true,
        reason: `Last done ${daysSince} day${daysSince !== 1 ? "s" : ""} ago, next due in ${due} day${due !== 1 ? "s" : ""}`,
      };
    }
    return included;
  }

  if (mode === "SPECIFIC_DAYS") {
    const days = chore.frequencyDaysOfWeek;
    if (!days || days.length === 0) return included;
    // Date-only night parsed at UTC midnight, so the weekday is read with the
    // UTC getter (#2478) — matching `filterChoresByFrequency` on the server.
    const currentDate = parseDateOnly(dateStr);
    const dow = currentDate.getUTCDay() === 0 ? 7 : currentDate.getUTCDay();
    if (!days.includes(dow)) {
      const scheduled = days.map((d) => ISO_DAY_NAMES[d]).join(", ");
      return {
        choreId: chore.id,
        excluded: true,
        reason: `Scheduled for ${scheduled} only`,
      };
    }
    return included;
  }

  return included;
}
