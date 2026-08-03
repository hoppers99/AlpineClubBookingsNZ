import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

/*
  #2563 — THE PREVIEW AND THE SAVE RESOLVE ONE PARTY.

  `POST /api/bookings/[id]/modify-quote` used to assemble its own stay-range
  resolution: private `hasStayRangeInput` / `hasStayRangeValue` / `minDate` /
  `maxDate`, its own envelope-expansion loop, its own per-guest pass. #2526 had
  already extracted the canonical resolution to
  `resolveModificationStayRanges` and routed `resolveTargetDates` and
  `prepareGuestPlan` through it, but the preview kept its copy, held in step by
  inspection. That copy is now GONE (owner decision, Option 1, 3 Aug 2026): the
  preview makes the same two resolver calls the apply path makes.

  This suite is the gate that keeps it that way. It is not a unit test of the
  resolver (`booking-modification-stay-ranges.test.ts` owns that) and not a
  source-shape assertion (`review-findings-contracts.test.ts` owns the "no local
  copy" claim). It drives THREE REAL SURFACES over the SAME delta —

    1. the modify-quote route (the preview the member reads),
    2. `resolveTargetDates` -> `prepareGuestPlan` (the party the save WRITES),
    3. `buildModificationProposalParties` (the party an officer REVIEWS),

  — and requires them to agree on the envelope, on every guest's nights, on the
  capacity input, on the adult-supervision input, on the refusal message
  (including its member-facing "Guest N" number) and on the quoted cents.

  Pricing is a deterministic fake (a flat night rate, with a guest's stored
  per-night price honoured as a #1036 lock) applied by the SAME function to the
  route's party and to the planner's party. That is what makes "identical to the
  cent" a real claim rather than a mocked constant: the cents are a pure function
  of the resolved party, so any drift in the resolution moves them. The
  `naive per-guest rule` control at the end of the first suite proves the
  comparison has teeth — the pre-#2526 rule prices the same delta differently.
*/

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingGuestCreate: vi.fn(),
  bookingGuestUpdate: vi.fn(),
  bookingGuestDeleteMany: vi.fn(),
  transaction: vi.fn(),
  seasonFindMany: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  bookingRequestFindFirst: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  findConflicts: vi.fn(),
  assertNoConflicts: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  getLodgeCapacity: vi.fn(),
  priceGuests: vi.fn(),
  calculateChangeFee: vi.fn(),
  loadModuleFlags: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
  validateMinimumStay: vi.fn(),
  findUnpaidMemberGuestNames: vi.fn(),
  resolveLinkedBookingMembersWithBoundary: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
// Every WRITE the route's Prisma client could reach is a spy that fails the test
// if it is ever called: the owner's "a quote request produces no writes or side
// effects" requirement is asserted, not assumed (see the zero-write suite).
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: h.bookingFindUnique,
      findMany: h.bookingFindMany,
      update: h.bookingUpdate,
    },
    bookingGuest: {
      create: h.bookingGuestCreate,
      update: h.bookingGuestUpdate,
      deleteMany: h.bookingGuestDeleteMany,
    },
    season: { findMany: h.seasonFindMany },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    bookingRequest: { findFirst: h.bookingRequestFindFirst },
    $transaction: h.transaction,
  },
}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return { ...actual, checkCapacityForGuestRanges: h.checkCapacityForGuestRanges };
});
// Both halves: the route reads conflicts, `prepareGuestPlan` asserts them.
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: h.findConflicts,
  assertNoBookingMemberNightConflicts: h.assertNoConflicts,
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({
    code: "BOOKING_MEMBER_NIGHT_CONFLICT",
    conflicts,
  }),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
