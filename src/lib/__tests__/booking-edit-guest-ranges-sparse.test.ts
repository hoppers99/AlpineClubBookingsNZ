/**
 * Editing a booking that is already under way, in two rules that share one
 * function.
 *
 * **#2736 — price the nights a guest holds, not their envelope.**
 * `BookingGuestNight` is the canonical night set; `stayStart`/`stayEnd` is the
 * derived half-open envelope (INV-DATE-012). `buildInProgressGuestRangePlan`
 * used to carry only the envelope, so an edit to a stay in progress priced,
 * quoted and persisted a SPARSE guest as one continuous run — the gap night was
 * charged, written back as a `BookingGuestNight` row and reserved a bed
 * (INV-MOD-025).
 *
 * **#2743 — sell only the nights the edit creates.** The added-nights leg ran
 * from a guest's own last held night to the new check-out whether or not the
 * check-out had moved, so a #713 partial-stay guest who had already gone home
 * was put back on the booking for the rest of its nights and charged for them by
 * an edit that changed nothing else. It now starts at the booking's OLD
 * check-out as well, so `[bookingCheckOut, newCheckOut)` is the only ground it
 * can cover.
 *
 * Three parts to this file, and the FIRST is the one that makes both changes
 * safe:
 *
 *  1. `contiguous stays` re-implements the pre-#2736 arithmetic — untouched by
 *     #2743, so it is still the historical answer — and compares the plan
 *     against it over a matrix of ordinary edits. Every case must either agree
 *     to the cent, to the night and to the thrown error, or differ by EXACTLY
 *     the nights #2743 stops selling, derived from the legacy answer rather than
 *     recomputed from the implementation's own formula. Nothing else may move,
 *     in either direction.
 *  2. `a sparse stay` covers what #2736 changed, including the two shapes where
 *     real money moved the wrong way: a mid-stay REMOVAL and a SHORTENED
 *     check-out both used to refund the guest for gap nights they had never been
 *     charged for in the first place.
 *  3. `#2743` covers the re-admission itself, boundary by boundary — a guest who
 *     is still here, one whose stay ends on the booking's check-out day, and one
 *     who went home a week ago — plus the two things the fix deliberately does
 *     NOT do.
 */
import { describe, expect, it } from "vitest";
import {
  buildInProgressGuestRangePlan,
  type BuildInProgressGuestRangePlanInput,
} from "@/lib/booking-edit-guest-ranges";
import { calculateBookingPrice, type SeasonRateData } from "@/lib/pricing";
import { eachDateOnlyInRange, normalizeDateOnlyForTimeZone } from "@/lib/date-only";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const key = (d: Date) => d.toISOString().slice(0, 10);

const MEMBER_TYPE = "type-member";
const LOW = 5000; // per adult member night, early season
const HIGH = 9000; // per adult member night, from 2026-08-23

/**
 * Two seasons with different nightly rates, so "priced per night" and "one rate
 * times a night count" cannot possibly agree. Every expectation below is built
 * from the per-night rates, never from a multiplication.
 */
const SEASONS: SeasonRateData[] = [
  {
    seasonId: "s-low",
    startDate: D("2026-08-01"),
    endDate: D("2026-08-22"),
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: LOW },
    ],
  },
  {
    seasonId: "s-high",
    startDate: D("2026-08-23"),
    endDate: D("2026-09-30"),
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: HIGH },
    ],
  },
];

/** The season rate for one night, straight off the table above. */
function rateFor(night: string): number {
  return night <= "2026-08-22" ? LOW : HIGH;
}

/** What a set of nights genuinely costs, summed night by night in cents. */
function priceNights(nights: string[]): number {
  return nights.reduce((sum, night) => sum + rateFor(night), 0);
}

type TestGuest = {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: "ADULT";
  isMember: true;
  memberId: string;
  rateMembershipTypeId: string;
  rateSource: "OWN_TYPE";
  stayStart: Date;
  stayEnd: Date;
  // `priceCents` is on the real `BookingGuestNight` row and is what
  // `lockedNightPricesForGuest` reads on the other edit paths — carried here so
  // a test can show whether this plan consults it. Optional, because most cases
  // do not care.
  nights?: Array<{ stayDate: Date; priceCents?: number }>;
  priceCents: number;
};

/**
 * A guest built from the nights they hold. `stayStart`/`stayEnd` is derived the
 * way the writer derives it — first night, last night + 1 — so the envelope and
 * the night rows always agree, exactly as they do in the database.
 *
 * `withNightRows: false` drops the rows and leaves only the envelope: a legacy
 * guest, or one on a booking converted from a request (#2739). That guest must
 * keep behaving exactly as before.
 */
function guestFromNights(
  nights: string[],
  id = "g1",
  withNightRows = true,
): TestGuest {
  const sorted = [...nights].sort();
  const last = sorted[sorted.length - 1];
  return {
    id,
    firstName: "Guest",
    lastName: id,
    ageTier: "ADULT",
    isMember: true,
    memberId: `m-${id}`,
    rateMembershipTypeId: MEMBER_TYPE,
    rateSource: "OWN_TYPE",
    stayStart: D(sorted[0]),
    stayEnd: new Date(D(last).getTime() + 86_400_000),
    ...(withNightRows
      ? { nights: sorted.map((night) => ({ stayDate: D(night) })) }
      : {}),
    priceCents: priceNights(sorted),
  };
}

