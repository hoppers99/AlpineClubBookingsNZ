import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    promoRedemptionAllocation: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
    promoCodeAssignment: {
      findMany: vi.fn(),
    },
  },
}));

import {
  BENEFICIAL_PROMO_ALLOCATION_FILTER,
  calculatePromoDiscountForGuestRates,
  deletePromoRedemptionAndAdjustCount,
  getAssignedPromoCodeSummariesForMember,
  isBeneficialPromoAllocation,
  lockPromoCodeRowsForUpdate,
  redeemPromoCode,
  replacePromoRedemptionAllocations,
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
  type PromoApplicationSubject,
  type PromoBeneficiaryAllocation,
} from "../promo";
import type { PromoCodeInput } from "../pricing";

// #2299: a promo application that delivered NO benefit must not consume any of
// the three usage caps (uses per member, total redemptions, unique members).
// The single structural rule that makes that true is "an allocation row exists
// only where the member actually got something" — everything below pins one
// consequence of it.

// --- Fake transaction client -------------------------------------------------

type CallLog = string[];

function makeTx(options: { existingAllocationCount?: number } = {}) {
  const calls: CallLog = [];
  const createdAllocations: PromoBeneficiaryAllocation[] = [];
  const counterUpdates: unknown[] = [];
  const lockedStatements: string[] = [];

  const tx = {
    promoCodeLodge: {
      findMany: vi.fn(async () => []),
    },
    promoRedemption: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("promoRedemption.create");
        return { id: "redemption-1", ...data };
      }),
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
      count: vi.fn(async () => {
        calls.push("allocation.count");
        return options.existingAllocationCount ?? 0;
      }),
      deleteMany: vi.fn(async () => {
        calls.push("allocation.deleteMany");
        return { count: 0 };
      }),
      createMany: vi.fn(
        async ({ data }: { data: PromoBeneficiaryAllocation[] }) => {
          calls.push("allocation.createMany");
          createdAllocations.push(...data);
          return { count: data.length };
        }
      ),
    },
    promoRedemptionGuestTarget: {
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    promoCode: {
      update: vi.fn(async (args: unknown) => {
        calls.push("promoCode.update");
        counterUpdates.push(args);
        return {};
      }),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push("lock");
      lockedStatements.push(strings.join("?"));
      lockedIds.push(String(values[0]));
      return [];
    }),
  };
  const lockedIds: string[] = [];

  return { tx, calls, createdAllocations, counterUpdates, lockedStatements, lockedIds };
}

type RedeemTx = Parameters<typeof redeemPromoCode>[0];

function asTx(tx: ReturnType<typeof makeTx>["tx"]): RedeemTx {
  return tx as unknown as RedeemTx;
}

// --- The benefit test itself -------------------------------------------------

describe("isBeneficialPromoAllocation (#2299 owner decision 1: any price effect)", () => {
  it("counts money off, a price change in EITHER direction, and a subsidised night", () => {
    expect(
      isBeneficialPromoAllocation({
        discountCents: 500,
        priceAdjustmentCents: -500,
        freeNightsUsed: 0,
      })
    ).toBe(true);
    expect(
      isBeneficialPromoAllocation({
        discountCents: 0,
        priceAdjustmentCents: -500,
        freeNightsUsed: 0,
      })
    ).toBe(true);
    // A price-RAISING fixed-nightly application still changed what the member
    // pays, so it is a real use (the rejected alternative counted reductions
    // only).
    expect(
      isBeneficialPromoAllocation({
        discountCents: 0,
        priceAdjustmentCents: 500,
        freeNightsUsed: 0,
      })
    ).toBe(true);
    // A free night on an already-free night moves no money but does consume
    // the member's lifetime free-night allowance, so it counts.
    expect(
      isBeneficialPromoAllocation({
        discountCents: 0,
        priceAdjustmentCents: 0,
        freeNightsUsed: 1,
      })
    ).toBe(true);
  });

  it("rejects an application that moved nothing at all", () => {
    expect(
      isBeneficialPromoAllocation({
        discountCents: 0,
        priceAdjustmentCents: 0,
        freeNightsUsed: 0,
      })
    ).toBe(false);
  });
});

// --- Every shape that can produce a zero-benefit application -----------------