// Partial: the REAL `@/lib/booking-modify` barrel pulls the email templates in,
// which read `FALLBACK_LODGE_CAPACITY` from this module at import time.
vi.mock("@/lib/lodge-capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lodge-capacity")>();
  return { ...actual, getLodgeCapacity: h.getLodgeCapacity };
});
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  // A pass-through so the party that reaches pricing and capacity is exactly the
  // party the resolution produced — nothing is re-derived on the way.
  resolveGuestRateMembershipTypes: vi
    .fn()
    .mockImplementation(
      (_db: unknown, { guests }: { guests: Array<Record<string, unknown>> }) =>
        Promise.resolve(
          guests.map((g) => ({
            ...g,
            rateMembershipTypeId: "type-nonmember",
            rateSource: "NON_MEMBER_DEFAULT",
          })),
        ),
    ),
  priceBookingGuestsWithMembershipTypePolicy: h.priceGuests,
  MembershipTypeBookingPolicyError: class extends Error {},
  getMembershipTypeBookingPolicyErrorBody: (e: Error) => ({ error: e.message }),
}));
// The REAL barrel, so `resolveGuestMemberLinks`, `resolveGuestNameUpdates` and
// `lockedNightPricesForGuest` behave identically on both sides of the
// comparison. Only the settlement read (a Xero/payment surface irrelevant to
// stay ranges) is stubbed.
vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-modify")>();
  return {
    ...actual,
    calculateModificationSettlementOptions: vi.fn().mockResolvedValue(null),
  };
});
// Partial: `normalizeBookingGuestInputs` stays REAL because the parity claim for
// added guests rests on it preserving input order and length.
vi.mock("@/lib/booking-guests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-guests")>();
  return {
    ...actual,
    resolveLinkedBookingMembersWithBoundary:
      h.resolveLinkedBookingMembersWithBoundary,
    assertLinkedBookingMembersCanBeBooked: h.assertLinkedBookingMembersCanBeBooked,
  };
});
vi.mock("@/lib/booking-member-guest-subscriptions", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/booking-member-guest-subscriptions")
  >();
  return { ...actual, findUnpaidMemberGuestNames: h.findUnpaidMemberGuestNames };
});
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  daysUntilDate: vi.fn().mockReturnValue(30),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: h.calculateChangeFee }));
vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();
  return { ...actual, loadEffectiveModuleFlags: h.loadModuleFlags };
});
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: h.isXeroConnected }));
vi.mock("@/lib/xero-organisation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-organisation")>();
  return { ...actual, getXeroLockDates: h.getXeroLockDates };
});
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
  formatViolationsDetail: (violations: unknown[]) =>
    `minimum-stay violations: ${violations.length}`,
  formatViolationMessage: () => "minimum-stay violation",
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/modify-quote/route";
import { prepareGuestPlan } from "@/lib/booking-modify-plan";
import { resolveTargetDates } from "@/lib/booking-modify-validation";
import { buildModificationProposalParties } from "@/lib/booking-exception-request-service";
import { requiresAdultSupervisionReview } from "@/lib/booking-review";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";

const D = (s: string) => parseDateOnly(s);
const NOW = new Date("2026-08-10T06:00:00.000Z");
const params = Promise.resolve({ id: "b1" });

/** The flat season rate the deterministic pricer charges for an unlocked night. */
const NIGHT_CENTS = 5_000;
/** The stored per-night price on the fixture's booked nights (a #1036 lock). */
const BOOKED_NIGHT_CENTS = 4_200;

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function nightsBetween(start: Date, end: Date): string[] {
  return eachDateOnlyInRange(start, end).map(formatDateOnly);
}

/** A live `BookingGuest` row as the route, the planner and the freeze all read it. */
function liveGuest(
  id: string,
  firstName: string,
  start: string,
  end: string,
  nights?: string[],
) {
  return {
    id,
    firstName,
    lastName: "Guest",
    ageTier: "ADULT",
    isMember: false,
    memberId: null,
    consentStatus: null,
    stayStart: D(start),
    stayEnd: D(end),
    priceCents:
      (nights ?? nightsBetween(D(start), D(end))).length * BOOKED_NIGHT_CENTS,
    nights: (nights ?? nightsBetween(D(start), D(end))).map((night) => ({
      stayDate: D(night),
      priceCents: BOOKED_NIGHT_CENTS,
    })),
  };
}

const DEFAULT_GUESTS = [
  liveGuest("g1", "Ann", "2026-09-01", "2026-09-04"),
  liveGuest("g2", "Bob", "2026-09-01", "2026-09-04"),
  liveGuest("g3", "Cal", "2026-09-01", "2026-09-04"),
];

function bookingWith(guests: ReturnType<typeof liveGuest>[]) {
  const totalPriceCents = guests.reduce((sum, g) => sum + g.priceCents, 0);
  return {
    id: "b1",
    status: "CONFIRMED",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D("2026-09-01"),
    checkOut: D("2026-09-04"),
    wholeLodgeHold: false,
    requiresAdminReview: false,
    adminReviewStatus: null,
    memberReviewJustification: null,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    totalPriceCents,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: totalPriceCents,
    payment: null,
    promoRedemption: null,
    guests,
  };
}

