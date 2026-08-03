import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

// #2363. Confirming a same-lodge waitlist offer turns a queue placeholder into
// capacity-holding status — a fresh commitment to those nights — but it used to
// run no minimum-stay check at all. An offer lives 48 hours, and an admin or a
// config import can tighten or add a rule inside that window, so this is the
// same "the club's state moved under a staged request" shape as the public
// group-join verification stage, and it fails closed the same way: the offer is
// NOT consumed, the entry goes back on the waitlist, and the member reads a
// plain sentence while the frozen review snapshot stays server-side.

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  prismaBookingFindUnique: vi.fn(),
  txBookingFindUnique: vi.fn(),
  txBookingUpdateMany: vi.fn(),
  validateMinimumStay: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  logAudit: vi.fn(),
  warn: vi.fn(),
  confirmCrossLodgeWaitlistOffer: vi.fn(),
  // #2543 — the offer's persisted guest rows, read for the paid-up-adult re-check.
  // Empty is the neutral default: no member rows means nobody is being repriced,
  // so the requirement does not apply and every case in this file is unchanged.
  prismaBookingGuestFindMany: vi.fn(async () => []),
  resolveSubscriptionLockoutMode: vi.fn(async () => "NON_MEMBER_PRICING"),
  evaluateNonMemberPricingRequirements: vi.fn(async () => null),
}));

const txClient = {
  $executeRaw: vi.fn(),
  // #2364: the hosting review is reconciled inside the booking write, so
  // every prisma/tx double a booking path runs against needs this client.
  adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
  booking: {
    findUnique: h.txBookingFindUnique,
    updateMany: h.txBookingUpdateMany,
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: h.transaction,
    booking: { findUnique: h.prismaBookingFindUnique },
    // #2543: the paid-up-adult re-check reads the offer's guest rows before the
    // claiming transaction, on the same client the minimum-stay check uses.
    bookingGuest: { findMany: h.prismaBookingGuestFindMany },
  },
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  resolveSubscriptionLockoutMode: h.resolveSubscriptionLockoutMode,
}));
// #2543: the evaluator is stubbed, but the two helpers that shape the REFUSAL are
// the real ones — the point of the case below is that this path answers with the
// same body and the same code as the five booking write paths, so stubbing those
// would test nothing.
vi.mock("@/lib/subscription-lockout-enforcement", async (importActual) => {
  const actual = await importActual<
    typeof import("@/lib/subscription-lockout-enforcement")
  >();
  return {
    ...actual,
    evaluateNonMemberPricingRequirements: h.evaluateNonMemberPricingRequirements,
  };
});
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
  checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: h.reconcileBedAllocations,
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
vi.mock("@/lib/waitlist-cross-lodge", () => ({
  confirmCrossLodgeWaitlistOffer: h.confirmCrossLodgeWaitlistOffer,
  getWaitlistCrossLodgeOrder: vi.fn(),
  quoteWaitlistEntryAtLodge: vi.fn(),
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldPolicy: vi
    .fn()
    .mockResolvedValue({ enabled: false, holdDays: 0, source: "default" }),
}));
vi.mock("@/lib/email", () => ({
  sendWaitlistOfferEmail: vi.fn(),
  sendWaitlistOfferExpiredEmail: vi.fn(),
  sendAdminWaitlistOfferAlert: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: h.warn },
}));

import { confirmWaitlistOffer } from "@/lib/waitlist";
// The real formatter, so this path and the cross-lodge promotion are checked
// against one shared string rather than against two copies of it.
import { formatMissingPaidUpAdultWaitlistRefusal } from "@/lib/policies/subscription-lockout-pricing";

const LODGE = "lodge-a";
const CHECK_IN = new Date("2026-07-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-07-12T00:00:00.000Z");

