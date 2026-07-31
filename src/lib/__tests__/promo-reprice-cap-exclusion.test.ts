import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #2299 F1 — LIVE MONEY BUG.
//
// `PromoCode.currentRedemptions` is a denormalised count of EVERY allocation row
// for the code, INCLUDING the rows the booking being repriced already holds.
// Every other usage cap honours `excludeBookingId` by filtering the allocation
// table; this one cannot, because it is a counter. So a booking sitting on the
// code's last remaining slot used to fail its OWN re-validation with "This promo
// code has reached its maximum number of uses" — 1 + 1 > 1 — fall into
// `deletePromoRedemptionAndAdjustCount`, and come out the other side with
// newDiscountCents = 0. `newFinalPriceCents` then equals `newTotalPriceCents`,
// and `priceDiffCents` bills the member the WHOLE discount back for nothing more
// than a date shift or an added guest.
//
// The four reprice paths are `booking-modify-plan.ts` (batch modification),
// `/api/bookings/[id]/guests` (adding guests),
// `booking-date-modification-service.ts` (changing dates) and
// `booking-guest-removal-service.ts` (removing guests). Two of them are directly
// callable and are driven end to end below against the REAL promo module; the
// other two are inline in much larger functions, so their wiring is pinned by
// the source contract at the bottom of this file.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    promoRedemptionAllocation: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { applyPromoCodeChanges } from "../booking-modify-plan";
import { recalculateBookingPromo } from "../booking-guest-removal-service";
import {
  validateAndCalculatePromoDiscount,
  validatePromoCodeRules,
  type PromoApplicationSubject,
} from "../promo";

// --- The pure arithmetic -----------------------------------------------------

const SUBJECT = {
  id: "promo-1",
  active: true,
  validFrom: null,
  validUntil: null,
  maxRedemptionsTotal: 1,
  currentRedemptions: 1,
  membersOnly: false,
  maxUsesPerMember: null,
  maxUniqueMembersTotal: null,
};

describe("total-redemptions cap discounts the excluded booking's own rows (#2299 F1)", () => {
  const booking = { memberId: "member-1" };

  it("refuses a NEW booking when the code's only slot is taken", () => {
    expect(
      validatePromoCodeRules(SUBJECT, booking, new Date(), {
        requestedRedemptionCount: 1,
      })
    ).toBe("This promo code has reached its maximum number of uses");
  });

  it("allows the booking that HOLDS that slot to keep it through a reprice", () => {
    // The one counted row is this booking's own; it is about to be replaced.
    expect(
      validatePromoCodeRules(SUBJECT, booking, new Date(), {
        requestedRedemptionCount: 1,
        excludedBookingRedemptionCount: 1,
      })
    ).toBeNull();
  });

  it("still refuses when the booking would take MORE slots than it holds", () => {
    // Adding a second beneficiary to a booking that holds one slot on a
    // one-slot code: 1 - 1 + 2 = 2 > 1.
    expect(
      validatePromoCodeRules(SUBJECT, booking, new Date(), {
        requestedRedemptionCount: 2,
        excludedBookingRedemptionCount: 1,
      })
    ).toBe("This promo code has reached its maximum number of uses");
  });

  it("still refuses when another booking holds the last slot", () => {
    expect(
      validatePromoCodeRules(SUBJECT, booking, new Date(), {
        requestedRedemptionCount: 1,
        excludedBookingRedemptionCount: 0,
      })
    ).toBe("This promo code has reached its maximum number of uses");
  });

  it("never turns a drifted-low counter into extra allowance", () => {
    // Floored at zero: a counter reading 0 with an excluded booking holding 2
    // rows must not produce -2 and hand out three free slots.
    expect(
      validatePromoCodeRules(
        { ...SUBJECT, currentRedemptions: 0 },
        booking,
        new Date(),
        { requestedRedemptionCount: 2, excludedBookingRedemptionCount: 2 }
      )
    ).toBe("This promo code has reached its maximum number of uses");
  });
});

// --- The choke point every path shares ---------------------------------------