/**
 * The one pricing function, applied to whichever party it is handed.
 *
 * Deliberately a pure function of the RESOLVED party: a guest's nights are their
 * explicit night set when they have one (#713) and their envelope otherwise, and
 * a night the guest already bought keeps its stored price (#1036). Two parties
 * that resolve identically therefore cost the same to the cent, and two that do
 * not cannot.
 */
type PricedGuest = {
  stayStart: Date;
  stayEnd: Date;
  nights?: ReadonlyArray<Date> | null;
  lockedNightPrices?: ReadonlyArray<{ stayDate: Date; priceCents: number }>;
};

function priceParty(guests: ReadonlyArray<PricedGuest>) {
  const perGuest = guests.map((guest) => {
    const nights =
      guest.nights && guest.nights.length > 0
        ? [...new Set(guest.nights.map(formatDateOnly))].sort()
        : nightsBetween(guest.stayStart, guest.stayEnd);
    const locked = new Map(
      (guest.lockedNightPrices ?? []).map((lock) => [
        formatDateOnly(lock.stayDate),
        lock.priceCents,
      ]),
    );
    const perNightCents = nights.map((night) => locked.get(night) ?? NIGHT_CENTS);
    return {
      priceCents: perNightCents.reduce((sum, cents) => sum + cents, 0),
      perNightCents,
      nightDates: nights.map(D),
    };
  });
  return {
    totalPriceCents: perGuest.reduce((sum, g) => sum + g.priceCents, 0),
    guests: perGuest,
  };
}

/**
 * The comparable shape of a proposed party: who is on the booking, on exactly
 * which nights, at which identity. Every field the pricing, capacity, hosting
 * and policy passes read from a resolved guest.
 */
function partyShape(
  guests: ReadonlyArray<{
    bookingGuestId?: string | null;
    ageTier: string;
    isMember: boolean;
    memberId?: string | null;
    stayStart: Date;
    stayEnd: Date;
    nights?: ReadonlyArray<Date> | null;
  }>,
) {
  return guests.map((guest) => ({
    bookingGuestId: guest.bookingGuestId ?? null,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? null,
    stayStart: formatDateOnly(guest.stayStart),
    stayEnd: formatDateOnly(guest.stayEnd),
    nights:
      guest.nights && guest.nights.length > 0
        ? [...new Set(guest.nights.map(formatDateOnly))].sort()
        : null,
  }));
}

/** The nights each guest occupies, by guest name — the officer-facing view. */
function nightsByName(
  guests: ReadonlyArray<{
    name: string;
    stayStart: Date;
    stayEnd: Date;
    nights?: ReadonlyArray<Date> | null;
  }>,
) {
  return Object.fromEntries(
    guests.map((guest) => [
      guest.name,
      guest.nights && guest.nights.length > 0
        ? [...new Set(guest.nights.map(formatDateOnly))].sort()
        : nightsBetween(guest.stayStart, guest.stayEnd),
    ]),
  );
}

// ---------------------------------------------------------------------------
// The three surfaces
// ---------------------------------------------------------------------------

type CapturedRouteRun = {
  status: number;
  body: Record<string, unknown>;
  envelope: [string, string] | null;
  party: ReturnType<typeof partyShape> | null;
  pricedParty: ReadonlyArray<PricedGuest> | null;
  capacityRange: [string, string] | null;
  minimumStayRange: [string, string] | null;
};

