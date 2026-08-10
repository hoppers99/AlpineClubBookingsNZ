/**
 * #2736 — editing a booking that is already under way must price a guest with a
 * gap in their stay over the nights they actually hold.
 *
 * `BookingGuestNight` is the canonical night set; `stayStart`/`stayEnd` is the
 * derived half-open envelope (INV-DATE-012). `buildInProgressGuestRangePlan`
 * used to carry only the envelope, so an edit to a stay in progress priced,
 * quoted and persisted a SPARSE guest as one continuous run — the gap night was
 * charged, written back as a `BookingGuestNight` row and reserved a bed
 * (INV-MOD-025).
 *
 * Two halves to this file, and the FIRST is the one that makes the change safe:
 *
 *  1. `contiguous stays are unchanged` re-implements the pre-#2736 arithmetic
 *     and asserts the new plan agrees with it to the cent, to the night and to
 *     the thrown error, over a matrix of ordinary stays. If a contiguous edit
 *     ever moves, that block fails.
 *  2. `a sparse stay` covers what the fix actually changes, including the two
 *     shapes where real money moved the wrong way: a mid-stay REMOVAL and a
 *     SHORTENED check-out both used to refund the guest for gap nights they had
 *     never been charged for in the first place.
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
 *
 * `withStoredPrices: true` puts the CURRENT season rate on each row, which is
 * every booking where no rate has moved since it was made (#2744). Those guests
 * must also come out exactly where they came out before — the locked price and
 * the fresh lookup are the same number — which is what the matrix below uses to
 * separate "honours what was paid" from "changes ordinary bookings".
 */
