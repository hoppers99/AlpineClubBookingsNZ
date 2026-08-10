import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import {
  OverCapacityConfirmationRequiredError,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";

const h = vi.hoisted(() => ({
  checkCapacityForGuestRanges: vi.fn(),
  checkCapacityForPartnerSharedAdmission: vi.fn(),
}));

// Keep the real OverCapacityConfirmationRequiredError + overCapacityNights so the
// thrown class is the genuine one; only stub the DB-backed capacity queries.
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return {
    ...actual,
    checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
    checkCapacityForPartnerSharedAdmission: h.checkCapacityForPartnerSharedAdmission,
  };
});

vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  resolveGuestRateMembershipTypes: vi
    .fn()
    .mockImplementation((_tx: unknown, { guests }: { guests: unknown[] }) =>
      Promise.resolve(guests),
    ),
  MembershipTypeBookingPolicyError: class extends Error {},
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { calculateModifiedPricing } from "@/lib/booking-modify-plan";
import { eachDateOnlyInRange } from "@/lib/date-only";
import {
  resolveGuestRateMembershipTypes,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

function baseArgs() {
  const guest = {
    id: "g1",
    ageTier: "ADULT",
    isMember: true,
    memberId: "m1",
    stayStart: D("2026-09-10"),
    stayEnd: D("2026-09-13"),
    priceCents: 30000,
  };
  const booking = {
    id: "b1",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D("2026-09-10"),
    checkOut: D("2026-09-13"),
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 30000,
    guests: [guest],
  } as never;

  return {
    booking,
    bookingId: "b1",
    isInProgressEdit: false,
    editableFrom: null,
    newCheckIn: D("2026-09-10"),
    newCheckOut: D("2026-09-13"),
    normalizedAddGuests: undefined,
    removeGuestIds: undefined,
    guestsForPricing: [
      {
        bookingGuestId: "g1",
        ageTier: "ADULT" as const,
        isMember: true,
        memberId: "m1",
        stayStart: D("2026-09-10"),
        stayEnd: D("2026-09-13"),
      },
    ],
    skipBookingLifecycleRules: false,
    seasonRateData: [],
  };
}

const OVER_CAPACITY = {
  available: false,
  minAvailable: -1,
  nightDetails: [{ date: D("2026-09-11"), occupiedBeds: 30, availableBeds: -1 }],
};

// A whole-lodge-held night (ADR-001, issue #118): unavailable, but availableBeds
// is pinned to 0 (never negative) and flagged wholeLodgeHeld — exactly what
// checkCapacityForGuestRanges now returns for a night held by another booking.
const WHOLE_LODGE_HELD = {
  available: false,
  minAvailable: 0,
  nightDetails: [
    {
      date: D("2026-09-11"),
      occupiedBeds: 5,
      availableBeds: 0,
      wholeLodgeHeld: true,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("calculateModifiedPricing capacity (issue #1668)", () => {
  it("throws the existing 400 for a non-admin over-capacity edit", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(OVER_CAPACITY);

    await expect(
      calculateModifiedPricing({} as never, {
        ...baseArgs(),
        adminOverride: false,
      }),
    ).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: "Not enough beds available for these changes",
    });
  });

  it("throws OverCapacityConfirmationRequiredError for an admin override without confirm", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(OVER_CAPACITY);

    await expect(
      calculateModifiedPricing({} as never, {
        ...baseArgs(),
        adminOverride: true,
        confirmOverCapacity: false,
      }),
    ).rejects.toBeInstanceOf(OverCapacityConfirmationRequiredError);
  });

  it("member parity: a held night throws the SAME 400 as a full lodge for a non-admin edit (no exclusive signal)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(WHOLE_LODGE_HELD);

    await expect(
      calculateModifiedPricing({} as never, {
        ...baseArgs(),
        adminOverride: false,
      }),
    ).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: "Not enough beds available for these changes",
    });
  });

  it("held night unconfirmed admin override still routes through OverCapacityConfirmationRequiredError (member-parity confirm prompt, empty confirmable list)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(WHOLE_LODGE_HELD);

    await expect(
      calculateModifiedPricing({} as never, {
        ...baseArgs(),
        adminOverride: true,
        confirmOverCapacity: false,
      }),
    ).rejects.toBeInstanceOf(OverCapacityConfirmationRequiredError);
  });

  it("override NON-BYPASS: a CONFIRMED admin over-capacity override onto a held night throws WholeLodgeHoldBlockedError and does not proceed (decision 5)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(WHOLE_LODGE_HELD);

    let thrown: unknown;
    try {
      await calculateModifiedPricing({} as never, {
        ...baseArgs(),
        adminOverride: true,
        confirmOverCapacity: true,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(WholeLodgeHoldBlockedError);
    expect((thrown as WholeLodgeHoldBlockedError).blockedNights).toEqual([
      "2026-09-11",
    ]);
  });

  it("proceeds with capacityOverridden: true for a confirmed admin override", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(OVER_CAPACITY);
    vi.mocked(resolveGuestRateMembershipTypes).mockImplementation(
      ((_tx: unknown, { guests }: { guests: unknown[] }) =>
        Promise.resolve(guests)) as never,
    );
    const breakdown = {
      totalPriceCents: 32000,
      guests: [
        {
          priceCents: 32000,
          perNightCents: [16000, 16000],
          nightDates: [D("2026-09-10"), D("2026-09-11")],
        },
      ],
    };
    vi.mocked(priceBookingGuestsWithMembershipTypePolicy).mockResolvedValue(
      breakdown as never,
    );
    const tx = {
      groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    } as never;

    const result = await calculateModifiedPricing(tx, {
      ...baseArgs(),
      adminOverride: true,
      confirmOverCapacity: true,
    });

    expect(result.capacityOverridden).toBe(true);
    expect(result.newTotalPriceCents).toBe(32000);
  });
});

