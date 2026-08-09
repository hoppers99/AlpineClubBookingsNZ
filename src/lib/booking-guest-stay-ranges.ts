import {
  addDaysDateOnly,
  formatDateOnlyForTimeZone,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";

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

/**
 * Does this guest hold a bed for the lodge night `night`?
 *
 * A lodge night is one bed held from midday NZ on that date to midday NZ on the
 * following date (INV-DATE-002). So the night a guest checks out is NOT one of
 * theirs — they occupy only its morning half, which is the operational-day
 * question below and never this one. That is why the envelope branch is
 * half-open `[stayStart, stayEnd)`: `stayEnd` is a departure morning, not an
 * occupied night (INV-DATE-003).
 *
 * This is the frozen night-model predicate that capacity, pricing, whole-lodge
 * and member-night logic are built on (INV-DATE-005), and
 * `booking-guest-stay-ranges-contract.test.ts` pins its body byte-for-byte. The
 * set form of exactly this rule is {@link getGuestBedNightKeys}.
 */
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

// ---------------------------------------------------------------------------
// Expanding a stay into nights (#2628)
// ---------------------------------------------------------------------------
//
// `BookingGuestNight` is the canonical night set. `BookingGuest.stayStart` /
// `stayEnd` is a DERIVED half-open envelope whose `stayEnd` is the morning after
// the last night (INV-DATE-012). The two agree for a contiguous stay; for a
// SPARSE (non-contiguous) one the envelope silently fills the internal gaps, so
// anything that expands the envelope when a night set exists reports nights the
// guest is not there.
//
// Six places used to expand a stay and they disagreed. These helpers are the one
// definition (INV-DATE-020); route new callers here rather than writing another
// `eachDateOnlyInRange(guest.stayStart, guest.stayEnd)`.

/**
 * Expand a half-open date-only envelope `[stayStart, stayEnd)` into night keys.
 *
 * **THE MOST DANGEROUS FUNCTION IN THIS FILE. IT IS HALF-OPEN. KEEP IT THAT
 * WAY.** `stayEnd` is a departure morning, never an occupied night
 * (INV-DATE-003), and the bed-allocation planner is fed ONE PSEUDO-GUEST PER
 * NIGHT — each carrying `stayStart = night`, `stayEnd = night + 1`
 * (`candidateGuestBookings` in `admin-bed-allocation.ts`). Make this inclusive
 * and every pseudo-guest grows a phantom second night, so the planner claims the
 * morning-after bed while its real occupant is still in it: a genuine double
 * booking, on the automatic path, silently. `bed-allocation.test.ts` →
 * "pseudo-guest envelope (#2628)" pins that; it is a mutation probe, not
 * decoration.
 *
 * An empty or reversed envelope yields no nights, which is what makes a
 * zero-night booking present on no day (INV-DATE-008).
 */
export function expandStayEnvelopeToNightKeys(
  stayStart: Date,
  stayEnd: Date
): string[] {
  const endKey = dateOnlyKey(stayEnd);
  const keys: string[] = [];
  for (
    let key = dateOnlyKey(stayStart);
    key < endKey;
    key = shiftDateOnlyKey(key, 1)
  ) {
    keys.push(key);
  }
  return keys;
}

/**
 * The explicit night set a guest carries, sorted — or `null` when they carry
 * none and a caller would have to fall back to the envelope.
 *
 * Use this where the surface deliberately places or counts only explicitly
 * listed nights, which is what the bed-allocation board and its lifecycle do:
 * both build their guest-nights straight from `BookingGuestNight` rows, so a
 * guest with none has nothing to allocate and any envelope fallback would
 * advertise work no allocator will ever do. Everywhere else wants
 * {@link getGuestBedNightKeys}.
 */
export function getExplicitGuestBedNightKeys(
  guest: GuestStayRange
): string[] | null {
  const nightKeySet = getGuestNightKeySet(guest);
  return nightKeySet ? [...nightKeySet].sort() : null;
}

/**
 * Every lodge night this guest holds a bed for, sorted.
 *
 * The set form of {@link isGuestActiveOnNight} and identical to it night for
 * night: the explicit night set wins when the guest has one, otherwise the
 * half-open envelope. That equivalence is pinned by
 * `booking-guest-stay-ranges-sparse.test.ts`, so the counting surfaces and the
 * capacity/pricing surfaces cannot disagree about who is in a bed.
 */
export function getGuestBedNightKeys(
  guest: GuestStayRange,
  booking: BookingStayRange
): string[] {
  const explicit = getExplicitGuestBedNightKeys(guest);
  if (explicit) return explicit;
  return expandStayEnvelopeToNightKeys(
    getGuestStayStart(guest, booking),
    getGuestStayEnd(guest, booking)
  );
}

/**
 * The mornings this guest leaves the lodge, sorted — one per SEGMENT, not one
 * per stay.
 *
 * A guest occupies the morning half of the day after each booked night
 * (INV-DATE-004), so a departure morning is the day after a booked night that is
 * not itself booked. A contiguous stay has exactly one, equal to `stayEnd`,
 * which is why this changes nothing for the ordinary case. Nights {10, 12} have
 * TWO: the 11th and the 13th — a guest who leaves and comes back really does
 * depart twice, and a surface keyed on `stayEnd` alone can only ever record the
 * last one.
 */
export function getGuestDepartureMorningKeys(
  guest: GuestStayRange,
  booking: BookingStayRange
): string[] {
  const nightKeys = getGuestBedNightKeys(guest, booking);
  const booked = new Set(nightKeys);
  return nightKeys
    .map((nightKey) => shiftDateOnlyKey(nightKey, 1))
    .filter((morningKey) => !booked.has(morningKey))
    .sort();
}

/** Is `day` one of this guest's departure mornings (per segment)? */
export function isGuestDepartureMorning(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): boolean {
  const dayKey = dateOnlyKey(day);
  return (
    isGuestNightKeyBooked(guest, shiftDateOnlyKey(dayKey, -1), booking) &&
    !isGuestNightKeyBooked(guest, dayKey, booking)
  );
}

/**
 * The next lodge night this guest holds a bed for AFTER `day`, or `null` when
 * `day` is inside or after their last segment.
 *
 * The bound anything scoped to "the segment that just ended" needs. The kiosk's
 * departure sweep is the reason it exists: marking a guest departed clears the
 * chores they can no longer do, and before #2628 the endpoint only ever fired on
 * the morning after the LAST night, so "everything after today" and "the rest of
 * this segment" were the same set. They are not the same set on a sparse stay —
 * a guest booked on nights {11, 14} who checks out on the 12th is BACK on the
 * 14th, and a sweep with no upper bound takes their 14th and 15th with it.
 */
export function getNextGuestBedNightAfter(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): Date | null {
  const dayKey = dateOnlyKey(day);
  const nextKey = getGuestBedNightKeys(guest, booking).find(
    (nightKey) => nightKey > dayKey
  );
  return nextKey ? parseDateOnly(nextKey) : null;
}

/**
 * Is `day` a RETURN — an arrival evening that follows an earlier departure
 * morning of the same stay?
 *
 * Only a sparse stay can have one. For a contiguous stay the single departure
 * morning is `stayEnd`, which is after every booked night, so no arrival evening
 * can follow it and this is false for every day of every contiguous stay —
 * deliberately, because it is what keeps the kiosk's attendance controls exactly
 * where they have always been for the ordinary case.
 *
 * It exists because `BookingGuest.arrivedAt` / `departedAt` is ONE attendance
 * pair for the whole stay: "where is this person now", not a log. A guest who
 * checks out on the 12th and comes back on the 14th arrives against a record
 * that still says "departed", and without this the kiosk hides the arrive button
 * (`!departedAt`) and offers no depart button (not a departure morning), leaving
 * the officer with no control at all on a night the guest is in the building.
 * Marking the return arrival clears the stale departure, so the NEXT check-out
 * records rather than toggling the first one off (#2628).
 */
export function isGuestReturningOnDay(
  guest: GuestStayRange,
  day: Date,
  booking: BookingStayRange
): boolean {
  const dayKey = dateOnlyKey(day);
  if (!getGuestOperationalDayPresence(guest, day, booking).isArriving) {
    return false;
  }
  return getGuestDepartureMorningKeys(guest, booking).some(
    (morningKey) => morningKey < dayKey
  );
}

/**
 * The earliest lodge night whose occupant may still be in the lodge right now:
 * YESTERDAY, not today.
 *
 * Night N runs to midday NZ on date N+1 (INV-DATE-002), so at any moment on day
 * D the person who slept on night D-1 is either still in their bed or has just
 * left it. A guard written `stayDate >= today` forgets them, which is how a bed
 * somebody is lying in can be deleted. Use this as the lower bound of any
 * "is this bed still spoken for?" query.
 *
 * Deliberately NOT for the partner-share sweeps, which DELETE rows: night D-1 is
 * occupancy that has already happened, and past lodge nights are history and
 * stay untouched (INV-CAP-010).
 */
export function getEarliestCurrentBedNightDate(
  today: Date = getTodayDateOnly()
): Date {
  return addDaysDateOnly(today, -1);
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
 *
 * #2628 REPEATS THAT ANSWER, because the request came back in a different
 * shape. "Make this D or D-1" and "make this per-segment" are the same edit as
 * "point it at the operational day", and they have the same consequence on the
 * lobby wall: for nights {10, 12} the wall would read the 11th's departure
 * morning back as a phantom NIGHT, lose sole-occupancy detection, and publish
 * guest names and phone numbers. The genuinely live half of that complaint was
 * the kiosk DEPART lookup, which was keyed on `stayEnd` and so could only ever
 * record a sparse stay's FINAL departure; it now reads
 * {@link isGuestDepartureMorning}, which is per-segment correct, and this
 * predicate did not move.
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