function guestFromNights(
  nights: string[],
  id = "g1",
  withNightRows = true,
  withStoredPrices = false,
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
      ? {
          nights: sorted.map((night) => ({
            stayDate: D(night),
            ...(withStoredPrices ? { priceCents: rateFor(night) } : {}),
          })),
        }
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

describe("#2736 contiguous stays are unchanged", () => {
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

  // What the guest's stored `BookingGuestNight` rows look like. All three must
  // agree with the pre-#2736 arithmetic:
  //
  //  - `rows+prices` is the ordinary live booking whose rates have not moved
  //    since it was made, so #2744's locked prices ARE the current rates and
  //    every number has to come out the same. Without this row the matrix could
  //    not tell "honours what was paid" apart from "changes ordinary bookings",
  //    because the other two carry no price to honour.
  //  - `rows` is a guest whose rows carry no price (loaded without it).
  //  - `envelope` is a legacy guest with no rows at all (#2739).
  const ROW_VARIANTS = [
    { label: "rows+prices", withNightRows: true, withStoredPrices: true },
    { label: "rows", withNightRows: true, withStoredPrices: false },
    { label: "envelope", withNightRows: false, withStoredPrices: false },
  ];

  const cases: Array<{
    name: string;
    input: () => BuildInProgressGuestRangePlanInput;
  }> = [];
  for (const [stayIndex, stay] of STAYS.entries()) {
    for (const variant of ROW_VARIANTS) {
      for (const editableFrom of EDITABLE_FROM) {
        for (const newCheckOut of NEW_CHECK_OUT) {
          for (const removed of [false, true]) {
            cases.push({
              name: `stay#${stayIndex} ${variant.label} from=${editableFrom} to=${newCheckOut} removed=${removed}`,
              input: () =>
                planInput({
                  // A second, always-contiguous guest so a removal does not
                  // trivially empty the booking on every row.
                  guests: [
                    guestFromNights(
                      stay,
                      "g1",
                      variant.withNightRows,
                      variant.withStoredPrices,
                    ),
                    guestFromNights(
                      ["2026-08-20", "2026-08-21", "2026-08-22"],
                      "g2",
                      variant.withNightRows,
                      variant.withStoredPrices,
                    ),
                  ],
                  editableFrom,
                  newCheckOut,
                  ...(removed ? { removeGuestIds: ["g1"] } : {}),
                  checkIn: "2026-08-18",
                  checkOut: "2026-08-25",
                }),
            });
          }
        }
      }
    }
  }

  it(`agrees with the pre-#2736 arithmetic on all ${cases.length} ordinary edits`, () => {
    expect(cases.length).toBeGreaterThan(600);
    for (const testCase of cases) {
      const legacy = run(() => legacyPlan(testCase.input()));
      const current = run(() => buildInProgressGuestRangePlan(testCase.input()));

      expect(current.ok, testCase.name).toBe(legacy.ok);
      if (!legacy.ok || !current.ok) {
        expect(
          current.ok ? "" : current.error,
          testCase.name,
        ).toBe(legacy.ok ? "" : legacy.error);
        continue;
      }

      const plan = current.value;
      const before = legacy.value;

      expect(plan.newTotalPriceCents, testCase.name).toBe(before.newTotalPriceCents);
      expect(plan.newFinalPriceCents, testCase.name).toBe(before.newFinalPriceCents);
      expect(plan.priceDiffCents, testCase.name).toBe(before.priceDiffCents);
      expect(plan.futureExistingDeltaCents, testCase.name).toBe(
        before.futureExistingDeltaCents,
      );
      expect(plan.futureActiveGuestCount, testCase.name).toBe(
        before.futureActiveGuestCount,
      );

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
        })),
        testCase.name,
      ).toEqual(
        before.existing.map((entry) => ({
          id: entry.id,
          stayStart: key(entry.stayStart),
          stayEnd: key(entry.stayEnd),
          futureStart: key(entry.futureStart),
          priceCents: entry.priceCents,
          oldFuturePriceCents: entry.oldFuturePriceCents,
          newFuturePriceCents: entry.newFuturePriceCents,
          futureDeltaCents: entry.futureDeltaCents,
          removedFromFuture: entry.removedFromFuture,
          nights: entry.nights,
        })),
      );

      expect(
        plan.capacityGuestRanges.map((range) => ({
          stayStart: key(range.stayStart),
          stayEnd: key(range.stayEnd),
        })),
        testCase.name,
      ).toEqual(
        before.capacityGuestRanges.map((range) => ({
          stayStart: key(range.stayStart),
          stayEnd: key(range.stayEnd),
        })),
      );

      // The new `nights` on a capacity range is the old envelope expanded, so
      // `countActiveGuestsForNight` sees the identical occupancy.
      for (const range of plan.capacityGuestRanges) {
        expect(range.nights.map(key), testCase.name).toEqual(
          eachDateOnlyInRange(range.stayStart, range.stayEnd).map(key),
        );
      }

      // #2744: the per-night amounts are new, so the legacy plan has nothing to
      // compare them against — but they are what gets written to
      // `BookingGuestNight.priceCents`, so on every one of these edits they must
      // be one integer per night that adds back to the guest's total. Anything
      // else is a phantom balance the moment Xero rebuilds its lines.
      for (const entry of [
        ...plan.proposedExistingGuests,
        ...plan.proposedAddedGuests,
      ]) {
        expect(entry.perNightCents.length, testCase.name).toBe(
          entry.nights.length,
        );
        expect(
          entry.perNightCents.every((cents) => Number.isInteger(cents)),
          testCase.name,
        ).toBe(true);
        expect(
          entry.perNightCents.reduce((sum, cents) => sum + cents, 0),
          testCase.name,
        ).toBe(entry.priceCents);
      }
    }
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
    const nights = ["2026-08-22", "2026-08-24"];
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [guestFromNights(nights), guestFromNights(COMPANION, "g2")],
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
    // The ONE shape where #2736 bills MORE than the envelope arithmetic did, and
    // the only non-sparse one: a guest whose stored `stayEnd` claims more nights
    // than their rows do. The rows are canonical (INV-DATE-012), so the extension
    // starts the morning after their real last night — not after the envelope's
    // imaginary one. The 480-case matrix cannot reach this, because it derives
    // every envelope from the rows the way the writer does.
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
    expect(entry.nights.map(key)).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
    ]);
    // Five genuinely-new nights (22nd–26th), each at its own season rate.
    expect(entry.futureDeltaCents).toBe(
      priceNights([
        "2026-08-22",
        "2026-08-23",
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
      ]),
    );
    // The envelope answer was two nights: it had already counted the 22nd–24th
    // as the guest's, in both windows, so they cancelled. Charging them once is
    // the coherent answer — the guest ends up paying for exactly the seven
    // nights they now hold — but it IS a case where money goes up, so it is
    // pinned here rather than left to a comment.
    expect(entry.futureDeltaCents).not.toBe(
      priceNights(["2026-08-25", "2026-08-26"]),
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
// 4. A money shape #2736 deliberately did NOT change.
//
// Pre-existing — the pre-#2736 arithmetic produces the same cents — and left
// alone because correcting it moves ordinary contiguous stays, which is the
// equivalence that change rests on. Pinned so the behaviour is visible rather
// than implied, and so whoever answers the issue has a test to rewrite. It is
// not endorsed; it is frozen. (#2744, the second one, was answered — see 5.)
// ---------------------------------------------------------------------------

describe("#2736 frozen money behaviour, carried as issues", () => {
  it("still re-admits a guest whose stay ended before the edit window, and charges them (#2743)", () => {
    // Booking 18 Aug → 27 Aug. The guest holds two nights, the 18th and 19th, and
    // went home. It is the 21st, so the window opens on the 22nd, and the officer
    // saves an edit that does not move the check-out at all.
    const departed = guestFromNights(["2026-08-18", "2026-08-19"], "g1");
    const wholeRun = guestFromNights(
      [
        "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22",
        "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26",
      ],
      "g2",
    );
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [departed, wholeRun],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-27",
        checkIn: "2026-08-18",
        checkOut: "2026-08-27",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // Seven nights added to somebody who left a week ago. #2743 decides whether
    // this should happen at all; until then it must not change by accident.
    expect(entry.futureDeltaCents).toBe(
      priceNights([
        "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23",
        "2026-08-24", "2026-08-25", "2026-08-26",
      ]),
    );
    expect(entry.nights.map(key)).toEqual([
      "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22",
      "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26",
    ]);
    // The guest who is actually there is charged nothing, which is the giveaway.
    expect(plan.proposedExistingGuests[1].futureDeltaCents).toBe(0);
  });

});

// ---------------------------------------------------------------------------
// 5. #2744 — a night is worth what it was SOLD for, and the rows say so.
//
// The plan used to pass no `lockedNightPrices`, so every night it touched was
// valued at today's season rate: a night given back was credited at whatever it
// would cost to buy now, and the per-night amounts written back were the guest's
// total divided by their night count. Both halves are answered here. The stored
// `BookingGuestNight.priceCents` is now honoured in BOTH pricing windows, which
// is what INV-MOD-005 has always required of every other edit path — "removing
// one returns exactly theirs" — and is why a night the guest keeps still cancels
// between the two windows instead of being re-rated.
// ---------------------------------------------------------------------------

/** A guest whose rows record what each night was actually sold for. */
function guestWhoPaid(
  paidByNight: Record<string, number>,
  id = "g1",
): TestGuest {
  const nights = Object.keys(paidByNight).sort();
  return {
    ...guestFromNights(nights, id),
    nights: nights.map((night) => ({
      stayDate: D(night),
      priceCents: paidByNight[night],
    })),
    priceCents: nights.reduce((sum, night) => sum + paidByNight[night], 0),
  };
}

describe("#2744 a night is credited back at the price it was sold for", () => {
  it("refunds a mid-stay removal at what the member paid, not today's rate", () => {
    // Three high-season nights bought at the old low rate: 3 x LOW paid, HIGH on
    // the table now. The guest sleeps the 23rd and is taken off the rest. This
    // is the shape the issue reproduced, and the numbers it reported.
    const nights = ["2026-08-23", "2026-08-24", "2026-08-25"];
    const paidCents = 3 * LOW;
    const boughtBeforeTheRise = guestWhoPaid(
      Object.fromEntries(nights.map((night) => [night, LOW])),
    );
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [boughtBeforeTheRise, guestFromNights(nights, "g2")],
        editableFrom: "2026-08-24",
        newCheckOut: "2026-08-26",
        removeGuestIds: ["g1"],
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // The two nights given back are worth the LOW they were sold at — not the
    // HIGH they would cost today, which used to hand back 2 x HIGH for 2 x LOW
    // of nights.
    expect(entry.oldFuturePriceCents).toBe(2 * LOW);
    expect(entry.futureDeltaCents).toBe(-2 * LOW);
    // What is left is exactly the night they actually slept.
    expect(entry.priceCents).toBe(LOW);
    expect(entry.priceCents).toBe(paidCents - 2 * LOW);
    // The acceptance criterion in its own right: a guest who slept a night can
    // never come off the booking owing less than nothing.
    expect(entry.priceCents).toBeGreaterThanOrEqual(0);
    // And the one night they keep is written back at its real price.
    expect(entry.nights.map(key)).toEqual(["2026-08-23"]);
    expect(entry.perNightCents).toEqual([LOW]);
  });

  it("credits a shortened check-out at the sold price too, and the same way if the rate FELL", () => {
    // Same booking shape, opposite direction on the second guest: the club drops
    // its rate after the member books. Giving a night back must return what they
    // paid, which is now MORE than the night is worth today — the error runs in
    // both directions and so does the fix.
    const paidHigh = guestWhoPaid(
      { "2026-08-20": HIGH, "2026-08-21": HIGH, "2026-08-22": HIGH },
      "g1",
    );
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [
          paidHigh,
          guestFromNights(["2026-08-20", "2026-08-21", "2026-08-22"], "g2"),
        ],
        editableFrom: "2026-08-21",
        // Pull the check-out back one night: the 22nd is given up.
        newCheckOut: "2026-08-22",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // The 21st is kept (same price both sides, so it cancels); the 22nd is given
    // back at the HIGH it was sold for, not the LOW it would cost now.
    expect(entry.oldFuturePriceCents).toBe(2 * HIGH);
    expect(entry.newFuturePriceCents).toBe(HIGH);
    expect(entry.futureDeltaCents).toBe(-HIGH);
    expect(entry.priceCents).toBe(2 * HIGH);
    expect(entry.perNightCents).toEqual([HIGH, HIGH]);
  });

  it("does NOT re-rate a night the guest keeps: an extension still charges only the new nights", () => {
    // The trap in fixing half one. Honouring the sold price in the old window
    // ALONE would make every extension reprice the nights already bought — the
    // exact thing INV-MOD-005 exists to prevent. Both windows get the locks, so
    // a kept night carries one price on both sides and cancels to nothing.
    const paidLow = guestWhoPaid(
      { "2026-08-23": LOW, "2026-08-24": LOW },
      "g1",
    );
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [paidLow],
        editableFrom: "2026-08-24",
        newCheckOut: "2026-08-27",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // Two new nights at today's HIGH, and not a cent charged for the 24th the
    // member already owns at LOW.
    expect(entry.futureDeltaCents).toBe(2 * HIGH);
    expect(entry.priceCents).toBe(2 * LOW + 2 * HIGH);
    expect(entry.perNightCents).toEqual([LOW, LOW, HIGH, HIGH]);
  });

  it("writes each night's real rate back, not the average (the issue's worked example)", () => {
    // Nights 20 Aug + 22 Aug extended to the 25th, LOW to the 22nd and HIGH from
    // the 23rd. The plan produces four nights totalling 2 x LOW + 2 x HIGH and
    // used to write the SAME averaged amount on all four, so a later edit
    // charged the average for the 20th and credited it for the 24th.
    const sparse = guestWhoPaid(
      { "2026-08-20": LOW, "2026-08-22": LOW },
      "g1",
    );
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [sparse],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-25",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.nights.map(key)).toEqual([
      "2026-08-20",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
    ]);
    expect(entry.perNightCents).toEqual([LOW, LOW, HIGH, HIGH]);
    // The average this replaced would have been one number on all four nights.
    expect(new Set(entry.perNightCents).size).toBeGreaterThan(1);
    expect(entry.perNightCents.reduce((a, b) => a + b, 0)).toBe(entry.priceCents);
  });

  it("gives an added guest each night's own rate across a season boundary", () => {
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [guestFromNights(["2026-08-21", "2026-08-22"], "g1")],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-25",
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
      }),
    );
    const added = plan.proposedAddedGuests[0];

    expect(added.nights.map(key)).toEqual([
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
    ]);
    expect(added.perNightCents).toEqual([LOW, HIGH, HIGH]);
    expect(added.priceCents).toBe(LOW + 2 * HIGH);
  });

  it("degrades to today's rate and the even split when there is no sold price to recover", () => {
    // A booking that predates `BookingGuestNight`, or one converted from a
    // request: no rows, so nothing records what the member paid. That guest gets
    // exactly what they got before — the current season rate on both legs and
    // the total split evenly — which is INV-MOD-005's own legacy fallback, said
    // out loud rather than reached by accident.
    const legacyGuest: TestGuest = {
      ...guestFromNights(["2026-08-22", "2026-08-23"], "g1", false),
      // Whatever they were charged is not recoverable per night; only the total
      // survives, and it is not today's price for those nights.
      priceCents: 2 * LOW,
    };
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [
          legacyGuest,
          guestFromNights(["2026-08-22", "2026-08-23"], "g2"),
        ],
        editableFrom: "2026-08-23",
        newCheckOut: "2026-08-24",
        removeGuestIds: ["g1"],
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // Credited at today's HIGH, because there is no record of anything else.
    expect(entry.oldFuturePriceCents).toBe(HIGH);
    expect(entry.priceCents).toBe(2 * LOW - HIGH);
    // One night kept, and the even split still lands the whole total on it.
    expect(entry.nights.map(key)).toEqual(["2026-08-22"]);
    expect(entry.perNightCents).toEqual([2 * LOW - HIGH]);
  });

  it("falls back to the even split when the stored rows do not add up to the stored total", () => {
    // Drifted data: the guest's rows say LOW + LOW, their stored total says
    // something else. The rows are not a trustworthy per-night record of that
    // total, so the amounts written back are the split this always used — never
    // a distribution invented from numbers that disagree — and they still sum
    // back to the total exactly, in whole cents.
    const drifted: TestGuest = {
      ...guestWhoPaid({ "2026-08-20": LOW, "2026-08-22": LOW }, "g1"),
      priceCents: 2 * LOW + 101,
    };
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [drifted],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-25",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.priceCents).toBe(2 * LOW + 101 + 2 * HIGH);
    expect(entry.perNightCents).toEqual(
      evenSplit(entry.priceCents, entry.nights.length),
    );
    expect(entry.perNightCents.reduce((a, b) => a + b, 0)).toBe(entry.priceCents);
    expect(entry.perNightCents.every(Number.isInteger)).toBe(true);
  });

  it("keeps a NEGATIVE fallback total summing back exactly, cent by cent", () => {
    // The even-split fallback has to survive a negative total as well: a guest
    // whose stored total is below what this edit prices for them. Floor rounds
    // away from zero for a negative, so the remainder is added back one cent at
    // a time and the parts still sum to the total (INV-MONEY-001).
    const owingLess: TestGuest = {
      ...guestWhoPaid({ "2026-08-20": LOW, "2026-08-22": LOW }, "g1"),
      priceCents: -301,
    };
    const plan = buildInProgressGuestRangePlan(
      planInput({
        guests: [owingLess],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-23",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.priceCents).toBeLessThan(0);
    expect(entry.perNightCents).toEqual(
      evenSplit(entry.priceCents, entry.nights.length),
    );
    expect(entry.perNightCents.reduce((a, b) => a + b, 0)).toBe(entry.priceCents);
    expect(entry.perNightCents.every(Number.isInteger)).toBe(true);
  });
});

/**
 * The even split, re-implemented here rather than imported: the fallback the
 * plan uses when a guest's stored rows cannot account for their total. Kept
 * independent so a change to the implementation's version has to be asserted
 * here too.
 */
function evenSplit(totalCents: number, count: number): number[] {
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}
