import { formatDateOnlyForTimeZone, isDateOnlyString } from "@/lib/date-only";

/**
 * A single included night for a guest. Accepts a Date, a `yyyy-mm-dd`
 * date-only string, or the Prisma `BookingGuestNight` relation row shape so a
 * guest loaded with `include: { nights: true }` can be passed straight through.
 */
export type GuestNightInput = Date | string | { stayDate: Date | string };

export type GuestStayRange = {
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // Explicit set of included nights (issue #713). When present and non-empty,
  // this is the authoritative per-night presence for the guest and overrides
  // the contiguous stayStart/stayEnd envelope. When absent/empty, presence
  // falls back to the envelope — which keeps every read surface that loads only
  // stayStart/stayEnd behaving exactly as before.
  nights?: ReadonlyArray<GuestNightInput> | null;
};

export type BookingStayRange = {
  checkIn: Date;
  checkOut: Date;
};

function dateOnlyKey(value: Date): string {
  return formatDateOnlyForTimeZone(value);
}

/**
 * Derive the date-only key for one explicit night entry, matching the key
 * scheme used everywhere else (NZ time zone via formatDateOnlyForTimeZone).
 */
function nightEntryKey(entry: GuestNightInput): string {
  if (typeof entry === "string") {
    return isDateOnlyString(entry) ? entry : dateOnlyKey(new Date(entry));
  }
  if (entry instanceof Date) {
    return dateOnlyKey(entry);
  }
  return nightEntryKey(entry.stayDate);
}

// Cache the derived key set per `nights` array reference. The capacity and
// pricing loops call isGuestActiveOnNight once per (guest, night), so without
// this each call would rebuild the set; the WeakMap keeps it O(nights) once.
const nightKeySetCache = new WeakMap<object, Set<string>>();

/**
 * The set of date-only keys a guest explicitly stays, or null when the guest
 * has no explicit night set (caller should fall back to the envelope).
 */
function getGuestNightKeySet(
  guest: GuestStayRange
): Set<string> | null {
  const nights = guest.nights;
  if (!nights || nights.length === 0) {
    return null;
  }
  const cached = nightKeySetCache.get(nights as unknown as object);
  if (cached) {
    return cached;
  }
  const set = new Set<string>();
  for (const entry of nights) {
    set.add(nightEntryKey(entry));
  }
  nightKeySetCache.set(nights as unknown as object, set);
  return set;
}

export function getGuestStayStart(
  guest: GuestStayRange,
  booking: BookingStayRange
): Date {
  return guest.stayStart ?? booking.checkIn;
}

export function getGuestStayEnd(
  guest: GuestStayRange,
  booking: BookingStayRange
): Date {
  return guest.stayEnd ?? booking.checkOut;
}

export function isGuestActiveOnNight(
  guest: GuestStayRange,
  night: Date,
  booking: BookingStayRange
): boolean {
  const nightKey = dateOnlyKey(night);

  // Explicit night set wins: a guest is active on a night iff that night is in
  // their set. This correctly handles non-contiguous stays (gaps are absences).
  const nightKeySet = getGuestNightKeySet(guest);
  if (nightKeySet) {
    return nightKeySet.has(nightKey);
  }

  // Fallback: contiguous envelope, half-open [stayStart, stayEnd).
  const stayStartKey = dateOnlyKey(getGuestStayStart(guest, booking));
  const stayEndKey = dateOnlyKey(getGuestStayEnd(guest, booking));

  return stayStartKey <= nightKey && nightKey < stayEndKey;
}

