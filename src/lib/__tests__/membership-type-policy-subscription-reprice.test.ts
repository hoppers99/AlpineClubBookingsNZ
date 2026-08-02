import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2543 — the money. An unpaid member's own nights price at the built-in
 * NON_MEMBER rate when, and only when, the club runs `NON_MEMBER_PRICING`.
 *
 * WHY THIS TESTS THE PRICING GATE AND NOT THE FIVE ROUTES. The reprice is applied
 * inside `resolveGuestRateMembershipTypes`, the single function every one of the
 * ~25 places that price a booking already passes through (create, confirm, quote,
 * modify preview, modify apply, guest add/removal, group join, waitlist and
 * cross-lodge promotion, booking and school requests, promo validation). Asserting
 * it here is what makes "consistent across every write path" a structural
 * property rather than a review checklist.
 *
 * Every assertion is in INTEGER CENTS, against the same NON_MEMBER rate row and
 * the same `TYPE_POLICY_FORCED` rateSource any other non-member resolves to — so
 * Xero narrates an ordinary non-member line and no new money path exists.
 */

const mocks = vi.hoisted(() => ({
  peekSubscriptionLockoutMode: vi.fn(),
  requiresPaidSubscriptionForBooking: vi.fn(async () => true),
}));

vi.mock("@/lib/member-subscription-eligibility", () => ({
  peekSubscriptionLockoutMode: mocks.peekSubscriptionLockoutMode,
  requiresPaidSubscriptionForBooking: mocks.requiresPaidSubscriptionForBooking,
}));

vi.mock("@/lib/age-tier", () => ({
  getAgeTierSettings: vi.fn(async () => [
    { tier: "CHILD", subscriptionRequiredForBooking: false },
    { tier: "YOUTH", subscriptionRequiredForBooking: true },
    { tier: "ADULT", subscriptionRequiredForBooking: true },
  ]),
}));

import {
  priceBookingGuestsWithMembershipTypePolicy,
  resolveGuestRateMembershipTypes,
} from "@/lib/membership-type-policy";

const MEMBER_RATE_CENTS = 1000;
const NON_MEMBER_RATE_CENTS = 2400;

type TestMembershipType = {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
  subscriptionBehavior: "REQUIRED" | "NOT_REQUIRED" | "BASED_ON_AGE_TIER";
};

const fullType: TestMembershipType = {
  id: "type-full",
  key: "FULL",
  name: "Full",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
};

const nonMemberType: TestMembershipType = {
  id: "type-nonmember",
  key: "NON_MEMBER",
  name: "Non-member",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "NON_MEMBER_RATE",
  subscriptionBehavior: "NOT_REQUIRED",
};

/** Member rates, and a subscription is never required — a LIFE member. */
const lifeType: TestMembershipType = {
  id: "type-life",
  key: "LIFE",
  name: "Life",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "NOT_REQUIRED",
};

const seasonRates = [
  {
    seasonId: "season-2026",
    startDate: new Date("2026-04-01T00:00:00.000Z"),
    endDate: new Date("2026-10-31T00:00:00.000Z"),
    rates: [
      {
        membershipTypeId: "type-full",
        ageTier: "ADULT" as const,
        pricePerNightCents: MEMBER_RATE_CENTS,
      },
      {
        membershipTypeId: "type-nonmember",
        ageTier: "ADULT" as const,
        pricePerNightCents: NON_MEMBER_RATE_CENTS,
      },
    ],
  },
];

type Sub = { memberId: string; status: "PAID" | "NOT_INVOICED" | "NOT_REQUIRED" };

/**
 * A client carrying EVERY delegate the reprice reads. Deliberately complete: the
 * reprice returns an empty set for a client it cannot read from, so a narrow
 * double would make this whole file pass vacuously while the rule did nothing.
 */