function promoSubject(
  overrides: Partial<PromoApplicationSubject> = {}
): PromoApplicationSubject {
  return {
    id: "promo-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: 1,
    currentRedemptions: 1,
    membersOnly: false,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    type: "PERCENTAGE",
    valueCents: null,
    percentOff: 20,
    freeNightsPerIndividual: null,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxGuestsPerBooking: null,
    maxNightlyValueCents: null,
    memberGuestsOnly: false,
    assignedMembersOnlyOwnNights: true,
    lodges: [],
    ...overrides,
  };
}

function usageDb(options: { ownAllocationRows?: number } = {}) {
  const countCalls: Record<string, unknown>[] = [];
  return {
    countCalls,
    db: {
      promoRedemptionAllocation: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          countCalls.push(where);
          // The excluded booking's own rows are counted with `bookingId`
          // EQUAL to it; the per-member cap counts with `bookingId: { not }`.
          return typeof where.bookingId === "string"
            ? options.ownAllocationRows ?? 0
            : 0;
        }),
        aggregate: vi.fn(async () => ({ _sum: { freeNightsUsed: 0 } })),
        findMany: vi.fn(async () => []),
      },
    },
  };
}

const BOOKING_DETAILS = {
  memberId: "member-1",
  totalPriceCents: 10000,
  guests: [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000] }],
};

describe("validateAndCalculatePromoDiscount measures the excluded booking's rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the discount when the booking holds the code's last slot", async () => {
    const { db, countCalls } = usageDb({ ownAllocationRows: 1 });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject(),
      BOOKING_DETAILS,
      null,
      { excludeBookingId: "booking-1", db: db as never }
    );

    expect(application.error).toBeUndefined();
    expect(application.discount?.discountCents).toBe(2000);
    // Counted RAW — no benefit filter — because that is the unit
    // `currentRedemptions` itself is kept in.
    expect(countCalls).toContainEqual({
      promoCodeId: "promo-1",
      bookingId: "booking-1",
    });
  });

  it("still refuses when the slot belongs to some other booking", async () => {
    const { db } = usageDb({ ownAllocationRows: 0 });

    const application = await validateAndCalculatePromoDiscount(
      promoSubject(),
      BOOKING_DETAILS,
      null,
      { excludeBookingId: "booking-1", db: db as never }
    );

    expect(application.error).toBe(
      "This promo code has reached its maximum number of uses"
    );
  });

  it("does not query for the exclusion when there is no total cap", async () => {
    const { db, countCalls } = usageDb({ ownAllocationRows: 1 });

    await validateAndCalculatePromoDiscount(
      promoSubject({ maxRedemptionsTotal: null, currentRedemptions: 7 }),
      BOOKING_DETAILS,
      null,
      { excludeBookingId: "booking-1", db: db as never }
    );

    expect(
      countCalls.filter((where) => typeof where.bookingId === "string")
    ).toEqual([]);
  });

  it("does not query for the exclusion on a NEW booking", async () => {
    const { db, countCalls } = usageDb();

    await validateAndCalculatePromoDiscount(
      promoSubject({ currentRedemptions: 0 }),
      BOOKING_DETAILS,
      null,
      { db: db as never }
    );

    expect(
      countCalls.filter((where) => typeof where.bookingId === "string")
    ).toEqual([]);
  });
});

// --- The reprice paths, driven end to end ------------------------------------

const PROMO_ROW = {
  id: "promo-1",
  code: "LASTONE",
  internal: false,
  active: true,
  validFrom: null,
  validUntil: null,
  bookingStartFrom: null,
  bookingStartUntil: null,
  // One slot, already taken — by the booking being repriced.
  maxRedemptionsTotal: 1,
  currentRedemptions: 1,
  maxUniqueMembersTotal: null,
  maxUsesPerMember: null,
  membersOnly: false,
  memberGuestsOnly: false,
  type: "PERCENTAGE",
  valueCents: null,
  percentOff: 20,
  freeNightsPerIndividual: null,
  lifetimeFreeNightsCap: null,
  fixedNightlyPriceCents: null,
  fixedNightlyMode: null,
  maxGuestsPerBooking: null,
  maxNightlyValueCents: null,
  assignedMembersOnlyOwnNights: true,
  assignments: [],
  lodges: [],
};

/**
 * A transaction client for the reprice branches. `ownAllocationRows` is how many
 * allocation rows the booking under reprice holds for this code; every other
 * allocation query (per-member caps, unique members) sees nothing, so the ONLY
 * thing standing between the booking and its discount is the total-uses check.
 */