/** A realistic frozen violation — the real evaluator's exact shape. */
const violation = {
  reasonCode: "MINIMUM_STAY",
  policyId: "policy-winter-weekends",
  policyVersion: 5,
  policyName: "Winter weekends",
  resolvedScope: {
    kind: "CLUB_WIDE",
    lodgeId: null,
    effectiveLodgeId: LODGE,
  },
  affectedNights: ["2026-07-10", "2026-07-11"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message:
    "Bookings including a Friday night require a minimum stay of 3 nights (Winter weekends). Your booking is 2 nights.",
  triggerDay: "Friday",
  minimumNights: 3,
  actualNights: 2,
  requirements: {
    kind: "MINIMUM_STAY",
    minimumNights: 3,
    actualNights: 2,
    triggerDays: [5],
  },
};

function offer(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: LODGE,
    status: BookingStatus.WAITLIST_OFFERED,
    waitlistOfferedLodgeId: null,
    waitlistOfferExpiresAt: new Date(Date.now() + 86_400_000),
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: [{ id: "g1", isMember: true, nights: [] }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.transaction.mockImplementation(
    async (callback: (tx: typeof txClient) => unknown) => callback(txClient),
  );
  h.prismaBookingFindUnique.mockResolvedValue(offer());
  // Reset, not just clear: a `...Once` queue survives `clearAllMocks`, and the
  // refusal cases return before the main transaction ever drains theirs.
  h.txBookingFindUnique.mockReset();
  h.txBookingFindUnique
    .mockResolvedValueOnce({ lodgeId: LODGE })
    .mockResolvedValue(offer());
  h.txBookingUpdateMany.mockResolvedValue({ count: 1 });
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.checkCapacityForGuestRanges.mockResolvedValue({ available: true });
  h.reconcileBedAllocations.mockResolvedValue(undefined);
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
});

describe("confirmWaitlistOffer minimum-stay guard (#2363)", () => {
  it("refuses a confirm after an admin tightens the rule, and puts the entry back on the waitlist instead of consuming the offer", async () => {
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(result.success).toBe(false);
    expect(result.code).toBe("MINIMUM_STAY_VIOLATION");
    expect(result.newStatus).toBeUndefined();
    // Evaluated for the booking's own lodge, on the offered nights.
    expect(h.validateMinimumStay).toHaveBeenCalledWith(
      CHECK_IN,
      CHECK_OUT,
      LODGE,
    );
    // The offer is not burnt: the entry is returned to WAITLISTED under the
    // lodge's capacity lock, status-guarded, and bed allocations reconciled.
    expect(h.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      LODGE,
    );
    expect(h.txBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", status: BookingStatus.WAITLIST_OFFERED },
      data: expect.objectContaining({ status: BookingStatus.WAITLISTED }),
    });
    expect(h.reconcileBedAllocations).toHaveBeenCalledTimes(1);
    // Nothing was ever flipped to a capacity-holding status.
    expect(h.checkCapacityForGuestRanges).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("gives the member a plain sentence and keeps the frozen snapshot server-side", async () => {
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(result.error).toBe(
      "The minimum stay for these nights has changed since you joined the waitlist, " +
        "so this offer can no longer be confirmed. You've been returned to the waitlist.",
    );
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("Winter weekends");
    expect(wire).not.toContain("policy-winter-weekends");
    expect(wire).not.toContain("minimum stay of 3 nights");
    // The detail the member does not get is still logged for the club.
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        violations: [{ policyId: "policy-winter-weekends", policyVersion: 5 }],
      }),
      expect.stringContaining("minimum-stay policy no longer satisfied"),
    );
  });

  it("leaves a compliant confirm untouched", async () => {
    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(h.validateMinimumStay).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.newStatus).toBe(BookingStatus.PAYMENT_PENDING);
    expect(result.code).toBeUndefined();
  });

  it("never reads policy for somebody else's offer — the Forbidden answer is unchanged", async () => {
    // There is no admin confirm path: the transaction refuses any actor that is
    // not the booking's own member, so the only actor that can ever reach the
    // policy check is a non-admin confirming their own offer.
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmWaitlistOffer("booking-1", "someone-else");

    expect(h.validateMinimumStay).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: "Forbidden" });
  });

  it("leaves an already-expired offer with its own answer", async () => {
    h.prismaBookingFindUnique.mockResolvedValue(
      offer({ waitlistOfferExpiresAt: new Date(Date.now() - 1_000) }),
    );
    h.txBookingFindUnique.mockReset();
    h.txBookingFindUnique
      .mockResolvedValueOnce({ lodgeId: LODGE })
      .mockResolvedValue(
        offer({ waitlistOfferExpiresAt: new Date(Date.now() - 1_000) }),
      );
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(h.validateMinimumStay).not.toHaveBeenCalled();
    expect(result.error).toContain("expired");
  });
});

