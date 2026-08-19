/**
 * The lodge-night range the bed board and its ranged operations are expressed
 * in (#2688).
 *
 * Date-only, half-open: `from` is the first night and `to` is the date-out
 * column, never the last night (INV-DATE-002). Distinct from
 * `bed-allocation-board-window.ts`, which is the client-side window arithmetic
 * for stepping the board around; this is the server-side parse and the shape
 * every reader and writer passes about.
 */
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { BedAllocationAdminError } from "@/lib/bed-allocation-admin-contract";

export const MAX_BED_ALLOCATION_RANGE_NIGHTS = 31;

export interface BedAllocationDateRange {
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
}

export function parseBedAllocationDateRange(input: {
  from?: string | null;
  to?: string | null;
}): BedAllocationDateRange {
  const fromDate = input.from || formatDateOnly(getTodayDateOnly());
  if (!isDateOnlyString(fromDate)) {
    throw new BedAllocationAdminError("Invalid from date", 400);
  }

  const from = parseDateOnly(fromDate);
  const toDate = input.to || formatDateOnly(addDaysDateOnly(from, 7));
  if (!isDateOnlyString(toDate)) {
    throw new BedAllocationAdminError("Invalid to date", 400);
  }

  const to = parseDateOnly(toDate);
  if (to <= from) {
    throw new BedAllocationAdminError("Date out must be after date in", 400);
  }

  const nights = eachDateOnlyInRange(from, to).length;
  if (nights > MAX_BED_ALLOCATION_RANGE_NIGHTS) {
    throw new BedAllocationAdminError(
      `Date range cannot exceed ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights`,
      400,
    );
  }

  return { from, to, fromDate, toDate };
}

export function overlapsDateRange(
  stayStart: Date,
  stayEnd: Date,
  range: BedAllocationDateRange,
) {
  return stayStart < range.to && stayEnd > range.from;
}

export function clampGuestToRange(
  guest: { stayStart: Date; stayEnd: Date },
  range: { from: Date; to: Date },
) {
  return {
    stayStart: guest.stayStart > range.from ? guest.stayStart : range.from,
    stayEnd: guest.stayEnd < range.to ? guest.stayEnd : range.to,
  };
}
