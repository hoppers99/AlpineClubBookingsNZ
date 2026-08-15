/**
 * What a range assignment reports back (#2251, extracted #2688).
 *
 * The refusal categories, the per-night refusal shape, the result envelope and
 * the night-run summariser that renders a bounded night list for a human. Types
 * and pure formatting only — no database client — so the admin dialog can name
 * these shapes without the server module reaching its bundle.
 */
import type { BedAllocation } from "@prisma/client";
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";

// Independent of MAX_BED_ALLOCATION_RANGE_NIGHTS, which bounds the BOARD's read
// window (parseBedAllocationDateRange) and the board's own bulk drop. Nothing in
// the capacity or locking model bounds an allocation WRITE at 31 nights: lodge
// capacity is `lodgeBed.count({ active: true })` and never reads BedAllocation
// rows (lodge-capacity.ts), no capacity/advisory lock is taken on any allocation
// write path, and the lifecycle auto-allocator already writes a booking's whole
// (unbounded) stay in one createMany. This cap therefore exists only to keep one
// transaction's size finite and its payload reviewable; it is REFUSED at, never
// silently truncated to.
export const MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS = 366;

export type BedRangeRefusalCategory =
  | "EXCLUSIVE_HOLD"
  | "GUEST_NOT_BOOKED"
  // #2286: the bed is held for a season by a custodian on that night. Its own
  // category, never merged into BED_TAKEN: there is no occupying booking to
  // name and the admin's fix is a different page (Hut Leaders, not the board).
  | "CUSTODIAN_HOLD"
  | "BED_TAKEN";

export interface BedRangeRefusal {
  stayDate: string;
  category: BedRangeRefusalCategory;
  // BED_TAKEN only. `holdsCapacity: false` is the "Provisional" badge — the
  // occupant does not hold the night, but it is still a conflict (#2251
  // decision 2: nothing is silently overwritten).
  occupiedBy?: {
    guestName: string;
    memberName: string;
    bookingId: string;
    holdsCapacity: boolean;
  };
  // EXCLUSIVE_HOLD only, and always the guest's OWN booking — the only hold this
  // path refuses on. `ownBooking` stays on the wire so the dialog's wording (and
  // any future cross-booking rule) has an explicit signal rather than an
  // assumption.
  hold?: {
    bookingId: string;
    memberName: string;
    ownBooking: boolean;
  };
}

export interface AssignBedRangeResult {
  // False whenever nothing was written — either the atomic attempt was refused,
  // or the admin's explicit night list turned out to be blocked too.
  applied: boolean;
  // True when the admin sent an explicit `nights` subset rather than asking for
  // the whole range: a partial write they chose, night by night.
  partialByConsent: boolean;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  bedId: string;
  bedName: string;
  roomName: string;
  // Date-only lodge nights: `fromDate` is the first night, `toDate` the
  // check-out date (exclusive), matching every other bed-allocation endpoint.
  fromDate: string;
  toDate: string;
  requestedNights: string[];
  freeNights: string[];
  writtenNights: string[];
  refusals: BedRangeRefusal[];
  // #1750: partners stranded on a vacated bed-night by this operation. Recorded
  // as ONE batched audit entry inside the same transaction (#2251 residual R4);
  // each listed promotion carries its own booking, because a promoted partner may
  // belong to a different booking than the row that moved.
  promotedPartners: BedAllocation[];
}

// A long range's night list is bounded (366) but noisy in an audit record, so
// contiguous nights collapse into readable runs: ["2026-06-01 → 2026-06-30",
// "2026-07-02"]. The counts recorded alongside stay exact.
export function summariseNightRuns(nights: string[]): string[] {
  const sorted = [...new Set(nights)].sort();
  const runs: string[] = [];
  let runStart: string | null = null;
  let runEnd: string | null = null;

  const flush = () => {
    if (!runStart || !runEnd) return;
    runs.push(runStart === runEnd ? runStart : `${runStart} → ${runEnd}`);
  };

  for (const night of sorted) {
    if (
      runEnd &&
      formatDateOnly(addDaysDateOnly(parseDateOnly(runEnd), 1)) === night
    ) {
      runEnd = night;
      continue;
    }
    flush();
    runStart = night;
    runEnd = night;
  }
  flush();

  return runs;
}

export interface ParsedBedAssignRange {
  from: Date;
  to: Date;
  nights: string[];
}