describe("zero-benefit applications produce no allocation row", () => {
  it("percentage off guest-nights that are already free", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 25 };
    const result = calculatePromoDiscountForGuestRates(promo, 0, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [0, 0] },
    ]);

    expect(result.discountCents).toBe(0);
    // Guests WERE eligible — this is exactly the case the old forced fallback
    // turned into a burnt use.
    expect(result.eligibleGuestCount).toBe(1);
    expect(result.allocations).toEqual([]);
    // The redemption row is still written: it is the audit trail (decision 3).
    expect(shouldPersistPromoRedemption(result)).toBe(true);
  });

  it("fixed amount off a zero-dollar stay", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 };
    const result = calculatePromoDiscountForGuestRates(promo, 0, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [0] },
    ]);

    expect(result.discountCents).toBe(0);
    expect(result.eligibleGuestCount).toBe(1);
    expect(result.allocations).toEqual([]);
    expect(shouldPersistPromoRedemption(result)).toBe(true);
  });

  it("fixed nightly SET_PRICE where the guest already pays exactly that price", () => {
    const promo: PromoCodeInput = {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
    };
    const result = calculatePromoDiscountForGuestRates(promo, 6000, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [3000, 3000] },
    ]);

    expect(result.priceAdjustmentCents).toBe(0);
    expect(result.eligibleGuestCount).toBe(1);
    expect(result.allocations).toEqual([]);
  });

  it("still allocates when the promo really does change the price", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 25 };
    const result = calculatePromoDiscountForGuestRates(promo, 8000, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [4000, 4000] },
    ]);

    expect(result.discountCents).toBe(2000);
    expect(result.allocations).toEqual([
      {
        memberId: "member-1",
        discountCents: 2000,
        priceAdjustmentCents: -2000,
        freeNightsUsed: 0,
      },
    ]);
  });

  it("keeps a free night on an already-free night as a real use", () => {
    // freeNightsUsed > 0 is a benefit even at $0: it draws down the member's
    // lifetime free-night allowance.
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 1 };
    const result = calculatePromoDiscountForGuestRates(promo, 0, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [0] },
    ]);

    expect(result.freeNightsUsed).toBe(1);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({
      memberId: "member-1",
      discountCents: 0,
      freeNightsUsed: 1,
    });
    // Negative zero: pricing computes -discountCents, so a $0 free night
    // yields -0 here. It must be read as "no price change" (and it is — the
    // benefit test uses !== 0, and -0 !== 0 is false), otherwise every
    // zero-discount application would look like a price effect.
    expect(result.allocations[0].priceAdjustmentCents === 0).toBe(true);
  });

  it("does not mistake negative zero for a price effect", () => {
    expect(
      isBeneficialPromoAllocation({
        discountCents: 0,
        priceAdjustmentCents: -0,
        freeNightsUsed: 0,
      })
    ).toBe(false);
  });
});

// --- The persistence layer ---------------------------------------------------

describe("redeemPromoCode consumes a cap slot only for a real benefit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the redemption but NO allocation row, and takes no slot, at zero benefit", async () => {
    const { tx, createdAllocations, counterUpdates } = makeTx();

    await redeemPromoCode(asTx(tx), "promo-1", "booking-1", "member-1", 0, 0, 0, 2);

    expect(tx.promoRedemption.create).toHaveBeenCalledTimes(1);
    expect(tx.promoRedemptionAllocation.createMany).not.toHaveBeenCalled();
    expect(createdAllocations).toEqual([]);
    expect(counterUpdates).toEqual([
      {
        where: { id: "promo-1" },
        data: { currentRedemptions: { increment: 0 } },
      },
    ]);
  });

  it("takes exactly one slot for a beneficial application", async () => {
    const { tx, createdAllocations, counterUpdates } = makeTx();

    await redeemPromoCode(asTx(tx), "promo-1", "booking-1", "member-1", 2000, -2000, 0, 1);

    expect(createdAllocations).toHaveLength(1);
    expect(counterUpdates).toEqual([
      {
        where: { id: "promo-1" },
        data: { currentRedemptions: { increment: 1 } },
      },
    ]);
  });

  it("drops a zero-benefit member from a mixed allocation set", async () => {
    // Pricing emits a deliberately zero entry for a SET_PRICE guest whose rate
    // already equals the fixed price; that member benefited from nothing and
    // must not occupy a unique-member place.
    const { tx, createdAllocations, counterUpdates } = makeTx();

    await redeemPromoCode(
      asTx(tx),
      "promo-1",
      "booking-1",
      "member-1",
      1500,
      -1500,
      0,
      2,
      [
        {
          memberId: "member-1",
          discountCents: 1500,
          priceAdjustmentCents: -1500,
          freeNightsUsed: 0,
        },
        {
          memberId: "member-2",
          discountCents: 0,
          priceAdjustmentCents: 0,
          freeNightsUsed: 0,
        },
      ]
    );

    expect(createdAllocations.map((a) => a.memberId)).toEqual(["member-1"]);
    expect(counterUpdates).toEqual([
      {
        where: { id: "promo-1" },
        data: { currentRedemptions: { increment: 1 } },
      },
    ]);
  });
});