// ---------------------------------------------------------------------------
// The operational day (#2622)
// ---------------------------------------------------------------------------
//
// Owner rule: everyone who stays a night is in the lodge from midday NZ on the
// day they arrive until midday NZ on the day they leave. So an NZ calendar day
// D has two halves and a guest occupies
//
//   the MORNING half of D  iff  D-1 is one of their booked nights
//   the EVENING half of D  iff  D   is one of their booked nights
//
// and they are operationally present on D if they occupy either half. The
// boundary is fixed at midday NZ by definition (epic D-M3): there is no
// setting, no threshold and no time-of-day data anywhere in this file.
//
// This is a PURE per-night rule, so it handles sparse (non-contiguous) stays
// segment by segment (epic D-M4): nights {5, 8} means present on {5, 6, 8, 9},
// and the gap day 7 — adjacent to no booked night — is an absence. A booking
// with zero nights is never operationally present on any day.
//
// The derived labels the chore allocator and the roster badges consume are
// nothing more than which half is occupied:
//
//   isArriving(D)  = evening half only  ("arrives today")
//   isDeparting(D) = morning half only  ("leaves today")
//
// They are never independent data. `isGuestActiveOnNight` — the NIGHT model
// that capacity, pricing and the whole-lodge rules are built on — is untouched
// and deliberately separate; do not conflate the two.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Shift a `yyyy-mm-dd` NZ date-only key by whole days.
 *
 * The key is re-anchored at UTC midnight, which is midday NZ (UTC+12/+13), so
 * adding or subtracting whole days can never land on an NZ daylight-saving
 * transition and roll the calendar day the wrong way.
 */
function shiftDateOnlyKey(key: string, days: number): string {
  return formatDateOnlyForTimeZone(
    new Date(new Date(`${key}T00:00:00.000Z`).getTime() + days * MS_PER_DAY)
  );
}

/**
 * Is `nightKey` one of this guest's booked nights?
 *
 * Deliberately duplicates `isGuestActiveOnNight`'s two branches against a
 * pre-derived key instead of refactoring it: that function is frozen (the
 * capacity, pricing, whole-lodge and multi-date-range suites pin it), so the
 * operational-day rule takes a private copy rather than touching it.
 */
function isGuestNightKeyBooked(
  guest: GuestStayRange,
  nightKey: string,
  booking: BookingStayRange
): boolean {
  const nightKeySet = getGuestNightKeySet(guest);
  if (nightKeySet) {
    return nightKeySet.has(nightKey);
  }
  const stayStartKey = dateOnlyKey(getGuestStayStart(guest, booking));
  const stayEndKey = dateOnlyKey(getGuestStayEnd(guest, booking));
  return stayStartKey <= nightKey && nightKey < stayEndKey;
}

/** Which halves of NZ day `day` a guest occupies, plus the derived labels. */
export type GuestOperationalDayPresence = {
  /** Occupies the pre-midday half: the night BEFORE `day` was booked. */
  morning: boolean;
  /** Occupies the post-midday half: the night OF `day` is booked. */
  evening: boolean;
  /** Occupies either half. */
  present: boolean;
  /** Evening half only — they arrive today. */
  isArriving: boolean;
  /** Morning half only — they leave today. */
  isDeparting: boolean;
};

export function getGuestOperationalDayPresence(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): GuestOperationalDayPresence {
  const dayKey = dateOnlyKey(day);
  const evening = isGuestNightKeyBooked(guest, dayKey, booking);
  const morning = isGuestNightKeyBooked(
    guest,
    shiftDateOnlyKey(dayKey, -1),
    booking
  );
  return {
    morning,
    evening,
    present: morning || evening,
    isArriving: evening && !morning,
    isDeparting: morning && !evening,
  };
}

/**
 * Is the guest in the lodge at any point on NZ day `day`?
 *
 * This is the one named eligibility rule for every operational surface — chore
 * roster generation, roster save/confirm validation and chore cleanup all read
 * it, so they cannot disagree about who was there.
 */
export function isGuestOperationallyPresentOnDay(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): boolean {
  return getGuestOperationalDayPresence(guest, day, booking).present;
}

/** Arrives on `day`: occupies the evening half only. */
export function isGuestArrivingOnDay(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): boolean {
  return getGuestOperationalDayPresence(guest, day, booking).isArriving;
}

/** Leaves on `day`: occupies the morning half only. */
export function isGuestDepartingOnDay(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): boolean {
  return getGuestOperationalDayPresence(guest, day, booking).isDeparting;
}

/** Everyone operationally present on NZ day `day`, in input order. */
export function getOperationallyPresentGuestsForDay<Guest extends GuestStayRange>(
  guests: Guest[] | null | undefined,
  day: Date,
  booking: BookingStayRange
): Guest[] {
  return (guests ?? []).filter((guest) =>
    isGuestOperationallyPresentOnDay(guest, day, booking)
  );
}

