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
  nights?: Array<{ stayDate: Date }>;
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
    expect(cases.length).toBeGreaterThan(400);
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