// The `PromoRedemption_sync_allocation_insert` / `..._update` triggers
// (20260527120000_add_promo_redemption_allocations) upsert a booker allocation
// row straight from the redemption's own scalars whenever a PromoRedemption is
// written — they exist so an old blue/green colour that writes only
// PromoRedemption still gets an allocation. For a zero-benefit application that
// row is all-zero, so the statement order in these two writers is load-bearing:
// remove it and the database quietly puts back the row #2299 deletes.
describe("the allocation-sync triggers cannot resurrect a zero-benefit row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the trigger's row AFTER creating the redemption", async () => {
    const { tx, calls } = makeTx();

    await redeemPromoCode(asTx(tx), "promo-1", "booking-1", "member-1", 0, 0, 0, 2);

    expect(calls.indexOf("allocation.deleteMany")).toBeGreaterThan(
      calls.indexOf("promoRedemption.create")
    );
    expect(calls).not.toContain("allocation.createMany");
  });

  it("deletes the trigger's row AFTER updating the redemption on a reprice", async () => {
    const { tx, calls } = makeTx({ existingAllocationCount: 1 });

    await replacePromoRedemptionAllocations(
      asTx(tx),
      {
        id: "redemption-1",
        promoCodeId: "promo-1",
        bookingId: "booking-1",
        memberId: "member-1",
      },
      0,
      0,
      0,
      2
    );

    expect(calls.indexOf("allocation.deleteMany")).toBeGreaterThan(
      calls.indexOf("promoRedemption.update")
    );
  });

  it("counts the existing rows BEFORE the update, so the trigger cannot skew the delta", async () => {
    const { tx, calls } = makeTx({ existingAllocationCount: 1 });

    await replacePromoRedemptionAllocations(
      asTx(tx),
      {
        id: "redemption-1",
        promoCodeId: "promo-1",
        bookingId: "booking-1",
        memberId: "member-1",
      },
      0,
      0,
      0,
      2
    );

    expect(calls.indexOf("allocation.count")).toBeLessThan(
      calls.indexOf("promoRedemption.update")
    );
  });
});

