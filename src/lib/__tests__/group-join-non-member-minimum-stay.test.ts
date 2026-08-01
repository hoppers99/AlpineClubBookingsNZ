import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
} from "@prisma/client";

// #2363. The member join path (joinGroupBookingAsMember) has enforced minimum
// stay since the foundation landed; the PUBLIC non-member join skipped it at
// both of its stages. These tests pin the two-stage rule:
//
//   Stage 1 (createNonMemberJoinRequest) refuses BEFORE a verification token is
//   issued, a GroupBookingJoin row is written, or an email is sent.
//   Stage 2 (verifyAndCreateNonMemberJoin) re-reads the CURRENT policy set and
//   fails closed when it tightened during the link's 48-hour life, returning a
//   dedicated outcome rather than throwing (a throw would become a generic 500
//   at the verify route).
//
// Mock rig mirrors group-join-lodge-capacity.test.ts.

const mocks = vi.hoisted(() => ({
  groupFindUnique: vi.fn(),
  joinFindUnique: vi.fn(),
  joinCreate: vi.fn(),
  memberFindFirst: vi.fn(),
  transaction: vi.fn(),
  seasonFindMany: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  getLodgeCapacity: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  validateMinimumStay: vi.fn(),
  formatViolationsDetail: vi.fn(),
  loggerWarn: vi.fn(),
  sendGroupBookingJoinVerificationEmail: vi.fn(),
  sendBookingRequestApprovedEmail: vi.fn(),
  issueActionToken: vi.fn(),
  hashActionToken: vi.fn(),
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
}));

/** Proves how far a verify got: the first step AFTER the minimum-stay guard. */
const PRICING_SENTINEL = new Error("reached-the-pricing-step");

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: { findUnique: mocks.groupFindUnique },
    groupBookingJoin: {
      findUnique: mocks.joinFindUnique,
      create: mocks.joinCreate,
    },
    member: { findFirst: mocks.memberFindFirst },
    season: { findMany: mocks.seasonFindMany },
    groupDiscountSetting: { findUnique: mocks.groupDiscountFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/lodge-capacity", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lodge-capacity")>(
    "@/lib/lodge-capacity"
  );
  return { ...actual, getLodgeCapacity: mocks.getLodgeCapacity };
});

vi.mock("@/lib/lodges", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lodges")>(
    "@/lib/lodges"
  );
  return { ...actual, getDefaultLodgeId: mocks.getDefaultLodgeId };
});

vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: mocks.validateMinimumStay,
  formatViolationsDetail: mocks.formatViolationsDetail,
}));

vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn(),
  requiresPaidSubscriptionForMemberForBooking: vi.fn(),
  priceBookingGuestsWithMembershipTypePolicy:
    mocks.priceBookingGuestsWithMembershipTypePolicy,
}));

vi.mock("@/lib/email", () => ({
  sendGroupBookingJoinVerificationEmail:
    mocks.sendGroupBookingJoinVerificationEmail,
  sendBookingRequestApprovedEmail: mocks.sendBookingRequestApprovedEmail,
}));

vi.mock("@/lib/action-tokens", async () => {
  const actual = await vi.importActual<typeof import("@/lib/action-tokens")>(
    "@/lib/action-tokens"
  );
  return {
    ...actual,
    issueActionToken: mocks.issueActionToken,
    hashActionToken: mocks.hashActionToken,
  };
});

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: mocks.loggerWarn, info: vi.fn() },
}));

import {
  createNonMemberJoinRequest,
  verifyAndCreateNonMemberJoin,
} from "@/lib/group-booking";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import { PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE } from "@/lib/policies/minimum-stay";

/** A correctly-formatted (64 hex char) action token for the verify path. */
const VALID_TOKEN = "a".repeat(64);

/** Byte-for-byte the shape `formatViolationsDetail` really produces. */
const DETAILED_MINIMUM_STAY_SENTENCE =
  "Bookings including a Saturday night require a minimum stay of 3 nights " +
  "(Lodge B weekends). Your booking is 2 nights.";

const LODGE_B = "lodge-b";