function makeRepriceTx(options: { ownAllocationRows?: number } = {}) {
  const calls: string[] = [];
  const lockedIds: string[] = [];

  const tx = {
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push("lock");
      lockedIds.push(String(values[0]));
      return [];
    }),
    promoCode: {
      findUnique: vi.fn(async () => {
        calls.push("promoCode.findUnique");
        return PROMO_ROW;
      }),
      update: vi.fn(async () => {
        calls.push("promoCode.update");
        return {};
      }),
    },
    promoCodeLodge: { findMany: vi.fn(async () => []) },
    promoRedemption: {
      update: vi.fn(async () => {
        calls.push("promoRedemption.update");
        return {};
      }),
      delete: vi.fn(async () => {
        calls.push("promoRedemption.delete");
        return {};
      }),
    },
    promoRedemptionAllocation: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // The redemption's own row count (counter delta), the excluded
        // booking's rows (the F1 exclusion), and the per-member cap counts.
        if (where.promoRedemptionId) return options.ownAllocationRows ?? 1;
        if (typeof where.bookingId === "string") {
          return options.ownAllocationRows ?? 1;
        }
        return 0;
      }),
      aggregate: vi.fn(async () => ({ _sum: { freeNightsUsed: 0 } })),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
        calls.push("allocation.createMany");
        return { count: data.length };
      }),
    },
    promoRedemptionGuestTarget: {
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };

  return { tx, calls, lockedIds };
}

const STORED_REDEMPTION = {
  id: "redemption-1",
  promoCodeId: "promo-1",
  bookingId: "booking-1",
  memberId: "member-1",
  guestTargets: [],
  promoCode: PROMO_ROW,
};

const GUEST_NIGHT_RATES = [
  {
    bookingGuestId: "bg-1",
    memberId: "member-1",
    isMember: true,
    perNightRates: [5000, 5000],
  },
];

describe("path 1 — batch modification reprice (booking-modify-plan)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  type ApplyArgs = Parameters<typeof applyPromoCodeChanges>;

  function run(tx: ReturnType<typeof makeRepriceTx>["tx"]) {
    return applyPromoCodeChanges(tx as unknown as ApplyArgs[0], {
      booking: {
        memberId: "member-1",
        lodgeId: "lodge-1",
        promoRedemption: STORED_REDEMPTION,
      } as unknown as ApplyArgs[1]["booking"],
      bookingId: "booking-1",
      input: {} as unknown as ApplyArgs[1]["input"],
      inProgressPlan: null,
      newCheckIn: new Date("2026-08-01T00:00:00Z"),
      newTotalPriceCents: 10000,
      guestNightRates: GUEST_NIGHT_RATES,
    });
  }

  it("keeps the discount instead of billing it back", async () => {
    const { tx, calls } = makeRepriceTx();

    const result = await run(tx);

    expect(result.promoRemoved).toBe(false);
    expect(result.newDiscountCents).toBe(2000);
    expect(result.newPromoAdjustmentCents).toBe(-2000);
    expect(calls).not.toContain("promoRedemption.delete");
    expect(calls).toContain("allocation.createMany");
  });

  it("re-reads the counter under the lock before checking the cap", async () => {
    const { tx, calls, lockedIds } = makeRepriceTx();

    await run(tx);

    // Locked twice: once up front for the possible swap pair, once by the
    // reprice wrapper. Re-locking a row this transaction already holds is a
    // no-op, and keeping one helper means no caller can take the counter
    // without the lock.
    expect(new Set(lockedIds)).toEqual(new Set(["promo-1"]));
    // The authoritative counter read happens after the lock, and the cap the
    // reprice consumes is the cap it checked.
    expect(calls.indexOf("promoCode.findUnique")).toBeGreaterThan(
      calls.indexOf("lock")
    );
    expect(calls.indexOf("promoCode.findUnique")).toBeLessThan(
      calls.indexOf("allocation.createMany")
    );
  });
});