describe("currentRedemptions stays symmetric with the allocation rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("releases the slot when a reprice destroys the whole benefit", async () => {
    const { tx, createdAllocations, counterUpdates } = makeTx({
      existingAllocationCount: 1,
    });

    await replacePromoRedemptionAllocations(
      asTx(tx),
      {
        id: "redemption-1",
        promoCodeId: "promo-1",
        bookingId: "booking-1",
        memberId: "member-1",
      },
      0,
      0,
      0,
      2
    );

    expect(createdAllocations).toEqual([]);
    expect(counterUpdates).toEqual([
      {
        where: { id: "promo-1" },
        data: { currentRedemptions: { decrement: 1 } },
      },
    ]);
  });

  it("measures the delta against the RAW row count, so a legacy all-zero row nets out", async () => {
    // A pre-#2299 database has an all-zero allocation row that the old code
    // counted (and incremented the counter for). Repricing it into a real
    // benefit replaces one row with one row: the counter must not move.
    const { tx, counterUpdates } = makeTx({ existingAllocationCount: 1 });

    await replacePromoRedemptionAllocations(
      asTx(tx),
      {
        id: "redemption-1",
        promoCodeId: "promo-1",
        bookingId: "booking-1",
        memberId: "member-1",
      },
      2500,
      -2500,
      0,
      1
    );

    expect(tx.promoRedemptionAllocation.count).toHaveBeenCalledWith({
      where: { promoRedemptionId: "redemption-1" },
    });
    expect(counterUpdates).toEqual([]);
  });

  it("gives back exactly what was taken when the redemption is deleted", async () => {
    const { tx, counterUpdates } = makeTx({ existingAllocationCount: 2 });

    await deletePromoRedemptionAndAdjustCount(asTx(tx), {
      id: "redemption-1",
      promoCodeId: "promo-1",
    });

    expect(counterUpdates).toEqual([
      {
        where: { id: "promo-1" },
        data: { currentRedemptions: { decrement: 2 } },
      },
    ]);
  });

  it("touches the counter not at all when a benefit-free redemption is deleted", async () => {
    const { tx, counterUpdates } = makeTx({ existingAllocationCount: 0 });

    await deletePromoRedemptionAndAdjustCount(asTx(tx), {
      id: "redemption-1",
      promoCodeId: "promo-1",
    });

    expect(tx.promoRedemption.delete).toHaveBeenCalledTimes(1);
    expect(counterUpdates).toEqual([]);
  });
});

// --- The cap queries ---------------------------------------------------------

function makePromoSubject(
  overrides: Partial<PromoApplicationSubject> = {}
): PromoApplicationSubject {
  return {
    id: "promo-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
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
    ...overrides,
  };
}

describe("usage-cap counts ignore historical zero-benefit rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets a member reuse a single-use code their only prior application did nothing for", async () => {
    const { prisma } = await import("@/lib/prisma");
    // The benefit filter is what makes this 0: the member has one stored
    // allocation row, but it carries no benefit.
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as never);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([] as never);

    const result = await validateAndCalculatePromoDiscount(
      makePromoSubject({ maxUsesPerMember: 1 }),
      {
        memberId: "member-1",
        totalPriceCents: 10000,
        guests: [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000] }],
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.discount?.discountCents).toBe(2000);
    // Every per-member count is asked for beneficial rows only.
    expect(vi.mocked(prisma.promoRedemptionAllocation.count)).toHaveBeenCalledWith({
      where: {
        promoCodeId: "promo-1",
        memberId: "member-1",
        ...BENEFICIAL_PROMO_ALLOCATION_FILTER,
      },
    });
  });

  it("still refuses when the member's prior application DID give them something", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(1);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as never);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([] as never);

    const result = await validateAndCalculatePromoDiscount(
      makePromoSubject({ maxUsesPerMember: 1 }),
      {
        memberId: "member-1",
        totalPriceCents: 10000,
        guests: [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000] }],
      }
    );

    expect(result.error).toBe("You have already used this promo code");
  });

  it("counts unique members and prior beneficiaries on beneficial rows only", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as never);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([] as never);

    await validateAndCalculatePromoDiscount(
      makePromoSubject({ maxUniqueMembersTotal: 5 }),
      {
        memberId: "member-1",
        totalPriceCents: 10000,
        guests: [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000] }],
      }
    );

    const findManyCalls = vi.mocked(prisma.promoRedemptionAllocation.findMany).mock.calls;
    expect(findManyCalls.length).toBeGreaterThan(0);
    for (const [args] of findManyCalls) {
      expect(args?.where).toMatchObject(BENEFICIAL_PROMO_ALLOCATION_FILTER);
    }
  });

  it("does not benefit-filter the lifetime free-nights sum (fail-safe direction)", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as never);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([] as never);

    await validateAndCalculatePromoDiscount(makePromoSubject(), {
      memberId: "member-1",
      totalPriceCents: 10000,
      guests: [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000] }],
    });

    expect(vi.mocked(prisma.promoRedemptionAllocation.aggregate)).toHaveBeenCalledWith({
      where: { promoCodeId: "promo-1", memberId: "member-1" },
      _sum: { freeNightsUsed: true },
    });
  });
});