function planInput(args: {
  guests: TestGuest[];
  editableFrom: string;
  newCheckOut: string;
  removeGuestIds?: string[];
  addGuests?: BuildInProgressGuestRangePlanInput["addGuests"];
  checkIn?: string;
  checkOut?: string;
}): BuildInProgressGuestRangePlanInput {
  const totalPriceCents = args.guests.reduce((s, g) => s + g.priceCents, 0);
  const starts = args.guests.map((g) => g.stayStart.getTime());
  const ends = args.guests.map((g) => g.stayEnd.getTime());
  return {
    booking: {
      checkIn: args.checkIn ? D(args.checkIn) : new Date(Math.min(...starts)),
      checkOut: args.checkOut ? D(args.checkOut) : new Date(Math.max(...ends)),
      totalPriceCents,
      discountCents: 0,
      promoAdjustmentCents: 0,
      finalPriceCents: totalPriceCents,
      guests: args.guests,
    },
    editableFrom: D(args.editableFrom),
    newCheckOut: D(args.newCheckOut),
    seasons: SEASONS,
    ...(args.removeGuestIds ? { removeGuestIds: args.removeGuestIds } : {}),
    ...(args.addGuests ? { addGuests: args.addGuests } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. The safety property: nothing about a contiguous stay moves.
// ---------------------------------------------------------------------------

/**
 * The pre-#2736 arithmetic, re-implemented from the shipped source rather than
 * described: every guest is reduced to `[stayStart, stayEnd)`, the future window
 * is priced as a bare range, and the persisted nights are that range expanded.
 *
 * This exists so "contiguous stays are byte-identical" is a PROOF over a matrix
 * rather than a claim in a PR body. It is deliberately not shared with the
 * implementation — a helper both sides called could drift together and prove
 * nothing.
 *
 * **#2743 deliberately did not touch it.** It is the historical answer, and the
 * matrix now compares against it PLUS a stated correction (`backfilledNights`
 * below) rather than against a second copy of the new formula. That keeps the
 * blast radius measurable: every difference the matrix sees has to be explained
 * by the nights #2743 stops selling, and by nothing else.
 */
function legacyPlan(input: BuildInProgressGuestRangePlanInput) {
  const editableFrom = normalizeDateOnlyForTimeZone(input.editableFrom);
  const bookingCheckIn = normalizeDateOnlyForTimeZone(input.booking.checkIn);
  const bookingCheckOut = normalizeDateOnlyForTimeZone(input.booking.checkOut);
  const newCheckOut = normalizeDateOnlyForTimeZone(input.newCheckOut);
  const addGuests = input.addGuests ?? [];
  const removeSet = new Set(input.removeGuestIds ?? []);
  const max = (a: Date, b: Date) => (a > b ? a : b);
  const min = (a: Date, b: Date) => (a < b ? a : b);

  if (newCheckOut < editableFrom) {
    throw new Error("Check-out cannot move before NZ tomorrow");
  }
  if (addGuests.length > 0 && newCheckOut <= editableFrom) {
    throw new Error("Guests can only be added when the booking has future nights");
  }

  const priceRange = (
    start: Date,
    end: Date,
    guest: { ageTier: "ADULT"; isMember: boolean; rateMembershipTypeId: string },
  ) => {
    const s = normalizeDateOnlyForTimeZone(start);
    const e = normalizeDateOnlyForTimeZone(end);
    if (e <= s) return 0;
    return calculateBookingPrice(
      s,
      e,
      [
        {
          ageTier: guest.ageTier,
          isMember: guest.isMember,
          rateMembershipTypeId: guest.rateMembershipTypeId,
        },
      ],
      input.seasons,
    ).totalPriceCents;
  };

  const existing = input.booking.guests.map((guest) => {
    const stayStart = normalizeDateOnlyForTimeZone(guest.stayStart ?? bookingCheckIn);
    const stayEnd = normalizeDateOnlyForTimeZone(guest.stayEnd ?? bookingCheckOut);
    const oldFuturePriceCents = priceRange(
      max(stayStart, editableFrom),
      stayEnd,
      guest as never,
    );
    const removedFromFuture = removeSet.has(guest.id);
    const proposedStayEnd = removedFromFuture
      ? min(stayEnd, editableFrom)
      : newCheckOut;
    const futureStart = max(stayStart, min(editableFrom, stayEnd));
    const newFuturePriceCents = removedFromFuture
      ? 0
      : priceRange(futureStart, proposedStayEnd, guest as never);
    const futureDeltaCents = newFuturePriceCents - oldFuturePriceCents;
    return {
      id: guest.id,
      stayStart,
      stayEnd: proposedStayEnd,
      // The guest's stay end BEFORE the edit. Carried only so the #2743
      // correction below can be derived from this answer; the arithmetic above
      // is untouched.
      originalStayEnd: stayEnd,
      futureStart,
      removedFromFuture,
      priceCents: guest.priceCents + futureDeltaCents,
      oldFuturePriceCents,
      newFuturePriceCents,
      futureDeltaCents,
      // What `splitContiguousNights` used to expand, and what `syncGuestNights`
      // then wrote back as this guest's night rows.
      nights: eachDateOnlyInRange(stayStart, proposedStayEnd).map(key),
    };
  });

  const added = addGuests.map((guest) => ({
    stayStart: editableFrom,
    stayEnd: newCheckOut,
    priceCents: priceRange(editableFrom, newCheckOut, guest as never),
    nights: eachDateOnlyInRange(editableFrom, newCheckOut).map(key),
  }));

  const futureActiveGuestCount =
    existing.filter((e) => !e.removedFromFuture && e.futureStart < e.stayEnd)
      .length + added.length;
  if (newCheckOut > editableFrom && futureActiveGuestCount === 0) {
    throw new Error("Booking must have at least one guest for future nights");
  }

  const newTotalPriceCents =
    existing.reduce((s, e) => s + e.priceCents, 0) +
    added.reduce((s, a) => s + a.priceCents, 0);

  return {
    existing,
    added,
    futureActiveGuestCount,
    newTotalPriceCents,
    newFinalPriceCents: newTotalPriceCents + input.booking.promoAdjustmentCents,
    priceDiffCents:
      newTotalPriceCents +
      input.booking.promoAdjustmentCents -
      input.booking.finalPriceCents,
    futureExistingDeltaCents: existing.reduce((s, e) => s + e.futureDeltaCents, 0),
    capacityGuestRanges: [
      ...existing
        .filter((e) => !e.removedFromFuture && e.futureStart < e.stayEnd)
        .map((e) => ({ stayStart: e.futureStart, stayEnd: e.stayEnd })),
      ...added.map((a) => ({ stayStart: a.stayStart, stayEnd: a.stayEnd })),
    ],
  };
}

function run<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * The nights the PRE-#2743 arithmetic sold this guest between their own last
 * night and the booking's OLD check-out — the back-fill the fix stops, and the
 * only thing that may differ between the legacy answer and the plan.
 *
 * Derived entirely from the legacy entry (`futureStart`, the guest's original
 * `stayEnd`, and the proposed one) plus the booking's stored check-out, so it
 * states the CLAIM — "an edit stops selling nights it did not create" — instead
 * of re-running the implementation's own `maxDate(...)` chain and agreeing with
 * it by construction.
 */
function backfilledNights(
  entry: { originalStayEnd: Date; stayEnd: Date; futureStart: Date },
  bookingCheckOut: Date,
): string[] {
  const from =
    entry.futureStart > entry.originalStayEnd
      ? entry.futureStart
      : entry.originalStayEnd;
  const bound = from > bookingCheckOut ? from : bookingCheckOut;
  const to = bound < entry.stayEnd ? bound : entry.stayEnd;
  return eachDateOnlyInRange(from, to).map(key);
}

describe("#2736/#2743 contiguous stays", () => {
  // Ordinary stays, one per row: the nights the guest holds, then every edit
  // window and new check-out worth trying against them. Deliberately spans the
  // 08-22/08-23 season boundary in both directions so a rate change inside the
  // repriced window is exercised, not just a flat rate.
  const STAYS: string[][] = [
    ["2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"],
    ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23"],
    ["2026-08-22", "2026-08-23", "2026-08-24"],
    ["2026-08-24"],
  ];
  // The booking every case is an edit to. Three of the four stays above finish
  // before it does, which is exactly the #713 partial-stay shape #2743 is about
  // — so this matrix is not only the safety net for #2736, it is also where the
  // new rule's blast radius is measured.
  const BOOKING_CHECK_IN = "2026-08-18";
  const BOOKING_CHECK_OUT_KEY = "2026-08-25";
  const BOOKING_CHECK_OUT = D(BOOKING_CHECK_OUT_KEY);
  const EDITABLE_FROM = [
    "2026-08-19",
    "2026-08-21",
    "2026-08-22",
    "2026-08-23",
    "2026-08-25",
    "2026-08-26",
  ];
  const NEW_CHECK_OUT = [
    "2026-08-21",
    "2026-08-23",
    "2026-08-25",
    "2026-08-26",
    "2026-08-28",
  ];

  const cases: Array<{
    name: string;
    input: () => BuildInProgressGuestRangePlanInput;
  }> = [];
  for (const [stayIndex, stay] of STAYS.entries()) {
    for (const withNightRows of [true, false]) {
      for (const editableFrom of EDITABLE_FROM) {
        for (const newCheckOut of NEW_CHECK_OUT) {
          for (const removed of [false, true]) {
            cases.push({
              name: `stay#${stayIndex} rows=${withNightRows} from=${editableFrom} to=${newCheckOut} removed=${removed}`,
              input: () =>
                planInput({
                  // A second, always-contiguous guest so a removal does not
                  // trivially empty the booking on every row.
                  guests: [
                    guestFromNights(stay, "g1", withNightRows),
                    guestFromNights(
                      ["2026-08-20", "2026-08-21", "2026-08-22"],
                      "g2",
                      withNightRows,
                    ),
                  ],
                  editableFrom,
                  newCheckOut,
                  ...(removed ? { removeGuestIds: ["g1"] } : {}),
                  checkIn: BOOKING_CHECK_IN,
                  checkOut: BOOKING_CHECK_OUT_KEY,
                }),
            });
          }
        }
      }
    }
  }

  it(`differs from the pre-#2736 arithmetic by exactly the back-filled nights, on all ${cases.length} ordinary edits`, () => {
    expect(cases.length).toBeGreaterThan(400);
    // How the 480 land. Pinned so a later change cannot quietly move cases
    // between buckets.
    //
    // Read the proportions as a property of THIS matrix, not of the club's
    // diary: three of its four stays deliberately finish before the booking
    // does, and so does the companion guest, because that is the shape under
    // test. A booking whose guests all stay to the check-out — the ordinary one
    // — lands in `identical` every time, which is what the #2029 suite and the
    // whole-run guest in the #2743 block below demonstrate directly.
    let identical = 0;
    let corrected = 0;
    let refused = 0;

    for (const testCase of cases) {
      const legacy = run(() => legacyPlan(testCase.input()));
      const current = run(() => buildInProgressGuestRangePlan(testCase.input()));

      if (!legacy.ok) {
        // A refusal the pre-#2736 arithmetic already made. #2743 only ever
        // withholds nights, so it can never turn one of these back into a save.
        expect(current.ok, testCase.name).toBe(false);
        expect(current.ok ? "" : current.error, testCase.name).toBe(legacy.error);
        identical += 1;
        continue;
      }

      const before = legacy.value;

      // The corrected expectation: the legacy answer with the back-filled
      // nights taken out of it, guest by guest. Everything else — the old-price
      // leg, the futureStart anchor, the proposed envelope, the added guests —
      // must be untouched.
      const backfill = before.existing.map((entry) =>
        backfilledNights(entry, BOOKING_CHECK_OUT),
      );
      const withheldTotalCents = backfill.reduce(
        (sum, nights) => sum + priceNights(nights),
        0,
      );
      const expectedExisting = before.existing.map((entry, index) => {
        const withheld = new Set(backfill[index]);
        const withheldCents = priceNights(backfill[index]);
        const nights = entry.nights.filter((night) => !withheld.has(night));
        return {
          id: entry.id,
          stayStart: key(entry.stayStart),
          stayEnd: key(entry.stayEnd),
          futureStart: key(entry.futureStart),
          priceCents: entry.priceCents - withheldCents,
          oldFuturePriceCents: entry.oldFuturePriceCents,
          newFuturePriceCents: entry.newFuturePriceCents - withheldCents,
          futureDeltaCents: entry.futureDeltaCents - withheldCents,
          removedFromFuture: entry.removedFromFuture,
          nights,
          futureNights: nights.filter((night) => night >= key(entry.futureStart)),
        };
      });
      const expectedActive = expectedExisting.filter(
        (entry) => !entry.removedFromFuture && entry.futureNights.length > 0,
      );
      const expectedActiveCount = expectedActive.length + before.added.length;

      if (
        expectedActiveCount === 0 &&
        testCase.input().newCheckOut > testCase.input().editableFrom
      ) {
        // Nobody is left holding a future night once the back-fill stops, so the
        // save is refused instead of quietly selling those nights to a guest who
        // has gone. Which of the two sentences it uses is pinned by name in the
        // #2743 block below, not guessed at here.
        expect(current.ok, testCase.name).toBe(false);
        expect(current.ok ? "" : current.error, testCase.name).toMatch(
          /(No remaining guest is booked for a night on or after|at least one guest for future nights)/,
        );
        refused += 1;
        continue;
      }

      expect(current.ok, testCase.name).toBe(true);
      if (!current.ok) continue;
      const plan = current.value;

      expect(plan.newTotalPriceCents, testCase.name).toBe(
        before.newTotalPriceCents - withheldTotalCents,
      );
      expect(plan.newFinalPriceCents, testCase.name).toBe(
        before.newFinalPriceCents - withheldTotalCents,
      );
      expect(plan.priceDiffCents, testCase.name).toBe(
        before.priceDiffCents - withheldTotalCents,
      );
      expect(plan.futureExistingDeltaCents, testCase.name).toBe(
        before.futureExistingDeltaCents - withheldTotalCents,
      );
      expect(plan.futureActiveGuestCount, testCase.name).toBe(expectedActiveCount);

      expect(
        plan.proposedExistingGuests.map((entry) => ({
          id: entry.guest.id,
          stayStart: key(entry.stayStart),
          stayEnd: key(entry.stayEnd),
          futureStart: key(entry.futureStart),
          priceCents: entry.priceCents,
          oldFuturePriceCents: entry.oldFuturePriceCents,
          newFuturePriceCents: entry.newFuturePriceCents,
          futureDeltaCents: entry.futureDeltaCents,
          removedFromFuture: entry.removedFromFuture,
          nights: entry.nights.map(key),
          futureNights: entry.futureNights.map(key),
        })),
        testCase.name,
      ).toEqual(expectedExisting);

      expect(
        plan.capacityGuestRanges.map((range) => ({
          stayStart: key(range.stayStart),
          stayEnd: key(range.stayEnd),
          nights: range.nights.map(key),
        })),
        testCase.name,
      ).toEqual([
        ...expectedActive.map((entry) => ({
          stayStart: entry.futureStart,
          stayEnd: entry.stayEnd,
          nights: entry.futureNights,
        })),
        ...before.added.map((range) => ({
          stayStart: key(range.stayStart),
          stayEnd: key(range.stayEnd),
          nights: range.nights,
        })),
      ]);

      if (withheldTotalCents === 0) {
        identical += 1;
        // Untouched by #2743, so the whole #2736 property still holds here: the
        // `nights` on a capacity range are the old envelope expanded, and
        // `countActiveGuestsForNight` sees the identical occupancy.
        for (const range of plan.capacityGuestRanges) {
          expect(range.nights.map(key), testCase.name).toEqual(
            eachDateOnlyInRange(range.stayStart, range.stayEnd).map(key),
          );
        }
      } else {
        corrected += 1;
        // The direction is the whole point: an edit can only ever cost the
        // member LESS than it did, never more.
        expect(withheldTotalCents, testCase.name).toBeGreaterThan(0);
        expect(plan.priceDiffCents, testCase.name).toBeLessThan(
          before.priceDiffCents,
        );
      }
    }

    // All ten refusals are the same edit: the window opens on the 23rd, the
    // check-out stays on the 25th, and once the back-fill stops nobody holds the
    // 23rd or the 24th. The pre-#2743 arithmetic let that save through by
    // re-admitting and charging a guest who had gone; refusing it is the
    // corrected answer, and the message names the check-out that fits who is
    // actually there.
    expect({ identical, corrected, refused }).toEqual({
      identical: 200,
      corrected: 270,
      refused: 10,
    });
    expect(identical + corrected + refused).toBe(cases.length);
  });

  it("agrees on an added guest too, whose window this plan still owns", () => {
    const input = () =>
      planInput({
        guests: [guestFromNights(["2026-08-20", "2026-08-21", "2026-08-22"])],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-26",
        addGuests: [
          {
            firstName: "New",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m-new",
            rateMembershipTypeId: MEMBER_TYPE,
            rateSource: "OWN_TYPE",
          },
        ],
      });

    const plan = buildInProgressGuestRangePlan(input());
    const before = legacyPlan(input());

    expect(plan.proposedAddedGuests[0].priceCents).toBe(before.added[0].priceCents);
    expect(plan.proposedAddedGuests[0].nights.map(key)).toEqual(before.added[0].nights);
    // Stated, because it is the deliberate NON-change: an added guest is
    // admitted for the booking's remaining future nights, contiguously, and this
    // plan still overrides any per-guest range the request carried.
    expect(plan.proposedAddedGuests[0].nights.map(key)).toEqual([
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. What the fix changes.
// ---------------------------------------------------------------------------

describe("#2736 a sparse stay", () => {
  // Nights 20 and 22 — home on the 21st. Priced 5000 + 5000, both low season.
  const SPARSE = ["2026-08-20", "2026-08-22"];
  const COMPANION = ["2026-08-20", "2026-08-21", "2026-08-22"];

  it("keeps the gap when the check-out is extended, and charges only the new nights", () => {
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [guestFromNights(SPARSE)],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-25",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // The 21st is still an absence; 23 and 24 are the genuinely-new nights.
    expect(entry.nights.map(key)).toEqual([
      "2026-08-20",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
    ]);
    // Priced per night across the season boundary: 22 is low, 23 and 24 high.
    expect(entry.futureDeltaCents).toBe(HIGH + HIGH);
    expect(entry.priceCents).toBe(priceNights([...SPARSE, "2026-08-23", "2026-08-24"]));
    // Not a rate times a night count: the two added nights are the dearer ones.
    expect(entry.futureDeltaCents).not.toBe(2 * LOW);
  });

  it("does not refund the gap night when the guest is removed mid-stay", () => {
    // The money defect in its sharpest form. The guest slept on the 20th and is
    // taken off the rest of the booking on the 21st. Charging them for the night
    // they slept is the whole point; the envelope maths refunded 20 AND 21.
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [guestFromNights(SPARSE), guestFromNights(COMPANION, "g2")],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-23",
        removeGuestIds: ["g1"],
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.removedFromFuture).toBe(true);
    // They keep the 20th and pay for it.
    expect(entry.nights.map(key)).toEqual(["2026-08-20"]);
    expect(entry.priceCents).toBe(priceNights(["2026-08-20"]));
    expect(entry.futureDeltaCents).toBe(-priceNights(["2026-08-22"]));
    // The envelope answer was 2 x LOW off, which zeroed a guest who had stayed.
    expect(entry.priceCents).not.toBe(0);
  });

  it("does not refund the gap nights when the check-out is shortened", () => {
    const nights = ["2026-08-20", "2026-08-22", "2026-08-24"];
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [guestFromNights(nights)],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-23",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.nights.map(key)).toEqual(["2026-08-20", "2026-08-22"]);
    // Only the 24th is given up.
    expect(entry.futureDeltaCents).toBe(-priceNights(["2026-08-24"]));
    expect(entry.priceCents).toBe(priceNights(["2026-08-20", "2026-08-22"]));
    // The envelope answer dropped [23, 25) — the 23rd was never theirs.
    expect(entry.priceCents).not.toBe(
      priceNights(nights) - priceNights(["2026-08-23", "2026-08-24"]),
    );
  });

  it("does not claim a bed on the gap night", () => {
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [guestFromNights(SPARSE)],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-24",
      }),
    );

    expect(plan.capacityGuestRanges).toHaveLength(1);
    expect(plan.capacityGuestRanges[0].nights.map(key)).toEqual([
      "2026-08-22",
      "2026-08-23",
    ]);
    // The window is unchanged and still opens at editableFrom — it bounds which
    // nights are examined; the night set decides which are occupied.
    expect(key(plan.capacityGuestRanges[0].stayStart)).toBe("2026-08-21");
  });

  it("stops counting a guest whose remaining nights are all behind the edit window", () => {
    // Nights {20, 24}; the check-out is pulled back to the 22nd, so the 24th
    // goes and the 20th is all they have left — no future night at all. The
    // envelope test saw an open [21, 22) window and called them future-active.
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [
          guestFromNights(["2026-08-20", "2026-08-24"]),
          guestFromNights(COMPANION, "g2"),
        ],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-22",
      }),
    );

    expect(plan.proposedExistingGuests[0].futureNights).toEqual([]);
    expect(plan.futureActiveGuestCount).toBe(1);
    expect(plan.capacityGuestRanges.map((r) => r.memberId)).toEqual(["m-g2"]);
  });

  it("falls back to the envelope for a guest carrying no night rows at all", () => {
    // A legacy row, or a booking converted from a request (#2739): there is no
    // canonical set to read, so the envelope IS the answer and behaviour must be
    // exactly what it always was.
    const withRows = guestFromNights(["2026-08-20", "2026-08-21", "2026-08-22"]);
    const withoutRows = guestFromNights(
      ["2026-08-20", "2026-08-21", "2026-08-22"],
      "g1",
      false,
    );
    const build = (guest: TestGuest) =>
      buildInProgressGuestRangePlan(
        planInput({
          guests: [guest],
          editableFrom: "2026-08-21",
          newCheckOut: "2026-08-25",
        }),
      );

    expect(withoutRows.nights).toBeUndefined();
    expect(build(withoutRows).proposedExistingGuests[0].nights.map(key)).toEqual(
      build(withRows).proposedExistingGuests[0].nights.map(key),
    );
    expect(build(withoutRows).newTotalPriceCents).toBe(
      build(withRows).newTotalPriceCents,
    );
  });

  it("prices each night at its own season rate across a gap that spans the boundary", () => {
    // Nights {22, 24}: one low-season, one high-season, with the 23rd — the
    // dearer night — as the gap. Any answer that flattens to a single rate lands
    // on 2 x LOW or 2 x HIGH, and any answer that fills the gap lands on three
    // nights. Only per-night pricing over the real set gives LOW + HIGH.
    //
    // The companion holds every night of the booking, including the two this
    // edit leaves in the future. Since #2743 an edit no longer sells those
    // nights to a guest who is not booked for them, so a companion who went home
    // on the 22nd would leave the 23rd and 24th unoccupied and the save would be
    // refused before it could price anything.
    const nights = ["2026-08-22", "2026-08-24"];
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [
          guestFromNights(nights),
          guestFromNights(
            ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24"],
            "g2",
          ),
        ],
        editableFrom: "2026-08-23",
        newCheckOut: "2026-08-25",
        removeGuestIds: ["g1"],
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.nights.map(key)).toEqual(["2026-08-22"]);
    expect(entry.futureDeltaCents).toBe(-HIGH);
    expect(entry.priceCents).toBe(LOW);
    expect(entry.priceCents).not.toBe(2 * LOW);
    expect(entry.priceCents).not.toBe(HIGH);
  });

  it("extends from the guest's real last night when their stored envelope has drifted wider", () => {
    // A guest whose stored `stayEnd` claims more nights than their rows do. The
    // rows are canonical (INV-DATE-012), so nothing between the 22nd and the
    // booking's own check-out is theirs — the envelope merely imagined it. The
    // 480-case matrix cannot reach this, because it derives every envelope from
    // the rows the way the writer does.
    //
    // Under #2736 alone this was the ONE shape that billed MORE than the old
    // envelope arithmetic, because #2736 charged the imagined nights once
    // instead of cancelling them in both windows. #2743 removes the charge
    // altogether: those nights are not past the booking's check-out, so this
    // edit did not create them and cannot sell them. The money lands back on the
    // pre-#2736 answer — two nights — by a different and honest route.
    const drifted = {
      ...guestFromNights(["2026-08-20", "2026-08-21"]),
      // Two nights of rows, an envelope claiming five.
      stayEnd: D("2026-08-25"),
    };
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [drifted],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-27",
        checkIn: "2026-08-20",
        checkOut: "2026-08-25",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // Nothing of the old stay is left to reprice: the rows stop on the 21st.
    expect(entry.oldFuturePriceCents).toBe(0);
    // Their own two nights, then the two the extension genuinely adds past the
    // booking's 25th. The 22nd to the 24th stay absences — they always were.
    expect(entry.nights.map(key)).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-25",
      "2026-08-26",
    ]);
    expect(entry.futureDeltaCents).toBe(
      priceNights(["2026-08-25", "2026-08-26"]),
    );
    // Not the five-night answer #2736 gave, and not a flat rate either: the two
    // added nights are both high-season.
    expect(entry.futureDeltaCents).not.toBe(
      priceNights([
        "2026-08-22",
        "2026-08-23",
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
      ]),
    );
    expect(entry.priceCents).toBe(
      drifted.priceCents + entry.futureDeltaCents,
    );
  });

  it("keeps every cent an integer, with no float anywhere in the sum", () => {
    // INV-MONEY-001 / INV-MONEY-003. Every term here is a season rate in cents;
    // the plan only ever adds and subtracts them.
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [guestFromNights(SPARSE)],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-25",
      }),
    );

    for (const entry of plan.proposedExistingGuests) {
      expect(Number.isInteger(entry.priceCents)).toBe(true);
      expect(Number.isInteger(entry.futureDeltaCents)).toBe(true);
      expect(Number.isInteger(entry.oldFuturePriceCents)).toBe(true);
      expect(Number.isInteger(entry.newFuturePriceCents)).toBe(true);
    }
    expect(Number.isInteger(plan.newTotalPriceCents)).toBe(true);
    expect(Number.isInteger(plan.priceDiffCents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The one edit the night test newly refuses.
// ---------------------------------------------------------------------------

describe("#2736 the edit it now refuses", () => {
  it("refuses a shortened check-out that would leave nights nobody holds, and names the check-out that works", () => {
    // The whole booking is one sparse guest on nights {20, 22}. The officer pulls
    // the check-out back to the 22nd — so the 22nd is dropped, the 20th is behind
    // the edit window, and the booking would keep the night of the 21st with
    // nobody in it. The envelope test saw an open [21, 22) window and allowed it.
    //
    // The refusal is right; the message has to be the recoverable one, because a
    // check-out of the 21st is exactly what the officer meant.
    const build = () =>
      buildInProgressGuestRangePlan(
        planInput({
          guests: [guestFromNights(["2026-08-20", "2026-08-22"])],
          editableFrom: "2026-08-21",
          newCheckOut: "2026-08-22",
        }),
      );

    expect(build).toThrow(/No remaining guest is booked for a night on or after 2026-08-21/);
    expect(build).toThrow(/Set the check-out to 2026-08-21 instead/);
    // And plainly NOT the old sentence, which describes the rule rather than the
    // mistake — the booking does still have a guest.
    expect(build).not.toThrow(/at least one guest for future nights/);
  });

  it("keeps the original wording for the refusal it always made", () => {
    // Every guest taken off a booking that still has future nights. Nobody holds
    // anything, so there is no check-out to suggest — and this is the refusal the
    // pre-#2736 arithmetic made too, word for word.
    expect(() =>
      buildInProgressGuestRangePlan(
        planInput({
          guests: [
            guestFromNights(["2026-08-20", "2026-08-21"], "g1"),
            guestFromNights(["2026-08-20", "2026-08-21"], "g2"),
          ],
          editableFrom: "2026-08-21",
          newCheckOut: "2026-08-24",
          removeGuestIds: ["g1", "g2"],
        }),
      ),
    ).toThrow("Booking must have at least one guest for future nights");
  });
});

// ---------------------------------------------------------------------------
// 4. #2743 — an edit sells only the nights it creates.
//
// The booking these cases edit runs 18 Aug → 27 Aug. It is the 21st, so the
// edit window opens on the 22nd (`editableFrom`), and every case below is an
// ordinary officer save on a stay already under way.
// ---------------------------------------------------------------------------

describe("#2743 a guest whose stay already ended", () => {
  const WHOLE_RUN = [
    "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22",
    "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26",
  ];
  const bookingOf = (guests: TestGuest[], newCheckOut: string) =>
    planInput({
      guests,
      editableFrom: "2026-08-22",
      newCheckOut,
      checkIn: "2026-08-18",
      checkOut: "2026-08-27",
    });

  it("is not re-admitted, and an edit that leaves the check-out alone costs nothing", () => {
    // The issue's worked example. The guest holds two nights, the 18th and the
    // 19th, and went home a week ago; the officer saves a name correction. That
    // used to add seven nights to their bill.
    const departed = guestFromNights(["2026-08-18", "2026-08-19"], "g1");
    const plan = buildInProgressGuestRangePlan(
      bookingOf([departed, guestFromNights(WHOLE_RUN, "g2")], "2026-08-27"),
    );
    const [gone, present] = plan.proposedExistingGuests;

    expect(gone.futureDeltaCents).toBe(0);
    expect(gone.priceCents).toBe(departed.priceCents);
    expect(gone.nights.map(key)).toEqual(["2026-08-18", "2026-08-19"]);
    // No future night, so no bed is held for them and they do not count towards
    // the booking still having somebody in it.
    expect(gone.futureNights).toEqual([]);
    expect(plan.capacityGuestRanges.map((range) => range.memberId)).toEqual([
      "m-g2",
    ]);
    expect(plan.futureActiveGuestCount).toBe(1);
    // The guest who is actually there is unchanged, and the save moves no money
    // at all — which is what a name correction should cost.
    expect(present.futureDeltaCents).toBe(0);
    expect(plan.priceDiffCents).toBe(0);
  });

  it("keeps a sparse guest's gap when their remaining nights are all behind the window", () => {
    // #2736's shape and #2743's shape at once: in on the 18th, home on the 19th,
    // back for the 20th, gone since. The edit neither fills the gap nor re-admits
    // them.
    const plan = buildInProgressGuestRangePlan(
      bookingOf(
        [
          guestFromNights(["2026-08-18", "2026-08-20"], "g1"),
          guestFromNights(WHOLE_RUN, "g2"),
        ],
        "2026-08-27",
      ),
    );

    expect(plan.proposedExistingGuests[0].nights.map(key)).toEqual([
      "2026-08-18",
      "2026-08-20",
    ]);
    expect(plan.proposedExistingGuests[0].futureDeltaCents).toBe(0);
    expect(plan.priceDiffCents).toBe(0);
  });

  it("leaves a guest who is still here exactly as they were, extension and all", () => {
    // The other boundary: their last night is on or after the window opens, so
    // every future night they hold is kept and repriced as before, and an
    // extension buys them exactly the nights past the old check-out. If the
    // bound ever reached further back than the booking's check-out, this is the
    // guest it would start stealing nights from.
    const plan = buildInProgressGuestRangePlan(
      bookingOf([guestFromNights(WHOLE_RUN, "g1")], "2026-08-29"),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.futureDeltaCents).toBe(
      priceNights(["2026-08-27", "2026-08-28"]),
    );
    expect(entry.nights.map(key)).toEqual([...WHOLE_RUN, "2026-08-27", "2026-08-28"]);
    expect(entry.futureNights.map(key)).toEqual([
      "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26",
      "2026-08-27", "2026-08-28",
    ]);
  });

  it("still buys the check-out-day night on a +1 extension (#2029 boundary)", () => {
    // The narrow case the reach-back exists for, and the one a bound written a
    // day too late would break. The booking runs 20 → 24 and the guest's stay
    // ends with it; today IS the 24th, so the window opens on the 25th and the
    // night of the 24th is behind it. Moving the check-out to the 25th genuinely
    // creates that night, so it is charged — the guest's stay end and the
    // booking's check-out are the same day, which is what separates this from a
    // guest who went home a week ago.
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [
          guestFromNights([
            "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23",
          ]),
        ],
        editableFrom: "2026-08-25",
        newCheckOut: "2026-08-25",
        checkIn: "2026-08-20",
        checkOut: "2026-08-24",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.futureDeltaCents).toBe(priceNights(["2026-08-24"]));
    expect(entry.nights.map(key)).toEqual([
      "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24",
    ]);
  });

  it("is still admitted for the nights an extension genuinely creates, which the software cannot refuse for them", () => {
    // STATED, not endorsed. Extending a booking's check-out admits every guest
    // still on it, and a guest who has gone home is still on it — the software
    // has no way to say "this one is not coming back", and this plan cannot
    // invent one, because an in-progress edit carries no per-guest stay end.
    //
    // What #2743 removes is the back-fill: the seven nights between their last
    // one and the old check-out. What is left is the three nights the officer
    // has just added to the booking. It is smaller, it is visible in the quote,
    // and it is recorded in INV-MOD-025 rather than left to be discovered.
    const departed = guestFromNights(["2026-08-18", "2026-08-19"], "g1");
    const plan = buildInProgressGuestRangePlan(
      bookingOf([departed, guestFromNights(WHOLE_RUN, "g2")], "2026-08-30"),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.futureDeltaCents).toBe(
      priceNights(["2026-08-27", "2026-08-28", "2026-08-29"]),
    );
    expect(entry.nights.map(key)).toEqual([
      "2026-08-18", "2026-08-19", "2026-08-27", "2026-08-28", "2026-08-29",
    ]);
    // Emphatically NOT the whole run from their last night to the new check-out,
    // which is what it used to be.
    expect(entry.futureDeltaCents).toBeLessThan(
      priceNights([
        "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24",
        "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29",
      ]),
    );
  });

  it("refuses an edit to a booking whose guests have all gone, and names the check-out that fits", () => {
    // The one edit #2743 newly refuses. The booking's check-out says the 27th but
    // the only guest went home on the 20th, so there is nothing left to sell the
    // remaining nights to. It used to save by charging them to the guest who had
    // left. The message is a log line (#1888 keeps it off the wire), and it names
    // the check-out that matches who is actually there.
    const build = () =>
      buildInProgressGuestRangePlan(
        bookingOf(
          [guestFromNights(["2026-08-18", "2026-08-19"], "g1")],
          "2026-08-27",
        ),
      );

    expect(build).toThrow(
      /No remaining guest is booked for a night on or after 2026-08-22/,
    );
    expect(build).toThrow(/Set the check-out to 2026-08-20 instead/);
  });

  it("keeps every cent an integer and never charges more than it used to", () => {
    // INV-MONEY-001 / INV-MONEY-003. #2743 only ever REMOVES nights from the
    // added leg, so no total can rise; the matrix above proves that over 480
    // ordinary edits and this pins the arithmetic type on the shape itself.
    const departed = guestFromNights(["2026-08-18", "2026-08-19"], "g1");
    const plan = buildInProgressGuestRangePlan(
      bookingOf([departed, guestFromNights(WHOLE_RUN, "g2")], "2026-08-30"),
    );

    for (const entry of plan.proposedExistingGuests) {
      expect(Number.isInteger(entry.priceCents)).toBe(true);
      expect(Number.isInteger(entry.futureDeltaCents)).toBe(true);
      expect(Number.isInteger(entry.newFuturePriceCents)).toBe(true);
    }
    expect(Number.isInteger(plan.newTotalPriceCents)).toBe(true);
    expect(plan.newTotalPriceCents).toBe(
      plan.proposedExistingGuests.reduce((sum, e) => sum + e.priceCents, 0),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. A money shape #2736 deliberately did NOT change.
//
// Pre-existing — the pre-#2736 arithmetic produces the same cents — and left
// alone because correcting it moves ordinary contiguous stays, which is the
// equivalence the whole change rests on. It is pinned so the behaviour is
// visible rather than implied, and so whoever answers the issue has a test to
// rewrite. It is not endorsed; it is frozen.
// ---------------------------------------------------------------------------

describe("#2736 frozen money behaviour, carried as issues", () => {
  it("still values the nights a removal gives back at today's rate, not the price they were sold at (#2744)", () => {
    // Three high-season nights bought at the old low rate: 3 x LOW paid, HIGH on
    // the table now. The guest sleeps the 23rd and is taken off the rest.
    const nights = ["2026-08-23", "2026-08-24", "2026-08-25"];
    const paidCents = 3 * LOW;
    const boughtBeforeTheRise: TestGuest = {
      ...guestFromNights(nights, "g1"),
      // The rows carry what each night was sold for — exactly as the loaded
      // `BookingGuestNight` rows do — so this case fails the moment the plan
      // starts honouring them.
      nights: nights.map((night) => ({ stayDate: D(night), priceCents: LOW })),
      priceCents: paidCents,
    };
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [boughtBeforeTheRise, guestFromNights(nights, "g2")],
        editableFrom: "2026-08-24",
        newCheckOut: "2026-08-26",
        removeGuestIds: ["g1"],
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // The two nights given back are credited at today's HIGH, not the LOW the
    // member paid, so more comes off than ever went on — and the guest finishes
    // owing less than nothing despite having slept a night.
    expect(entry.oldFuturePriceCents).toBe(2 * HIGH);
    expect(entry.futureDeltaCents).toBe(-2 * HIGH);
    expect(entry.priceCents).toBe(paidCents - 2 * HIGH);
    expect(entry.priceCents).toBeLessThan(0);
    // What it would be if the leg honoured the locked prices: one night's LOW.
    expect(entry.priceCents).not.toBe(LOW);
  });
});