// The guard above hangs off an UNLOCKED pre-transaction read, and it only runs
// when that read already saw a live same-lodge offer this member owns. The
// claiming transaction — which does hold the lodge lock — therefore needs its
// own evidence that the policy was actually evaluated for the offer it is about
// to spend, because `processWaitlistForDates` makes exactly the transition that
// invalidates the pre-read (WAITLISTED -> WAITLIST_OFFERED) and this confirm
// route carries no rate limit.
describe("confirmWaitlistOffer policy backstop inside the claim (#2363)", () => {
  it("refuses retry-safely when the entry became a live offer after the pre-read, instead of claiming it with the policy unevaluated", async () => {
    // Pre-read: still queued, so the minimum-stay guard is skipped...
    h.prismaBookingFindUnique.mockResolvedValue(
      offer({ status: BookingStatus.WAITLISTED, waitlistOfferExpiresAt: null }),
    );
    // ...and the offer sweep runs before the transaction takes the lodge lock,
    // so the locked read finds a live WAITLIST_OFFERED entry.
    h.txBookingFindUnique.mockReset();
    h.txBookingFindUnique
      .mockResolvedValueOnce({ lodgeId: LODGE })
      .mockResolvedValue(offer());
    // The rule tightened in the meantime; nothing must be able to spend the
    // offer without that being evaluated.
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(result.success).toBe(false);
    expect(result.code).toBe("CONFIRM_RETRY");
    expect(result.newStatus).toBeUndefined();
    // The pre-read genuinely skipped the check — that is the hole this closes.
    expect(h.validateMinimumStay).not.toHaveBeenCalled();
    // Retry-safe: not one row written. No claim, no revert, no allocation
    // churn, no audit entry — the offer is still there for the next attempt,
    // which re-reads it and runs the guard for real.
    expect(h.txBookingUpdateMany).not.toHaveBeenCalled();
    expect(h.checkCapacityForGuestRanges).not.toHaveBeenCalled();
    expect(h.reconcileBedAllocations).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("refuses retry-safely when a same-lodge classification goes stale and the offer is now cross-lodge", async () => {
    // Pre-read saw no offered lodge, so this function took the same-lodge path
    // and checked the policy at the booking's OWN lodge...
    h.txBookingFindUnique.mockReset();
    h.txBookingFindUnique
      .mockResolvedValueOnce({ lodgeId: LODGE })
      // ...but by the locked read the entry holds a cross-lodge offer, whose
      // nights belong to a different lodge's policy set entirely.
      .mockResolvedValue(offer({ waitlistOfferedLodgeId: "lodge-b" }));

    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(result.success).toBe(false);
    // The same-lodge check did run — on the pre-read's classification, which is
    // exactly what went stale.
    expect(h.validateMinimumStay).toHaveBeenCalledTimes(1);
    expect(result.code).toBe("CONFIRM_RETRY");
    // It is sent back through the dispatch at the top rather than claimed here.
    expect(h.confirmCrossLodgeWaitlistOffer).not.toHaveBeenCalled();
    expect(h.txBookingUpdateMany).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("keeps the offer's own answers when the pre-read skipped the check for a reason the transaction agrees with", async () => {
    // Not this member's offer: the transaction's Forbidden answer wins over the
    // retry, because it is a settled refusal rather than a stale read.
    const forbidden = await confirmWaitlistOffer("booking-1", "someone-else");
    expect(forbidden).toEqual({ success: false, error: "Forbidden" });

    // Already expired: same story — "expired" is the true answer, not "retry".
    vi.clearAllMocks();
    h.transaction.mockImplementation(
      async (callback: (tx: typeof txClient) => unknown) => callback(txClient),
    );
    const expired = offer({
      waitlistOfferExpiresAt: new Date(Date.now() - 1_000),
    });
    h.prismaBookingFindUnique.mockResolvedValue(expired);
    h.txBookingFindUnique.mockReset();
    h.txBookingFindUnique
      .mockResolvedValueOnce({ lodgeId: LODGE })
      .mockResolvedValue(expired);

    const result = await confirmWaitlistOffer("booking-1", "member-1");
    expect(result.error).toContain("expired");
    expect(result.code).toBeUndefined();
  });
});

describe("confirmWaitlistOffer paid-up-adult re-check (#2543)", () => {
  /**
   * THE SIXTH MONEY PATH. The offer sweep reprices a STORED booking at current
   * rates and passes no locked night prices, so it inherits the unpaid-subscription
   * reprice for the whole stay — but neither of the two things that make that
   * reprice fair to the member reached this path. A party the create path would
   * have refused with a 409 and an override door could be confirmed here and
   * charged non-member rates instead.
   */
  const violation = {
    reasonCode: "PAID_UP_ADULT_MEMBER_REQUIRED" as const,
    policyId: "membership-lockout-settings:default",
    policyVersion: 1,
    policyName: "Paid-up adult member required (subscription lockout)",
    resolvedScope: {
      kind: "CLUB_WIDE" as const,
      lodgeId: null,
      effectiveLodgeId: "lodge-1",
    },
    affectedNights: ["2026-08-01"],
    requirements: {
      kind: "PAID_UP_ADULT_MEMBER" as const,
      requiredPaidUpAdultMembers: 1,
      repricedUnpaidMemberCount: 1,
      participantCount: 2,
    },
    exceptionEligible: true,
    capacityMode: "HOLD" as const,
    message: "This booking needs at least one paid-up adult member staying on it.",
  };

  it("refuses without consuming the offer, and names the override door", async () => {
    h.evaluateNonMemberPricingRequirements.mockResolvedValue({
      repricedMemberIds: ["m-unpaid"],
      hasPaidUpAdultMember: false,
      paidUpAdultMemberRequired: true,
      memberRateNotice: "notice",
      violation,
    } as never);

    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(result.success).toBe(false);
    expect(result.code).toBe("PAID_UP_ADULT_MEMBER_REQUIRED");
    // The WAITLIST flavour of the shared refusal, byte-identical to the cross-lodge
    // promotion's. The offer was rejected without being consumed, so the bare
    // sentence would read as though the member had lost the offer AND their spot.
    expect(result.error).toBe(formatMissingPaidUpAdultWaitlistRefusal());
    expect(result.error).toContain("kept your place on the waitlist");
    // ...while the frozen violation's own message is unchanged: it is hashed into
    // exception snapshots and read by the reviewing officer, for whom the waitlist
    // sentence is neither true nor relevant.
    expect(result.paidUpAdultRefusal?.details).toBe(violation.message);
    // Neither sentence names who is unpaid.
    expect(JSON.stringify(result)).not.toMatch(/m-unpaid/);
    // The shared refusal body, so the member is told where to ask — and told the
    // beds are held while an officer decides.
    expect(result.paidUpAdultRefusal?.exceptionRequestPath).toBe(
      "/api/bookings/exception-requests",
    );
    expect(result.paidUpAdultRefusal?.exceptionReview.capacityMode).toBe("HOLD");
    // The offer went BACK on the waitlist rather than being burnt: the member keeps
    // their place and can fix the party or ask for the override.
    expect(h.txBookingUpdateMany).toHaveBeenCalled();
    // And the offer was never CLAIMED: the confirm audit entry is what the claiming
    // transaction writes on success, and it is absent. (The single transaction that
    // did run is the revert's own.)
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("carries the reason onto a successful confirm", async () => {
    h.evaluateNonMemberPricingRequirements.mockResolvedValue({
      repricedMemberIds: ["m-unpaid"],
      hasPaidUpAdultMember: true,
      paidUpAdultMemberRequired: true,
      memberRateNotice: "A membership subscription on this booking isn't paid",
      violation: null,
    } as never);

    const result = await confirmWaitlistOffer("booking-1", "member-1");

    expect(result.success).toBe(true);
    expect(result.subscriptionMemberRateNotice).toContain("isn't paid");
  });

  it("adds no key at all when nobody is repriced", async () => {
    h.evaluateNonMemberPricingRequirements.mockResolvedValue(null as never);
    const result = await confirmWaitlistOffer("booking-1", "member-1");
    expect(result.success).toBe(true);
    expect("subscriptionMemberRateNotice" in result).toBe(false);
  });
});