// #2029: the in-progress capacity check must cover the genuinely-new check-out-day
// night the widened edit window opened. These drive the REAL plan
// (buildInProgressGuestRangePlan) through calculateModifiedPricing with the
// capacity resolvers mocked, so a wrong range start (editableFrom instead of the
// corrected anchor) leaves the new night invisible and the assertions fail.
describe("calculateModifiedPricing in-progress check-out-day capacity (#2029)", () => {
  const MEMBER_TYPE = "type-member";
  const RATE = 5000;
  const SEASON = [
    {
      seasonId: "s1",
      startDate: D("2026-08-01"),
      endDate: D("2026-08-31"),
      rates: [{ ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: RATE }],
    },
  ];
  const AVAILABLE = { available: true, minAvailable: 5, nightDetails: [] };
  const FULL = {
    available: false,
    minAvailable: -1,
    nightDetails: [{ date: D("2026-08-24"), occupiedBeds: 30, availableBeds: -1 }],
  };

  function existingGuest(stayStart: string, stayEnd: string, priceCents: number) {
    return {
      id: "g1",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      rateMembershipTypeId: MEMBER_TYPE,
      rateSource: "OWN_TYPE",
      stayStart: D(stayStart),
      stayEnd: D(stayEnd),
      // #2736: the real query (`LoadedBookingForModify`) always includes the
      // guest's `BookingGuestNight` rows, so this double supplies them too —
      // without them these cases would only ever exercise the envelope FALLBACK
      // and quietly stop covering the branch production actually takes. They are
      // the envelope expanded, because this guest's stay is contiguous.
      nights: eachDateOnlyInRange(D(stayStart), D(stayEnd)).map((stayDate) => ({
        stayDate,
      })),
      priceCents,
    };
  }

  function inProgressArgs(opts: {
    editableFrom: string;
    newCheckOut: string;
    guestStayStart?: string;
    guestStayEnd?: string;
    guestPriceCents?: number;
    partnerSharedGuests?: Array<{ memberId: string; partnerMemberId: string }>;
  }) {
    const gStart = opts.guestStayStart ?? "2026-08-20";
    const gEnd = opts.guestStayEnd ?? "2026-08-24";
    const price = opts.guestPriceCents ?? 4 * RATE;
    const guest = existingGuest(gStart, gEnd, price);
    return {
      booking: {
        id: "b1",
        memberId: "m1",
        lodgeId: "lodge-1",
        checkIn: D("2026-08-20"),
        checkOut: D(gEnd),
        totalPriceCents: price,
        discountCents: 0,
        promoAdjustmentCents: 0,
        finalPriceCents: price,
        guests: [guest],
      } as never,
      bookingId: "b1",
      isInProgressEdit: true,
      editableFrom: D(opts.editableFrom),
      newCheckIn: D("2026-08-20"),
      newCheckOut: D(opts.newCheckOut),
      normalizedAddGuests: undefined,
      removeGuestIds: undefined,
      guestsForPricing: [
        {
          bookingGuestId: "g1",
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m1",
          stayStart: D(gStart),
          stayEnd: D(opts.newCheckOut),
        },
      ],
      skipBookingLifecycleRules: false,
      seasonRateData: SEASON as never,
      partnerSharedGuests: opts.partnerSharedGuests ?? [],
    };
  }

  it("(a) rejects a check-out-day +1 extension into a FULL night with the normal capacity error", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(FULL);

    await expect(
      calculateModifiedPricing({} as never, {
        ...inProgressArgs({ editableFrom: "2026-08-25", newCheckOut: "2026-08-25" }),
      }),
    ).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: "Not enough beds available for these changes",
    });

    // The resolver was asked about the check-out-day night (08-24), via both the
    // window start and a guest range that covers it.
    const call = h.checkCapacityForGuestRanges.mock.calls[0];
    expect(call[1]).toEqual(D("2026-08-24")); // rangeStart
    const ranges = call[3] as Array<{ stayStart: Date; stayEnd: Date }>;
    expect(ranges).toEqual([
      expect.objectContaining({ stayStart: D("2026-08-24"), stayEnd: D("2026-08-25") }),
    ]);
  });

  it("(b) succeeds when the check-out-day night has capacity, checking that night", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing({} as never, {
      ...inProgressArgs({ editableFrom: "2026-08-25", newCheckOut: "2026-08-25" }),
    });

    // Charged exactly the one new night (ties to the pricing suite).
    expect(result.newTotalPriceCents).toBe(4 * RATE + RATE);
    expect(h.checkCapacityForGuestRanges.mock.calls[0][1]).toEqual(D("2026-08-24"));
  });

  it("(c) mid-stay extension checks from editableFrom (regression pin — unchanged)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    await calculateModifiedPricing({} as never, {
      ...inProgressArgs({ editableFrom: "2026-08-22", newCheckOut: "2026-08-26" }),
    });

    const call = h.checkCapacityForGuestRanges.mock.calls[0];
    expect(call[1]).toEqual(D("2026-08-22")); // == editableFrom, not lowered
    const ranges = call[3] as Array<{ stayStart: Date }>;
    expect(ranges[0].stayStart).toEqual(D("2026-08-22"));
  });

  it("(d) partner-shared path checks the check-out-day night and rejects when full", async () => {
    h.checkCapacityForPartnerSharedAdmission.mockResolvedValue({
      available: false,
      reason: "No partner-shared slot available on 2026-08-24",
      minAvailable: -1,
      nightDetails: [],
    });

    await expect(
      calculateModifiedPricing({} as never, {
        ...inProgressArgs({
          editableFrom: "2026-08-25",
          newCheckOut: "2026-08-25",
          partnerSharedGuests: [{ memberId: "m1", partnerMemberId: "m2" }],
        }),
      }),
    ).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: "No partner-shared slot available on 2026-08-24",
    });

    expect(h.checkCapacityForPartnerSharedAdmission.mock.calls[0][1]).toEqual(
      D("2026-08-24"),
    );
  });

  it("(e) a future-dated partial-range guest never consumes capacity before arrival (#713)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    // Guest occupies [08-22, 08-24); editableFrom is 08-21 (they arrive later).
    await calculateModifiedPricing({} as never, {
      ...inProgressArgs({
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-26",
        guestStayStart: "2026-08-22",
        guestStayEnd: "2026-08-24",
        guestPriceCents: 2 * RATE,
      }),
    });

    const ranges = h.checkCapacityForGuestRanges.mock.calls[0][3] as Array<{
      stayStart: Date;
    }>;
    // Their checked range starts at their own arrival (08-22), never earlier —
    // no phantom bed consumed on 08-21.
    expect(ranges[0].stayStart).toEqual(D("2026-08-22"));
  });
});