// Relative to the real clock: the ended-stay gate (#1723 path 3) refuses joins
// once the organiser's check-out reaches NZ today, so fixed calendar dates
// would rot into the wrong refusal.
const checkIn = addDaysDateOnly(getTodayDateOnly(), 30);
const checkOut = addDaysDateOnly(getTodayDateOnly(), 31);

const violation = {
  reasonCode: "MINIMUM_STAY",
  policyId: "policy-lodge-b",
  policyVersion: 4,
  policyName: "Lodge B weekends",
  resolvedScope: {
    kind: "LODGE",
    lodgeId: LODGE_B,
    effectiveLodgeId: LODGE_B,
  },
  affectedNights: [formatDateOnly(checkIn)],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "Lodge B requires two nights.",
  triggerDay: "Friday",
  minimumNights: 2,
  actualNights: 1,
  requirements: {
    kind: "MINIMUM_STAY",
    minimumNights: 2,
    actualNights: 1,
    triggerDays: [5],
  },
} as const;

function activeGroup() {
  return {
    id: "group-1",
    status: GroupBookingStatus.OPEN,
    joinDeadline: null,
    paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
    maxJoiners: null,
    organiserMemberId: "organiser-1",
    organiserBooking: {
      id: "booking-1",
      lodgeId: LODGE_B,
      checkIn,
      checkOut,
      status: BookingStatus.CONFIRMED,
      deletedAt: null,
    },
  };
}

function stagedJoinRow() {
  return {
    id: "join-1",
    isMember: false,
    bookingId: null,
    verifiedAt: null,
    verificationTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    contactFirstName: "Sam",
    contactLastName: "Guest",
    contactEmail: "sam@example.com",
    contactPhone: null,
    guestsSnapshot: [{ firstName: "Sam", lastName: "Guest", ageTier: "ADULT" }],
    groupBooking: {
      status: GroupBookingStatus.OPEN,
      joinDeadline: null,
      paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      organiserBooking: {
        id: "booking-1",
        checkIn,
        checkOut,
        status: BookingStatus.CONFIRMED,
        deletedAt: null,
        lodgeId: LODGE_B,
      },
    },
  };
}

const stageOneInput = {
  code: "ABCD2345",
  contactFirstName: "Sam",
  contactLastName: "Guest",
  contactEmail: "sam@example.com",
  guests: [{ firstName: "Sam", lastName: "Guest", ageTier: "ADULT" as const }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLodgeCapacity.mockResolvedValue(10);
  mocks.getDefaultLodgeId.mockResolvedValue("lodge-default");
  mocks.groupFindUnique.mockResolvedValue(activeGroup());
  mocks.joinFindUnique.mockResolvedValue(stagedJoinRow());
  mocks.memberFindFirst.mockResolvedValue(null);
  mocks.joinCreate.mockResolvedValue({ id: "join-1" });
  mocks.issueActionToken.mockReturnValue({
    token: VALID_TOKEN,
    tokenHash: "hash",
  });
  mocks.hashActionToken.mockReturnValue("hash");
  // A REALISTIC formatter output, not a stylised stub: the point of the #2363
  // fix is that this exact shape — rule name, required nights, trigger weekday
  // — never crosses the wire on a public surface, and a short made-up string
  // cannot prove that.
  mocks.formatViolationsDetail.mockReturnValue(DETAILED_MINIMUM_STAY_SENTENCE);
  mocks.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  mocks.priceBookingGuestsWithMembershipTypePolicy.mockRejectedValue(
    PRICING_SENTINEL,
  );
  // Reaching the booking transaction is a failure for every case here.
  mocks.transaction.mockRejectedValue(new Error("reached-the-transaction"));
});