/** Drive the REAL preview route as the booking's own member. */
async function runRoute(
  delta: Record<string, unknown>,
  guests = DEFAULT_GUESTS,
): Promise<CapturedRouteRun> {
  h.bookingFindUnique.mockResolvedValue(bookingWith(guests));
  const res = await POST(req(delta), { params });
  const body = (await res.json()) as Record<string, unknown>;

  const priceCall = h.priceGuests.mock.calls.find((call) => {
    const arg = call[1] as { guests?: Array<{ bookingGuestId?: string | null }> };
    // The MAIN pricing pass is the one over the whole proposed party (it carries
    // `bookingGuestId`); the itemisation passes price sub-slices without it.
    return arg?.guests?.some((g) => g.bookingGuestId !== undefined) ?? false;
  });
  const capacityCall = h.checkCapacityForGuestRanges.mock.calls[0];
  const minStayCall = h.validateMinimumStay.mock.calls[0];

  return {
    status: res.status,
    body,
    envelope: priceCall
      ? [
          formatDateOnly((priceCall[1] as { checkIn: Date }).checkIn),
          formatDateOnly((priceCall[1] as { checkOut: Date }).checkOut),
        ]
      : null,
    party: priceCall
      ? partyShape((priceCall[1] as { guests: Parameters<typeof partyShape>[0] }).guests)
      : null,
    pricedParty: priceCall
      ? (priceCall[1] as { guests: ReadonlyArray<PricedGuest> }).guests
      : null,
    capacityRange: capacityCall
      ? [
          formatDateOnly(capacityCall[1] as Date),
          formatDateOnly(capacityCall[2] as Date),
        ]
      : null,
    minimumStayRange: minStayCall
      ? [
          formatDateOnly(minStayCall[0] as Date),
          formatDateOnly(minStayCall[1] as Date),
        ]
      : null,
  };
}

/** Drive the REAL apply-path planner over the same delta, as the same member. */
async function runPlanner(
  delta: Record<string, unknown>,
  guests = DEFAULT_GUESTS,
) {
  const booking = bookingWith(guests) as never;
  const input = delta as never;
  const dates = resolveTargetDates({ booking, role: "USER", input });
  const plan = await prepareGuestPlan({} as never, {
    booking,
    role: "USER",
    actorId: "m1",
    input,
    isInProgressEdit: dates.isInProgressEdit,
    editableFrom: dates.editableFrom,
    newCheckIn: dates.newCheckIn,
    newCheckOut: dates.newCheckOut,
    memberGuestPolicy: {
      wideningEnabled: false,
      approvalRequired: true,
      pendingHoldExpiryDays: 0,
    },
    // #2560: the mode the route resolves for this fixture (Xero module off).
    subscriptionLockoutMode: "NO_BLOCK",
  });
  return {
    envelope: [
      formatDateOnly(dates.newCheckIn),
      formatDateOnly(dates.newCheckOut),
    ] as [string, string],
    party: partyShape(plan.guestsForPricing),
    pricedParty: plan.guestsForPricing as unknown as ReadonlyArray<PricedGuest>,
    nightsByName: nightsByName([
      ...plan.proposedRemainingGuests.map((entry) => ({
        name: `${entry.guest.firstName} ${entry.guest.lastName}`,
        stayStart: entry.stayStart,
        stayEnd: entry.stayEnd,
        nights: entry.nights,
      })),
      // `normalizedAddGuests` carries the resolved range on a row whose declared
      // `stayStart`/`nights` are the intersection of the raw payload's strings and
      // the resolved dates (see the field-by-field assignment in
      // `prepareGuestPlan`), so the runtime Dates are narrowed here.
      ...(plan.normalizedAddGuests ?? []).map((guest) => ({
        name: `${guest.firstName} ${guest.lastName}`,
        stayStart: guest.stayStart as Date,
        stayEnd: guest.stayEnd as Date,
        nights: guest.nights as Date[] | undefined,
      })),
    ]),
  };
}