function makeDb(options: {
  members: string[];
  subscriptions: Sub[];
  /** The membership type every listed member is assigned; FULL by default. */
  type?: TestMembershipType;
}) {
  const assignedType = options.type ?? fullType;
  const members = options.members.map((id) => ({
    id,
    firstName: "Alex",
    lastName: id,
    email: `${id}@example.test`,
    role: "MEMBER" as const,
    ageTier: "ADULT" as const,
  }));

  return {
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        members.filter((member) => args.where.id.in.includes(member.id)),
      ),
    },
    seasonalMembershipAssignment: {
      findMany: vi.fn(async (args: { where: { memberId: { in: string[] } } }) =>
        options.members
          .filter((id) => args.where.memberId.in.includes(id))
          .map((memberId) => ({
            memberId,
            seasonYear: 2026,
            membershipType: assignedType,
          })),
      ),
    },
    membershipType: {
      findMany: vi.fn(async (args: { where: { key: { in: string[] } } }) =>
        [nonMemberType, fullType, lifeType].filter((type) =>
          args.where.key.in.includes(type.key),
        ),
      ),
    },
    memberSubscription: {
      findMany: vi.fn(async (args: { where: { memberId: { in: string[] } } }) =>
        options.subscriptions.filter((sub) =>
          args.where.memberId.in.includes(sub.memberId),
        ),
      ),
      findFirst: vi.fn(async () => null),
    },
  };
}

/** One paid-up member, one member whose required subscription is unpaid. */
function twoMemberDb() {
  return makeDb({
    members: ["m-paid", "m-unpaid"],
    subscriptions: [{ memberId: "m-paid", status: "PAID" }],
  });
}

const guests = [
  { ageTier: "ADULT" as const, isMember: true, memberId: "m-paid" },
  { ageTier: "ADULT" as const, isMember: true, memberId: "m-unpaid" },
];

const CHECK_IN = new Date("2026-05-01T00:00:00.000Z");
/** Two nights, so a per-night error cannot hide behind a one-night total. */
const CHECK_OUT = new Date("2026-05-03T00:00:00.000Z");
const NIGHTS = 2;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requiresPaidSubscriptionForBooking.mockResolvedValue(true);
});

describe("resolveGuestRateMembershipTypes — the #2543 reprice", () => {
  it("NON_MEMBER_PRICING forces the unpaid member onto the NON_MEMBER type", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    const rated = await resolveGuestRateMembershipTypes(twoMemberDb(), {
      seasonYear: 2026,
      guests,
    });

    expect(rated[0]).toMatchObject({
      memberId: "m-paid",
      rateSource: "OWN_TYPE",
      rateMembershipTypeId: "type-full",
    });
    // The SAME rateSource and the SAME built-in type any other non-member gets,
    // so the existing non-member Xero item code is reused verbatim.
    expect(rated[1]).toMatchObject({
      memberId: "m-unpaid",
      rateSource: "TYPE_POLICY_FORCED",
      rateMembershipTypeId: "type-nonmember",
    });
  });

  it.each(["HARD_BLOCK", "NO_BLOCK"] as const)(
    "%s leaves pricing byte-identical to pre-#2543",
    async (mode) => {
      mocks.peekSubscriptionLockoutMode.mockResolvedValue(mode);
      const db = twoMemberDb();

      const rated = await resolveGuestRateMembershipTypes(db, {
        seasonYear: 2026,
        guests,
      });

      expect(rated.map((guest) => guest.rateMembershipTypeId)).toEqual([
        "type-full",
        "type-full",
      ]);
      expect(rated.map((guest) => guest.rateSource)).toEqual([
        "OWN_TYPE",
        "OWN_TYPE",
      ]);
      // Not merely the same answer — no subscription read happened at all.
      expect(db.memberSubscription.findMany).not.toHaveBeenCalled();
    },
  );

  it("the reprice overrides the member's own MEMBER_RATE type", async () => {
    // Placed before the type is consulted, deliberately: a member whose type says
    // MEMBER_RATE is exactly the member this rule is about, so reading the type
    // first would leave the rule with no effect on anyone.
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    const rated = await resolveGuestRateMembershipTypes(twoMemberDb(), {
      seasonYear: 2026,
      guests: [guests[1]],
    });

    expect(rated[0].rateMembershipTypeId).toBe("type-nonmember");
  });

  it("a NOT_REQUIRED season row does NOT rescue a REQUIRED membership type (#2041)", async () => {
    // The reprice follows the shared settlement rule rather than re-deriving it:
    // #2041 scopes NOT_REQUIRED-row dominance to BASED_ON_AGE_TIER types, so on a
    // REQUIRED type the row does not dominate and the member is still repriced.
    // This case pins that boundary, because it is the one an author would be
    // tempted to "simplify" into "any NOT_REQUIRED row means exempt".
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    const rated = await resolveGuestRateMembershipTypes(
      makeDb({
        members: ["m-req"],
        subscriptions: [{ memberId: "m-req", status: "NOT_REQUIRED" }],
      }),
      {
        seasonYear: 2026,
        guests: [
          { ageTier: "ADULT" as const, isMember: true, memberId: "m-req" },
        ],
      },
    );

    expect(rated[0].rateSource).toBe("TYPE_POLICY_FORCED");
  });

  it("does NOT reprice a member whose type never owes a subscription", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    // A LIFE member: member rates, and no subscription is ever required of them.
    // They have no subscription row at all, and must keep member rates.
    const rated = await resolveGuestRateMembershipTypes(
      makeDb({ members: ["m-life"], subscriptions: [], type: lifeType }),
      {
        seasonYear: 2026,
        guests: [
          { ageTier: "ADULT" as const, isMember: true, memberId: "m-life" },
        ],
      },
    );

    expect(rated[0]).toMatchObject({
      rateSource: "OWN_TYPE",
      rateMembershipTypeId: "type-life",
    });
  });

  it("never asks about a row whose isMember snapshot is false", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
    const db = makeDb({ members: [], subscriptions: [] });

    const rated = await resolveGuestRateMembershipTypes(db, {
      seasonYear: 2026,
      guests: [{ ageTier: "ADULT" as const, isMember: false, memberId: null }],
    });

    expect(rated[0]).toMatchObject({ rateSource: "NON_MEMBER_DEFAULT" });
    expect(db.memberSubscription.findMany).not.toHaveBeenCalled();
  });
});

