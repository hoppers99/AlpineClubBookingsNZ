/**
 * #2628 — one definition of "expand a stay into nights", and it is sparse-aware.
 *
 * `BookingGuestNight` is the canonical night set; `BookingGuest.stayStart` /
 * `stayEnd` is a DERIVED half-open envelope whose `stayEnd` is the morning after
 * the last night (INV-DATE-012). They agree for a contiguous stay. For a sparse
 * one the envelope fills the internal gaps, so six sites that each expanded a
 * stay their own way disagreed about who is in a bed.
 *
 * The fixtures below use nights {10, 12} at July 2026 throughout: one stay, two
 * segments, one gap day. Frozen clock discipline — "today" is 2026-07-01, so
 * these are near-future dates, permanently.
 */
import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import {
  expandStayEnvelopeToNightKeys,
  getEarliestCurrentBedNightDate,
  getExplicitGuestBedNightKeys,
  getGuestBedNightKeys,
  getGuestDepartureMorningKeys,
  isCurrentOrFutureBedNight,
  isGuestActiveOnNight,
  isGuestDepartureMorning,
} from "@/lib/booking-guest-stay-ranges";

const booking = {
  checkIn: parseDateOnly("2026-07-10"),
  checkOut: parseDateOnly("2026-07-13"),
};

/** Nights {10, 12}: in on the 10th, out on the 11th, back on the 12th. */
const sparseGuest = {
  stayStart: parseDateOnly("2026-07-10"),
  stayEnd: parseDateOnly("2026-07-13"),
  nights: [{ stayDate: parseDateOnly("2026-07-10") }, { stayDate: parseDateOnly("2026-07-12") }],
};

/** The same envelope, contiguous — the ordinary case that must not move. */
const contiguousGuest = {
  stayStart: parseDateOnly("2026-07-10"),
  stayEnd: parseDateOnly("2026-07-13"),
  nights: [
    { stayDate: parseDateOnly("2026-07-10") },
    { stayDate: parseDateOnly("2026-07-11") },
    { stayDate: parseDateOnly("2026-07-12") },
  ],
};

/** A pre-#713 guest carrying no night rows at all: envelope is all there is. */
const legacyGuest = {
  stayStart: parseDateOnly("2026-07-10"),
  stayEnd: parseDateOnly("2026-07-13"),
};

describe("expandStayEnvelopeToNightKeys", () => {
  it("is HALF-OPEN: the check-out date is a departure morning, never a night", () => {
    // INV-DATE-003. The single most dangerous line in this area — the planner is
    // fed one pseudo-guest per night with stayEnd = night + 1, so an inclusive
    // expansion is a double booking. `bed-allocation.test.ts` →
    // "pseudo-guest envelope (#2628)" pins the consequence.
    expect(
      expandStayEnvelopeToNightKeys(parseDateOnly("2026-07-10"), parseDateOnly("2026-07-13")),
    ).toEqual(["2026-07-10", "2026-07-11", "2026-07-12"]);
  });

  it("gives a one-night envelope exactly one night", () => {
    expect(
      expandStayEnvelopeToNightKeys(parseDateOnly("2026-07-10"), parseDateOnly("2026-07-11")),
    ).toEqual(["2026-07-10"]);
  });

  it("gives a zero-night or reversed envelope no nights at all", () => {
    // INV-DATE-008: checkIn == checkOut expands to nothing and is present on no
    // day. Reversed is not a legal shape, and yielding nothing is the safe read.
    expect(
      expandStayEnvelopeToNightKeys(parseDateOnly("2026-07-10"), parseDateOnly("2026-07-10")),
    ).toEqual([]);
    expect(
      expandStayEnvelopeToNightKeys(parseDateOnly("2026-07-13"), parseDateOnly("2026-07-10")),
    ).toEqual([]);
  });
});

describe("getGuestBedNightKeys", () => {
  it("reads the night set for a sparse stay, not the envelope", () => {
    expect(getGuestBedNightKeys(sparseGuest, booking)).toEqual([
      "2026-07-10",
      "2026-07-12",
    ]);
  });

  it("is byte-identical to the envelope for a contiguous stay", () => {
    expect(getGuestBedNightKeys(contiguousGuest, booking)).toEqual([
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
    ]);
    expect(getGuestBedNightKeys(legacyGuest, booking)).toEqual(
      getGuestBedNightKeys(contiguousGuest, booking),
    );
  });

  it("falls back to the booking envelope when the guest carries neither", () => {
    expect(getGuestBedNightKeys({}, booking)).toEqual([
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
    ]);
  });

  it("AGREES WITH isGuestActiveOnNight NIGHT FOR NIGHT", () => {
    // The property that makes this safe to route the counting surfaces at: the
    // set form and the frozen predicate cannot disagree about who holds a bed,
    // so a booking's "expected nights" and capacity's "who is here" stay one
    // answer. Swept over a window wider than the stay on both sides.
    for (const guest of [sparseGuest, contiguousGuest, legacyGuest, {}]) {
      const keys = new Set(getGuestBedNightKeys(guest, booking));
      for (let day = 8; day <= 15; day += 1) {
        const key = `2026-07-${String(day).padStart(2, "0")}`;
        expect(keys.has(key), key).toBe(
          isGuestActiveOnNight(guest, parseDateOnly(key), booking),
        );
      }
    }
  });
});