/** Freeze the same delta the way the officer's review card is built. */
function runFreeze(delta: Record<string, unknown>, guests = DEFAULT_GUESTS) {
  const { proposed } = buildModificationProposalParties({
    bookingCheckIn: D("2026-09-01"),
    bookingCheckOut: D("2026-09-04"),
    liveGuests: guests as never,
    delta: delta as never,
  });
  return {
    envelope: [proposed.checkIn, proposed.checkOut] as [string, string],
    nightsByName: Object.fromEntries(
      proposed.guests.map((guest) => [
        `${guest.firstName} ${guest.lastName}`,
        guest.nights,
      ]),
    ),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "m1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("USER");
  h.bookingFindUnique.mockResolvedValue(bookingWith(DEFAULT_GUESTS));
  h.bookingFindMany.mockResolvedValue([]);
  h.seasonFindMany.mockResolvedValue([
    {
      id: "season-1",
      startDate: D("2026-06-01"),
      endDate: D("2026-12-31"),
      membershipTypeRates: [
        {
          membershipTypeId: "type-nonmember",
          ageTier: "ADULT",
          pricePerNightCents: NIGHT_CENTS,
        },
        {
          membershipTypeId: "type-nonmember",
          ageTier: "CHILD",
          pricePerNightCents: NIGHT_CENTS,
        },
      ],
    },
  ]);
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.bookingRequestFindFirst.mockResolvedValue(null);
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.getLodgeCapacity.mockResolvedValue(29);
  h.findConflicts.mockResolvedValue([]);
  h.assertNoConflicts.mockResolvedValue(undefined);
  h.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 10,
    nightDetails: [],
  });
  // The deterministic pricer: the same pure function both sides are compared with.
  h.priceGuests.mockImplementation(
    (_db: unknown, { guests }: { guests: ReadonlyArray<PricedGuest> }) =>
      Promise.resolve(priceParty(guests)),
  );
  h.calculateChangeFee.mockReturnValue({ feeCents: 0 });
  h.loadModuleFlags.mockResolvedValue({ xeroIntegration: false });
  h.isXeroConnected.mockResolvedValue(false);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: null,
    endOfYearLockDate: null,
  });
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  h.findUnpaidMemberGuestNames.mockResolvedValue([]);
  h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  });
  h.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const ADD_ADULT = {
  firstName: "Dee",
  lastName: "Newcomer",
  ageTier: "ADULT" as const,
  isMember: false,
};

/**
 * Every delta shape the owner's decision named, driven end to end through all
 * three surfaces. The name is the case; the delta is the whole input.
 */
const MATRIX: Array<[string, Record<string, unknown>]> = [
  ["changing only the overall booking dates (extend)", { checkOut: "2026-09-06" }],
  ["changing only the overall booking dates (shorten)", { checkOut: "2026-09-03" }],
  [
    "moving the whole booking (both bounds)",
    { checkIn: "2026-09-08", checkOut: "2026-09-11" },
  ],
  [
    "changing only individual guest ranges",
    {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-03" },
      ],
    },
  ],
  [
    "full ranges for ALL guests",
    {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-04" },
        { guestId: "g2", stayStart: "2026-09-02", stayEnd: "2026-09-04" },
        { guestId: "g3", stayStart: "2026-09-01", stayEnd: "2026-09-03" },
      ],
    },
  ],
  [
    "ranges for only SOME guests (unchanged guests mixed with changed ones)",
    {
      guestStayRanges: [
        { guestId: "g2", stayStart: "2026-09-02", stayEnd: "2026-09-03" },
      ],
    },
  ],
  [
    "overall dates AND a partial guestStayRanges — the #2526 divergence",
    {
      checkOut: "2026-09-05",
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-05" },
      ],
    },
  ],
  [
    "guests arriving and departing on different nights",
    {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-02" },
        { guestId: "g2", stayStart: "2026-09-02", stayEnd: "2026-09-03" },
        { guestId: "g3", stayStart: "2026-09-03", stayEnd: "2026-09-04" },
      ],
    },
  ],
  [
    "an explicit non-contiguous night set (#713)",
    {
      guestStayRanges: [
        { guestId: "g1", nights: ["2026-09-01", "2026-09-03"] },
      ],
    },
  ],
  ["adding a guest with no range of their own", { addGuests: [ADD_ADULT] }],
  [
    "adding a guest WITH a range of their own",
    {
      addGuests: [
        { ...ADD_ADULT, stayStart: "2026-09-02", stayEnd: "2026-09-04" },
      ],
    },
  ],
  [
    "adding a guest whose range reaches PAST the booking envelope",
    {
      addGuests: [
        { ...ADD_ADULT, stayStart: "2026-09-01", stayEnd: "2026-09-07" },
      ],
    },
  ],
  ["removing a guest", { removeGuestIds: ["g3"] }],
  [
    "removing a guest while another guest's range changes",
    {
      checkOut: "2026-09-05",
      removeGuestIds: ["g3"],
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-02", stayEnd: "2026-09-05" },
      ],
    },
  ],
  [
    "a guest range OUTSIDE the requested envelope widens it (#713 auto-expand)",
    {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-09" },
      ],
    },
  ],
  [
    "a range on a REMOVED guest switches the mode but never widens the envelope",
    {
      removeGuestIds: ["g3"],
      guestStayRanges: [
        { guestId: "g3", stayStart: "2026-08-25", stayEnd: "2026-09-20" },
      ],
    },
  ],
  [
    "duplicate/conflicting range entries for one guest",
    {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-02" },
        { guestId: "g1", stayStart: "2026-09-02", stayEnd: "2026-09-04" },
      ],
    },
  ],
  [
    "a range entry carrying NO dates at all is not a range input",
    { checkOut: "2026-09-05", guestStayRanges: [{ guestId: "g1" }] },
  ],
  [
    "an unknown guestId in guestStayRanges is ignored by both",
    {
      guestStayRanges: [
        { guestId: "not-on-this-booking", stayStart: "2026-09-01", stayEnd: "2026-09-02" },
      ],
    },
  ],
  [
    "everything at once: dates, a partial range, an add and a remove",
    {
      checkOut: "2026-09-06",
      removeGuestIds: ["g3"],
      guestStayRanges: [
        { guestId: "g2", nights: ["2026-09-01", "2026-09-05"] },
      ],
      addGuests: [
        { ...ADD_ADULT, stayStart: "2026-09-02", stayEnd: "2026-09-06" },
      ],
    },
  ],
];