describe("path 4 — guest removal reprice (booking-guest-removal-service)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  type RemovalArgs = Parameters<typeof recalculateBookingPromo>[0];

  function run(tx: ReturnType<typeof makeRepriceTx>["tx"]) {
    return recalculateBookingPromo({
      tx: tx as unknown as RemovalArgs["tx"],
      bookingId: "booking-1",
      booking: {
        memberId: "member-1",
        lodgeId: "lodge-1",
        checkIn: new Date("2026-08-01T00:00:00Z"),
        promoRedemption: STORED_REDEMPTION,
      } as unknown as RemovalArgs["booking"],
      newTotalPriceCents: 10000,
      guestNightRates: GUEST_NIGHT_RATES,
    });
  }

  it("keeps the discount instead of billing it back", async () => {
    const { tx, calls } = makeRepriceTx();

    const result = await run(tx);

    expect(result.promoRemoved).toBe(false);
    expect(result.newDiscountCents).toBe(2000);
    expect(calls).not.toContain("promoRedemption.delete");
  });

  it("row-locks the promo code and re-reads its counter first (#2299 F2)", async () => {
    const { tx, calls, lockedIds } = makeRepriceTx();

    await run(tx);

    // This path used to read caps and write `currentRedemptions` with no lock
    // at all, so two concurrent modifications could both take the last slot.
    expect(lockedIds).toEqual(["promo-1"]);
    expect(calls[0]).toBe("lock");
    expect(calls.indexOf("promoCode.findUnique")).toBeGreaterThan(
      calls.indexOf("lock")
    );
  });
});

// --- The two inline paths, pinned by their source ----------------------------
//
// Adding guests and changing dates repeat the same reprice block inside much
// larger functions that cannot be called without standing up most of the
// booking pipeline. What can regress there is the WIRING — dropping the
// exclusion, or dropping the lock — so that is what is pinned. The arithmetic
// itself is covered above, at the choke point all four share.

function readSource(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

/**
 * The argument text of every `validateAndCalculatePromoDiscount(...)` call in a
 * file. Deliberately scoped to the call itself: a file can carry an unrelated
 * `excludeBookingId: bookingId` (the member-night conflict guard does), so
 * searching the whole file would pass even with the promo exclusion deleted.
 */
function promoValidationCallArguments(source: string): string[] {
  const marker = "validateAndCalculatePromoDiscount(";
  const calls: string[] = [];
  let from = source.indexOf(marker);
  while (from !== -1) {
    let depth = 0;
    let index = from + marker.length - 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(from, index + 1));
    from = source.indexOf(marker, index + 1);
  }
  return calls;
}

const REPRICE_CALL_SITES: Array<[string, string]> = [
  ["adding guests", "src/app/api/bookings/[id]/guests/route.ts"],
  ["changing dates", "src/lib/booking-date-modification-service.ts"],
  ["removing guests", "src/lib/booking-guest-removal-service.ts"],
  ["batch modification", "src/lib/booking-modify-plan.ts"],
];

describe("every reprice path excludes its own booking and takes the promo lock", () => {
  it.each(REPRICE_CALL_SITES)(
    "%s passes excludeBookingId into the promo validation itself",
    (_name, path) => {
      const calls = promoValidationCallArguments(readSource(path));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // Without this the booking's own allocation rows are counted against
        // the total-uses cap and it fails its own reprice.
        expect(call).toContain("excludeBookingId: bookingId");
      }
    }
  );

  it.each(REPRICE_CALL_SITES.slice(0, 3))(
    "%s locks and refreshes the promo row before validating",
    (_name, path) => {
      const source = readSource(path);
      const lockIndex = source.indexOf("await lockAndRefreshPromoCodeUsage(");
      const validateIndex = source.indexOf("validateAndCalculatePromoDiscount(");
      // Called, not merely imported, and called first: without it the cap read
      // and the counter write are not serialised against the other paths.
      expect(lockIndex).toBeGreaterThan(-1);
      expect(validateIndex).toBeGreaterThan(-1);
      expect(lockIndex).toBeLessThan(validateIndex);
    }
  );

  it("the batch-modification path locks both codes of a swap up front", () => {
    const source = readSource("src/lib/booking-modify-plan.ts");
    const lockIndex = source.indexOf("await lockPromoCodeRowsForUpdate(tx, [");
    const validateIndex = source.indexOf("validateAndCalculatePromoDiscount(");
    expect(lockIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeLessThan(validateIndex);
    // ...and refreshes the counter on its own reprice branch, whose snapshot
    // was loaded with the booking, before the lock.
    expect(source).toContain("await lockAndRefreshPromoCodeUsage(");
  });
});