describe("createNonMemberJoinRequest enforces minimum stay (#2363, stage 1)", () => {
  it("refuses the staging with the group's own lodge and dates evaluated", async () => {
    mocks.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(
      createNonMemberJoinRequest(stageOneInput),
    ).rejects.toMatchObject({
      status: 400,
      code: "MINIMUM_STAY_VIOLATION",
      // `details` never leaves the service on this path — the public staging
      // route serialises `error` and `code` only.
      details: DETAILED_MINIMUM_STAY_SENTENCE,
      violations: [violation],
      exceptionReview: { violations: [violation], capacityMode: "HOLD" },
    });

    expect(mocks.validateMinimumStay).toHaveBeenCalledWith(
      checkIn,
      checkOut,
      LODGE_B,
    );
  });

  it("issues no token, writes no join row, and sends no email when it refuses", async () => {
    mocks.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(createNonMemberJoinRequest(stageOneInput)).rejects.toThrow();

    expect(mocks.issueActionToken).not.toHaveBeenCalled();
    expect(mocks.joinCreate).not.toHaveBeenCalled();
    expect(
      mocks.sendGroupBookingJoinVerificationEmail,
    ).not.toHaveBeenCalled();
  });

  it("tells the non-member to contact the organiser — they cannot move the dates", async () => {
    mocks.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const error = await createNonMemberJoinRequest(stageOneInput).then(
      () => null,
      (err: unknown) => err,
    );

    expect((error as Error).message).toContain("contact the organiser");
  });

  it("stages the request as usual when the stay satisfies the policy", async () => {
    await expect(
      createNonMemberJoinRequest(stageOneInput),
    ).resolves.toMatchObject({ id: "join-1" });

    expect(mocks.joinCreate).toHaveBeenCalledTimes(1);
    expect(mocks.sendGroupBookingJoinVerificationEmail).toHaveBeenCalledTimes(1);
  });
});

describe("verifyAndCreateNonMemberJoin re-validates minimum stay (#2363, stage 2)", () => {
  it("fails closed when a policy that did not apply at staging applies now", async () => {
    // Stage 1 passed under the policy set of the day...
    await expect(
      createNonMemberJoinRequest(stageOneInput),
    ).resolves.toMatchObject({ id: "join-1" });
    expect(mocks.joinCreate).toHaveBeenCalledTimes(1);

    // ...an admin then tightens the rules, and the emailed link is opened.
    mocks.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    // The wire message is the SAME generic sentence stage 1 answers with — the
    // detailed sentence naming the rule, its nights and its trigger weekday is
    // for the club's log, not an unauthenticated 409 body. The frozen snapshot
    // still rides the service result for #2365; the route drops it.
    await expect(verifyAndCreateNonMemberJoin(VALID_TOKEN)).resolves.toEqual({
      outcome: "minimum_stay",
      message: PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE,
      violations: [violation],
      exceptionReview: { violations: [violation], capacityMode: "HOLD" },
    });

    // Nothing was created and no claim was spent: no member, no booking, no
    // payment link, and no pay-link email.
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.sendBookingRequestApprovedEmail).not.toHaveBeenCalled();
  });

  it("keeps the detailed sentence in the server log and out of the result", async () => {
    mocks.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await verifyAndCreateNonMemberJoin(VALID_TOKEN);

    // The club gets the detail...
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ detail: DETAILED_MINIMUM_STAY_SENTENCE }),
      expect.stringContaining("minimum-stay policy no longer satisfied"),
    );
    // ...and the sentence the joiner is shown carries none of it.
    expect(
      (result as { message?: string }).message,
    ).not.toContain("Lodge B weekends");
    expect((result as { message?: string }).message).toBe(
      PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE,
    );
  });

  it("evaluates the CURRENT policy set against the organiser's dates at the group's lodge", async () => {
    mocks.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await verifyAndCreateNonMemberJoin(VALID_TOKEN);

    expect(mocks.validateMinimumStay).toHaveBeenCalledWith(
      checkIn,
      checkOut,
      LODGE_B,
    );
  });

  it("continues past the guard when the policy set still allows the stay", async () => {
    mocks.seasonFindMany.mockResolvedValue([]);
    mocks.groupDiscountFindUnique.mockResolvedValue(null);

    // Reaching the pricing step proves the guard ran and passed.
    await expect(verifyAndCreateNonMemberJoin(VALID_TOKEN)).rejects.toThrow(
      PRICING_SENTINEL,
    );

    expect(mocks.validateMinimumStay).toHaveBeenCalledTimes(1);
  });

  it("refuses BEFORE pricing, so nothing is priced for a stay the policy now forbids", async () => {
    mocks.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(verifyAndCreateNonMemberJoin(VALID_TOKEN)).resolves.toMatchObject(
      { outcome: "minimum_stay" },
    );

    expect(
      mocks.priceBookingGuestsWithMembershipTypePolicy,
    ).not.toHaveBeenCalled();
  });
});