describe("#2563 the preview, the save and the freeze resolve one party", () => {
  for (const [name, delta] of MATRIX) {
    it(`agrees on envelope, guest nights and cents: ${name}`, async () => {
      const planner = await runPlanner(delta);
      const freeze = runFreeze(delta);
      const route = await runRoute(delta);

      expect(route.status).toBe(200);

      // 1. The same overall booking date range.
      expect(route.envelope).toEqual(planner.envelope);
      expect(freeze.envelope).toEqual(planner.envelope);

      // 2. The same party: every guest's arrival, departure, occupied nights and
      //    identity, in the same order.
      expect(route.party).toEqual(planner.party);
      // 3. ...and the same nights the officer's card shows (order-insensitive:
      //    the frozen party is canonicalised for hashing).
      expect(freeze.nightsByName).toEqual(planner.nightsByName);

      // 4. Identical guest-night allocations feed capacity, over the same range.
      expect(route.capacityRange).toEqual(planner.envelope);

      // 5. Identical pricing to the cent — the same pure pricer over each party.
      expect(priceParty(route.pricedParty!).totalPriceCents).toBe(
        priceParty(planner.pricedParty).totalPriceCents,
      );
      expect(route.body.newTotalPriceCents).toBe(
        priceParty(planner.pricedParty).totalPriceCents,
      );

      // 6. The adult-supervision (child-safety) rule judges the same party. The
      //    preview does not run the rule — the save does — so what has to match
      //    is its INPUT, checked by evaluating the pure predicate on both.
      expect(requiresAdultSupervisionReview(route.party!)).toBe(
        requiresAdultSupervisionReview(planner.party),
      );

      // 7. Minimum stay is judged over the resolved envelope, or not at all when
      //    the envelope did not move (#2363 — the apply path exempts it too).
      const envelopeMoved =
        planner.envelope[0] !== "2026-09-01" || planner.envelope[1] !== "2026-09-04";
      if (envelopeMoved) {
        expect(route.minimumStayRange).toEqual(planner.envelope);
      } else {
        expect(route.minimumStayRange).toBeNull();
      }
    });
  }

  it("the comparison has teeth: the pre-#2526 per-guest rule prices differently", async () => {
    // The control. If the route ever drifted back to "no range entry + the dates
    // moved => reset this guest to the new envelope", the mixed case above would
    // resolve 3 + 4 + 4 guest-nights instead of 4 + 3 + 3, at a different price.
    // This asserts the two answers really are different, so the equalities above
    // are not two implementations agreeing on nothing.
    const delta = {
      checkOut: "2026-09-05",
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-05" },
      ],
    };
    const planner = await runPlanner(delta);

    // What the canonical (global-flag) rule produces: only Ann moved.
    expect(planner.nightsByName).toEqual({
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    });

    // What the abandoned per-guest rule would have produced: everybody reset.
    const naiveParty = DEFAULT_GUESTS.map((guest) =>
      guest.id === "g1"
        ? {
            stayStart: D("2026-09-01"),
            stayEnd: D("2026-09-05"),
            lockedNightPrices: guest.nights,
          }
        : {
            stayStart: D("2026-09-01"),
            stayEnd: D("2026-09-05"),
            lockedNightPrices: guest.nights,
          },
    );
    expect(priceParty(naiveParty).totalPriceCents).not.toBe(
      priceParty(planner.pricedParty).totalPriceCents,
    );
  });
});