describe("the price in cents (#2543)", () => {
  it("charges the unpaid member the non-member rate, per night, in integer cents", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    const price = await priceBookingGuestsWithMembershipTypePolicy(
      twoMemberDb(),
      {
        ownerMemberId: "m-paid",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests,
        seasons: seasonRates,
        seasonYear: 2026,
      },
    );

    const expected =
      NIGHTS * MEMBER_RATE_CENTS + NIGHTS * NON_MEMBER_RATE_CENTS;
    expect(price.totalPriceCents).toBe(expected);
    expect(price.totalPriceCents).toBe(6800);
    expect(Number.isInteger(price.totalPriceCents)).toBe(true);
  });

  it.each(["HARD_BLOCK", "NO_BLOCK"] as const)(
    "%s charges both members the member rate, exactly as before #2543",
    async (mode) => {
      mocks.peekSubscriptionLockoutMode.mockResolvedValue(mode);

      const price = await priceBookingGuestsWithMembershipTypePolicy(
        twoMemberDb(),
        {
          ownerMemberId: "m-paid",
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          guests,
          seasons: seasonRates,
          seasonYear: 2026,
        },
      );

      expect(price.totalPriceCents).toBe(2 * NIGHTS * MEMBER_RATE_CENTS);
      expect(price.totalPriceCents).toBe(4000);
    },
  );

  it("the reprice is the whole difference: 1400 cents per night, nothing else", async () => {
    // Guards against the reprice quietly changing anything OTHER than which rate
    // row is read — a second, parallel money computation is exactly the drift
    // #2543 removes.
    const args = {
      ownerMemberId: "m-paid",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guests,
      seasons: seasonRates,
      seasonYear: 2026,
    };

    mocks.peekSubscriptionLockoutMode.mockResolvedValue("HARD_BLOCK");
    const before = await priceBookingGuestsWithMembershipTypePolicy(
      twoMemberDb(),
      args,
    );

    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
    const after = await priceBookingGuestsWithMembershipTypePolicy(
      twoMemberDb(),
      args,
    );

    expect(after.totalPriceCents - before.totalPriceCents).toBe(
      NIGHTS * (NON_MEMBER_RATE_CENTS - MEMBER_RATE_CENTS),
    );
    expect(after.totalPriceCents - before.totalPriceCents).toBe(2800);
  });
});