// #2736: the per-night breakdown an in-progress edit hands to `applyGuestChanges`
// is what gets written back as `BookingGuestNight` rows, so it decides which
// nights the guest is recorded as holding after the edit — and therefore which
// nights the bed board, the roster and every later edit's locked prices see. It
// used to be built by expanding the plan's envelope, which silently filled a
// sparse guest's gap. These drive the REAL plan through `calculateModifiedPricing`.
describe("calculateModifiedPricing in-progress per-night breakdown (#2736)", () => {
  const MEMBER_TYPE = "type-member";
  const RATE = 5000;
  const SEASON = [
    {
      seasonId: "s1",
      startDate: D("2026-08-01"),
      endDate: D("2026-08-31"),
      rates: [
        { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: RATE },
      ],
    },
  ];
  const AVAILABLE = { available: true, minAvailable: 5, nightDetails: [] };

  /** Nights 08-20 and 08-22 — home on the 21st. */
  function sparseArgs(priceCents: number) {
    const guest = {
      id: "g1",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      rateMembershipTypeId: MEMBER_TYPE,
      rateSource: "OWN_TYPE",
      stayStart: D("2026-08-20"),
      stayEnd: D("2026-08-23"),
      nights: [{ stayDate: D("2026-08-20") }, { stayDate: D("2026-08-22") }],
      priceCents,
    };
    return {
      booking: {
        id: "b1",
        memberId: "m1",
        lodgeId: "lodge-1",
        checkIn: D("2026-08-20"),
        checkOut: D("2026-08-23"),
        totalPriceCents: priceCents,
        discountCents: 0,
        promoAdjustmentCents: 0,
        finalPriceCents: priceCents,
        guests: [guest],
      } as never,
      bookingId: "b1",
      isInProgressEdit: true,
      editableFrom: D("2026-08-21"),
      newCheckIn: D("2026-08-20"),
      newCheckOut: D("2026-08-25"),
      normalizedAddGuests: undefined,
      removeGuestIds: undefined,
      guestsForPricing: [
        {
          bookingGuestId: "g1",
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m1",
          stayStart: D("2026-08-20"),
          stayEnd: D("2026-08-25"),
        },
      ],
      skipBookingLifecycleRules: false,
      seasonRateData: SEASON as never,
      partnerSharedGuests: [],
    };
  }

  it("writes back the gap, not a continuous run", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing(
      {} as never,
      sparseArgs(2 * RATE),
    );

    // 20 and 22 kept, 21 still an absence, 23 and 24 bought by the extension.
    expect(result.priceBreakdown.guests[0].nightDates).toEqual([
      D("2026-08-20"),
      D("2026-08-22"),
      D("2026-08-23"),
      D("2026-08-24"),
    ]);
    expect(result.newTotalPriceCents).toBe(4 * RATE);
  });

  it("splits the total in whole cents that sum back exactly", async () => {
    // An odd total over four nights: the remainder lands on the earliest nights
    // one cent at a time and the parts are integers (INV-MONEY-001,
    // INV-MONEY-003) — no float division, no rounding drift.
    //
    // This guest's rows carry no stored price, so #2744's real-rate write-back
    // has nothing to recover and the even split is still what lands — the
    // behaviour this fixture pinned before, unchanged.
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing({} as never, sparseArgs(1001));
    const guest = result.priceBreakdown.guests[0];

    expect(guest.perNightCents).toHaveLength(guest.nightDates.length);
    for (const cents of guest.perNightCents) {
      expect(Number.isInteger(cents)).toBe(true);
    }
    expect(guest.perNightCents.reduce((a, b) => a + b, 0)).toBe(guest.priceCents);
    expect(guest.priceCents).toBe(1001 + 2 * RATE);
  });
});