describe("#2563 a refused delta is refused identically, with the same guest number", () => {
  const REFUSALS: Array<[string, Record<string, unknown>, string]> = [
    [
      "a half-supplied range on the FIRST remaining guest",
      { guestStayRanges: [{ guestId: "g1", stayStart: "2026-09-02" }] },
      "Guest 1: Date In and Date Out are both required.",
    ],
    [
      "a half-supplied range on the SECOND remaining guest — member-facing numbering",
      { guestStayRanges: [{ guestId: "g2", stayEnd: "2026-09-03" }] },
      "Guest 2: Date In and Date Out are both required.",
    ],
    [
      "a half-supplied range on the THIRD remaining guest",
      { guestStayRanges: [{ guestId: "g3", stayStart: "2026-09-02" }] },
      "Guest 3: Date In and Date Out are both required.",
    ],
    [
      "an inverted range",
      {
        guestStayRanges: [
          { guestId: "g2", stayStart: "2026-09-03", stayEnd: "2026-09-02" },
        ],
      },
      "Guest 2: Date Out must be after Date In.",
    ],
    [
      "a zero-width range",
      {
        guestStayRanges: [
          { guestId: "g1", stayStart: "2026-09-02", stayEnd: "2026-09-02" },
        ],
      },
      "Guest 1: Date Out must be after Date In.",
    ],
    [
      "a malformed date",
      {
        guestStayRanges: [
          { guestId: "g1", stayStart: "01/09/2026", stayEnd: "2026-09-03" },
        ],
      },
      "Guest 1 Date In must use yyyy-mm-dd format.",
    ],
    [
      "a malformed night in an explicit night set",
      { guestStayRanges: [{ guestId: "g3", nights: ["not-a-date"] }] },
      "Guest 3 night 1 must use yyyy-mm-dd format.",
    ],
    [
      "an ADDED guest's own bad range — numbered AFTER the remaining guests",
      {
        addGuests: [{ ...ADD_ADULT, stayStart: "2026-09-02" }],
      },
      "Guest 4: Date In and Date Out are both required.",
    ],
    [
      "an added guest's bad range with a guest removed — the number follows who is left",
      {
        removeGuestIds: ["g2"],
        addGuests: [{ ...ADD_ADULT, stayEnd: "2026-09-02" }],
      },
      "Guest 3: Date In and Date Out are both required.",
    ],
  ];

  for (const [name, delta, message] of REFUSALS) {
    it(`refuses with the same 400 and the same wording: ${name}`, async () => {
      const route = await runRoute(delta);
      expect(route.status).toBe(400);
      expect(route.body.error).toBe(message);

      // The apply path refuses the same delta with the same words, as an
      // `ApiError` 400 — the structured code stays on the error, the presentation
      // (a JSON body) is applied at the route boundary.
      await expect(runPlanner(delta)).rejects.toMatchObject({
        message,
        status: 400,
      });

      // And the freeze refuses it too, rather than freezing a proposal the
      // canonical service could never execute.
      expect(() => runFreeze(delta)).toThrow(message);
    });
  }

  it("prices nothing and checks no capacity once a range is refused", async () => {
    const route = await runRoute({
      guestStayRanges: [{ guestId: "g1", stayStart: "2026-09-02" }],
    });
    expect(route.status).toBe(400);
    expect(h.priceGuests).not.toHaveBeenCalled();
    expect(h.checkCapacityForGuestRanges).not.toHaveBeenCalled();
  });
});