describe("member-facing status is benefit-gated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not say "Already used by member" for a benefit-free application', async () => {
    const { prisma } = await import("@/lib/prisma");
    // The filtered include returns no rows: the member's only stored
    // allocation for this code carried no benefit.
    vi.mocked(prisma.promoCodeAssignment.findMany).mockResolvedValue([
      {
        createdAt: new Date("2026-07-01T00:00:00Z"),
        promoCode: {
          id: "promo-1",
          code: "CAP80",
          description: null,
          type: "FIXED_NIGHTLY_PRICE",
          percentOff: null,
          valueCents: null,
          freeNightsPerIndividual: null,
          lifetimeFreeNightsCap: null,
          fixedNightlyPriceCents: 8000,
          fixedNightlyMode: "CAP_ONLY",
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: null,
          bookingStartFrom: null,
          bookingStartUntil: null,
          assignedMembersOnlyOwnNights: true,
          maxRedemptionsTotal: null,
          currentRedemptions: 0,
          maxUsesPerMember: 1,
          allocations: [],
        },
      },
    ] as never);

    const summaries = await getAssignedPromoCodeSummariesForMember(
      "member-1",
      new Date("2026-07-15T00:00:00Z")
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0].redemptionCount).toBe(0);
    expect(summaries[0].statusReason).toBe("Available to member");
    expect(summaries[0].visibleToMember).toBe(true);
  });
});

// --- The concurrency guard ---------------------------------------------------

describe("lockPromoCodeRowsForUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks every promo row in a deterministic id order, one statement each", async () => {
    const { tx, lockedIds, lockedStatements } = makeTx();

    await lockPromoCodeRowsForUpdate(asTx(tx), ["promo-z", "promo-a", "promo-m"]);

    // Sorted in the application, so two transactions doing opposite promo
    // swaps take the rows in the same order and cannot build a lock cycle.
    expect(lockedIds).toEqual(["promo-a", "promo-m", "promo-z"]);
    for (const statement of lockedStatements) {
      expect(statement).toContain("FOR UPDATE");
      // Only "id" is selected and the result is discarded: the statement
      // exists for its lock, never for its shape (#2289).
      expect(statement).toContain('SELECT "id" FROM "PromoCode"');
    }
  });

  it("de-duplicates and ignores absent ids", async () => {
    const { tx, lockedIds } = makeTx();

    await lockPromoCodeRowsForUpdate(asTx(tx), [
      "promo-a",
      null,
      undefined,
      "promo-a",
      "",
    ]);

    expect(lockedIds).toEqual(["promo-a"]);
  });

  it("locks nothing at all when there is nothing to lock", async () => {
    const { tx } = makeTx();

    await lockPromoCodeRowsForUpdate(asTx(tx), [null, undefined]);

    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

// --- The repair migration ----------------------------------------------------

const repairSql = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260731130000_repair_zero_benefit_promo_allocations/migration.sql"
  ),
  "utf8"
);

describe("zero-benefit repair migration", () => {
  it("deletes exactly the negation of the application's benefit test", () => {
    expect(repairSql).toMatch(
      /DELETE FROM "PromoRedemptionAllocation"\s+WHERE "discountCents" <= 0\s+AND "priceAdjustmentCents" = 0\s+AND "freeNightsUsed" <= 0;/
    );
  });

  it("keeps the PromoRedemption audit rows", () => {
    expect(repairSql).not.toContain('DELETE FROM "PromoRedemption"');
    expect(repairSql).not.toContain('DELETE FROM "PromoRedemptionGuestTarget"');
  });

  it("rebases currentRedemptions by recounting, so re-running it is a no-op", () => {
    expect(repairSql).toContain('UPDATE "PromoCode"');
    expect(repairSql).toContain('SET "currentRedemptions" = COALESCE(counted."allocationCount", 0)');
    expect(repairSql).toContain('SELECT COUNT(*) FROM "PromoRedemptionAllocation" a');
    // Guarded so untouched codes are not written at all.
    expect(repairSql).toContain(
      'AND "PromoCode"."currentRedemptions" <> COALESCE(counted."allocationCount", 0)'
    );
  });

  it("makes no schema change and writes no session clock", () => {
    expect(repairSql).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|TYPE|INDEX|CONSTRAINT)/i);
    expect(repairSql).not.toMatch(/CURRENT_TIMESTAMP|[^A-Za-z_]now\s*\(/i);
  });
});