describe("getExplicitGuestBedNightKeys", () => {
  it("returns the explicit rows, sorted", () => {
    expect(getExplicitGuestBedNightKeys(sparseGuest)).toEqual([
      "2026-07-10",
      "2026-07-12",
    ]);
  });

  it("returns null — never an envelope — when the guest carries no night rows", () => {
    // This is the difference from `getGuestBedNightKeys`, and it is the whole
    // point of having both. The bed-allocation board and its lifecycle place
    // only explicitly listed nights, so a guest with none has nothing to
    // allocate; an envelope fallback there would advertise work on the officer
    // card that the board itself does not list.
    expect(getExplicitGuestBedNightKeys(legacyGuest)).toBeNull();
    expect(getExplicitGuestBedNightKeys({ ...legacyGuest, nights: [] })).toBeNull();
  });
});

describe("departure mornings", () => {
  it("gives a sparse stay ONE PER SEGMENT", () => {
    // Nights {10, 12}: they leave on the 11th, come back that evening, and
    // leave again on the 13th. A surface keyed on `stayEnd` alone sees only the
    // 13th, which is why the kiosk could not record the first departure.
    expect(getGuestDepartureMorningKeys(sparseGuest, booking)).toEqual([
      "2026-07-11",
      "2026-07-13",
    ]);
    expect(isGuestDepartureMorning(sparseGuest, parseDateOnly("2026-07-11"), booking)).toBe(true);
    expect(isGuestDepartureMorning(sparseGuest, parseDateOnly("2026-07-13"), booking)).toBe(true);
  });

  it("gives a contiguous or legacy stay exactly one, equal to stayEnd", () => {
    for (const guest of [contiguousGuest, legacyGuest]) {
      expect(getGuestDepartureMorningKeys(guest, booking)).toEqual(["2026-07-13"]);
      expect(isGuestDepartureMorning(guest, parseDateOnly("2026-07-11"), booking)).toBe(false);
      expect(isGuestDepartureMorning(guest, parseDateOnly("2026-07-13"), booking)).toBe(true);
    }
  });

  it("is NOT presence: a guest mid-stay is not departing", () => {
    // The distinction the kiosk depart endpoint depends on. On the 11th the
    // contiguous guest occupies both halves of the day, so they are present and
    // not departing; the sparse guest occupies only the morning, so they are.
    expect(isGuestDepartureMorning(contiguousGuest, parseDateOnly("2026-07-11"), booking)).toBe(
      false,
    );
    expect(isGuestDepartureMorning(sparseGuest, parseDateOnly("2026-07-11"), booking)).toBe(true);
  });

  it("is not an arrival either", () => {
    expect(isGuestDepartureMorning(sparseGuest, parseDateOnly("2026-07-10"), booking)).toBe(false);
    expect(isGuestDepartureMorning(sparseGuest, parseDateOnly("2026-07-12"), booking)).toBe(false);
  });

  it("gives a guest with no nights no departure mornings", () => {
    expect(
      getGuestDepartureMorningKeys(
        { stayStart: parseDateOnly("2026-07-10"), stayEnd: parseDateOnly("2026-07-10") },
        { checkIn: parseDateOnly("2026-07-10"), checkOut: parseDateOnly("2026-07-10") },
      ),
    ).toEqual([]);
  });
});

describe("the current-or-future bed night boundary", () => {
  // The frozen clock puts "today" at 2026-07-01 (docs/TESTING.md).
  const TODAY = parseDateOnly("2026-07-01");

  it("starts at LAST NIGHT, because its occupant is still in the lodge", () => {
    // Night N runs to midday NZ on date N+1 (INV-DATE-002), so at any moment on
    // day D the person who slept on night D-1 may still be in their bed. A
    // guard written `stayDate >= today` forgets them and lets an admin retire a
    // bed somebody is lying in.
    expect(getEarliestCurrentBedNightDate(TODAY)).toEqual(parseDateOnly("2026-06-30"));
  });

  it("defaults to the club's own today", () => {
    expect(getEarliestCurrentBedNightDate()).toEqual(parseDateOnly("2026-06-30"));
  });

  it("admits last night and tonight, and refuses the night before last", () => {
    expect(isCurrentOrFutureBedNight(parseDateOnly("2026-06-29"), TODAY)).toBe(false);
    expect(isCurrentOrFutureBedNight(parseDateOnly("2026-06-30"), TODAY)).toBe(true);
    expect(isCurrentOrFutureBedNight(parseDateOnly("2026-07-01"), TODAY)).toBe(true);
    expect(isCurrentOrFutureBedNight(parseDateOnly("2026-08-01"), TODAY)).toBe(true);
  });
});