/*
  The behavioural matrix above passes against the PRE-#2563 route as well — which
  is exactly the point (the substitution is behaviour-preserving to the cent), and
  exactly why it cannot be the whole gate. "Exactly ONE implementation of the
  modification stay-range resolution remains in the repository" is a claim about a
  set of files, not about an output, so it is read off the source. The owner's
  decision refused the alternative outright: two implementations kept in step by
  parity tests is the arrangement that shipped the #2526 bug.
*/
const ROUTE_FILE = "src/app/api/bookings/[id]/modify-quote/route.ts";
const RESOLVER_FILE = "src/lib/booking-modification-stay-ranges.ts";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/** Every non-test source file under `src/` that names `identifier`. */
function sourceFilesNaming(identifier: string): string[] {
  const root = path.resolve(process.cwd(), "src");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      if (readFileSync(full, "utf8").includes(identifier)) {
        found.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

describe("#2563 exactly one stay-range resolution exists, and the route calls it", () => {
  it("the quote route declares none of the private helpers it used to own", () => {
    const source = readRepoFile(ROUTE_FILE);
    // The four helpers named in the issue, as DECLARATIONS. Matching the bare
    // name would hit the docblock that explains why they are gone.
    for (const helper of [
      "hasStayRangeValue",
      "hasStayRangeInput",
      "minDate",
      "maxDate",
    ]) {
      expect(source, helper).not.toContain(`function ${helper}(`);
    }
    // ...and no local re-derivation of the envelope or of a guest's range. (The
    // `proposedRanges` NAME survives elsewhere on this route as the partner-shared
    // capacity argument — what must not survive is the loop that BUILT one.)
    expect(source).not.toContain("normalizeGuestStayRanges");
    expect(source).not.toContain("normalizeGuestStayRange(");
    expect(source).not.toContain("const proposedRanges");
  });

  it("the quote route resolves ranges by calling the shared resolver, twice", () => {
    const source = readRepoFile(ROUTE_FILE);
    expect(source).toContain(
      `from "@/lib/booking-modification-stay-ranges"`,
    );
    // The two passes the apply path makes: the envelope pass (mirroring
    // `resolveTargetDates`) and the per-guest pass (mirroring `prepareGuestPlan`).
    expect(source.match(/resolveStayRangesForPreview\(\{/g)).toHaveLength(2);
    // Reached through the route's single error-mapping adapter, nowhere else.
    expect(source.match(/resolveModificationStayRanges\(/g)).toHaveLength(1);
  });

  it("the resolver's rules live in one file, with only known callers", () => {
    // If a new surface starts resolving modification stay ranges, this list is
    // where it has to be declared — the point being that it is a decision, not a
    // copy that drifts.
    expect(sourceFilesNaming("resolveModificationStayRanges")).toEqual([
      ROUTE_FILE,
      "src/lib/booking-exception-request-service.ts",
      RESOLVER_FILE,
      "src/lib/booking-modify-validation.ts",
    ]);
    // The GLOBAL range-input predicate is CALLED only by the resolution it
    // switches (other files name it in prose, which is the pointer working).
    expect(sourceFilesNaming("deltaHasStayRangeInputs(")).toEqual([RESOLVER_FILE]);
    // The modification envelope's own expansion — the union of the stored and
    // requested bounds — is built in exactly one place. (`minDate`/`maxDate` are
    // generic date helpers several unrelated modules declare for themselves; what
    // must not exist twice is THIS envelope.)
    expect(sourceFilesNaming("const unionEnvelope")).toEqual([RESOLVER_FILE]);
  });

  it("the route boundary maps the resolver's error without restating the rule", () => {
    const source = readRepoFile(ROUTE_FILE);
    // The adapter catches exactly the resolver's structured error type and turns
    // it into this route's presentation (a 400 JSON body), carrying the resolver's
    // own message so preview and save refuse in the same words.
    expect(source).toContain("error instanceof BookingGuestStayRangeValidationError");
    expect(source).toContain("{ error: error.message }");
  });
});

describe("#2563 the preview stays a preview", () => {
  it("writes nothing for any delta in the matrix", async () => {
    for (const [, delta] of MATRIX) {
      const route = await runRoute(delta);
      expect(route.status).toBe(200);
    }
    // Not one write, and not one transaction, across the whole matrix.
    expect(h.bookingUpdate).not.toHaveBeenCalled();
    expect(h.bookingGuestCreate).not.toHaveBeenCalled();
    expect(h.bookingGuestUpdate).not.toHaveBeenCalled();
    expect(h.bookingGuestDeleteMany).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("writes nothing for a refused delta either", async () => {
    const route = await runRoute({
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-05", stayEnd: "2026-09-02" },
      ],
    });
    expect(route.status).toBe(400);
    expect(h.bookingUpdate).not.toHaveBeenCalled();
    expect(h.bookingGuestUpdate).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