describe("calculateModifiedPricing in-progress per-night prices (#2744)", () => {
  const MEMBER_TYPE = "type-member";
  const LOW = 5000;
  const HIGH = 9000;
  const SEASONS = [
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
  const AVAILABLE = { available: true, minAvailable: 5, nightDetails: [] };

  /**
   * The guest from the issue: nights 08-20 and 08-22, both bought at LOW, with
   * the rows recording it. The edit extends the check-out to the 25th, so the
   * 23rd and 24th are bought now at HIGH.
   */
  function args({ withCompanion = false }: { withCompanion?: boolean } = {}) {
    const guest = {
      id: "g1",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      rateMembershipTypeId: MEMBER_TYPE,
      rateSource: "OWN_TYPE",
      stayStart: D("2026-08-20"),
      stayEnd: D("2026-08-23"),
      nights: [
        { stayDate: D("2026-08-20"), priceCents: LOW },
        { stayDate: D("2026-08-22"), priceCents: LOW },
      ],
      priceCents: 2 * LOW,
    };
    // A second guest on the whole run, so taking g1 off does not leave the
    // booking with future nights nobody holds (which the plan refuses, #2736).
    const companion = {
      ...guest,
      id: "g2",
      memberId: "m2",
      nights: [
        { stayDate: D("2026-08-20"), priceCents: LOW },
        { stayDate: D("2026-08-21"), priceCents: LOW },
        { stayDate: D("2026-08-22"), priceCents: LOW },
      ],
      priceCents: 3 * LOW,
    };
    const guests = withCompanion ? [guest, companion] : [guest];
    const totalPriceCents = guests.reduce((sum, g) => sum + g.priceCents, 0);
    return {
      booking: {
        id: "b1",
        memberId: "m1",
        lodgeId: "lodge-1",
        checkIn: D("2026-08-20"),
        checkOut: D("2026-08-23"),
        totalPriceCents,
        discountCents: 0,
        promoAdjustmentCents: 0,
        finalPriceCents: totalPriceCents,
        guests,
      } as never,
      bookingId: "b1",
      isInProgressEdit: true,
      editableFrom: D("2026-08-21"),
      newCheckIn: D("2026-08-20"),
      newCheckOut: D("2026-08-25"),
      normalizedAddGuests: undefined,
      removeGuestIds: undefined,
      guestsForPricing: [
        {
          bookingGuestId: "g1",
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m1",
          stayStart: D("2026-08-20"),
          stayEnd: D("2026-08-25"),
        },
      ],
      skipBookingLifecycleRules: false,
      seasonRateData: SEASONS as never,
      partnerSharedGuests: [],
    };
  }

  it("persists each night's real rate, not the guest's average", async () => {
    // `applyGuestChanges`/`syncGuestNights` writes `perNightCents[k]` onto the
    // `BookingGuestNight` row for `nightDates[k]`, and `lockedNightPricesForGuest`
    // hands that column to the NEXT edit — so these four numbers are what the
    // system will later believe the member paid. They used to be four copies of
    // the average (7000 each); they are the real rates now.
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing({} as never, args());
    const guest = result.priceBreakdown.guests[0];

    expect(guest.nightDates).toEqual([
      D("2026-08-20"),
      D("2026-08-22"),
      D("2026-08-23"),
      D("2026-08-24"),
    ]);
    expect(guest.perNightCents).toEqual([LOW, LOW, HIGH, HIGH]);
    expect(guest.perNightCents.reduce((a, b) => a + b, 0)).toBe(guest.priceCents);
    expect(result.newTotalPriceCents).toBe(2 * LOW + 2 * HIGH);
    // Xero rebuilds its lines per contiguous run of equal price, so the runs
    // have to multiply back out: 2 x LOW and 2 x HIGH, no phantom balance.
    expect(2 * LOW + 2 * HIGH).toBe(guest.priceCents);
  });

  it("credits a removal at the stored price, so nobody comes off owing less than nothing", async () => {
    // Same guest, but the club has raised its rate to HIGH for the nights they
    // still hold and an officer takes them off from the 21st. The 22nd is given
    // back at the LOW it was sold for, leaving exactly the 20th they slept.
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing({} as never, {
      ...args({ withCompanion: true }),
      newCheckOut: D("2026-08-23"),
      removeGuestIds: ["g1"],
    });
    const guest = result.priceBreakdown.guests[0];
    const plan = result.inProgressPlan?.proposedExistingGuests[0];

    expect(plan?.oldFuturePriceCents).toBe(LOW);
    expect(guest.priceCents).toBe(LOW);
    expect(guest.priceCents).toBeGreaterThanOrEqual(0);
    expect(guest.nightDates).toEqual([D("2026-08-20")]);
    expect(guest.perNightCents).toEqual([LOW]);
  });
});