export function getActiveGuestsForNight<Guest extends GuestStayRange>(
  guests: Guest[] | null | undefined,
  night: Date,
  booking: BookingStayRange
): Guest[] {
  return (guests ?? []).filter((guest) =>
    isGuestActiveOnNight(guest, night, booking)
  );
}

export function countActiveGuestsForNight(
  guests: GuestStayRange[] | null | undefined,
  night: Date,
  booking: BookingStayRange
): number {
  return getActiveGuestsForNight(guests, night, booking).length;
}

/**
 * LEGACY lodge-date visibility. Frozen, not the operational-day rule (#2622).
 *
 * `includeDepartureDate: false` is the night model and delegates to it — the
 * two branches were byte-equivalent, so that is a proven no-op.
 *
 * `includeDepartureDate: true` deliberately keeps the SHIPPED legacy meaning:
 * an explicit night set admits its own nights plus the single morning after the
 * FINAL listed night, and an envelope stay is the closed range
 * `[stayStart, stayEnd]`. It is NOT `getOperationallyPresentGuestsForDay`.
 *
 * Why it must not be: `lodge-display-state.ts` — the unauthenticated lobby wall
 * — derives its NIGHT counts by subtracting only the envelope end from this
 * list (`getGuestStayEnd(...) !== date`). Give it D-M4 per-segment presence and
 * a sparse stay's mid-stay gap morning is counted as a phantom night, which
 * breaks sole-occupancy detection (issue #58) and flips guest names and phone
 * numbers on and off a public screen. The per-segment rule therefore lives only
 * in the named operational-day helpers, which every converted surface calls
 * directly.
 *
 * #2631 converted the two kiosk read surfaces that used to call this, so the
 * lobby wall is the last caller — and it is a PERMANENT one, not a pending
 * migration. Do not "finish the job" by pointing it at the operational day.
 */
function isGuestVisibleOnLodgeDate(
  guest: GuestStayRange,
  date: Date,
  booking: BookingStayRange,
  options?: { includeDepartureDate?: boolean }
): boolean {
  if (!options?.includeDepartureDate) {
    return isGuestActiveOnNight(guest, date, booking);
  }

  const dateKey = dateOnlyKey(date);

  // For explicit night sets, "visible on a lodge date" means the guest stays
  // that night, plus the morning after their last included night (the
  // checkout-day visibility the board uses).
  const nightKeySet = getGuestNightKeySet(guest);
  if (nightKeySet) {
    if (nightKeySet.has(dateKey)) {
      return true;
    }
    let maxKey: string | null = null;
    for (const key of nightKeySet) {
      if (maxKey === null || key > maxKey) maxKey = key;
    }
    if (maxKey !== null) {
      return dateKey === shiftDateOnlyKey(maxKey, 1);
    }
    return false;
  }

  const stayStartKey = dateOnlyKey(getGuestStayStart(guest, booking));
  const stayEndKey = dateOnlyKey(getGuestStayEnd(guest, booking));

  return stayStartKey <= dateKey && dateKey <= stayEndKey;
}

/**
 * @deprecated (#2622) Call the named model you actually mean:
 * `getOperationallyPresentGuestsForDay` for the operational day, or
 * `getActiveGuestsForNight` for the night model.
 *
 * This wrapper is the LEGACY lodge-date list, unchanged in behaviour — see
 * `isGuestVisibleOnLodgeDate` above for why its `includeDepartureDate: true`
 * branch must not become the operational-day rule. Since #2631 it has exactly
 * one caller, `lodge-display-state.ts` (the fenced, privacy-load-bearing lobby
 * wall), and `booking-guest-stay-ranges-contract.test.ts` freezes that list so
 * no new caller can appear.
 */
export function getLodgeVisibleGuestsForDate<Guest extends GuestStayRange>(
  guests: Guest[] | null | undefined,
  date: Date,
  booking: BookingStayRange,
  options?: { includeDepartureDate?: boolean }
): Guest[] {
  return (guests ?? []).filter((guest) =>
    isGuestVisibleOnLodgeDate(guest, date, booking, options)
  );
}
