import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  validateMinimumStay: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacity: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  assertBookingNotQuotePriced: vi.fn(),
  assertProposedDateEditClearsXeroLockDate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: h.transaction,
  },
}));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return {
    ...actual,
    acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
    checkCapacity: h.checkCapacity,
    checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
  };
});

vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-modify")>();
  return {
    ...actual,
    assertBookingNotQuotePriced: h.assertBookingNotQuotePriced,
  };
});

vi.mock("@/lib/xero-period-lock-guard", () => ({
  assertProposedCheckInClearsXeroLockDate: vi.fn(),
  assertProposedDateEditClearsXeroLockDate:
    h.assertProposedDateEditClearsXeroLockDate,
}));

vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
  formatViolationsDetail: () => "Lodge B winter week: minimum 3 nights",
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { modifyBookingDates } from "@/lib/booking-date-modification-service";
import { MinimumStayPolicyViolationError } from "@/lib/booking-policy-exceptions";

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe("modifyBookingDates minimum-stay transport (#2363)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $executeRaw: h.executeRaw,
          booking: { findUnique: h.bookingFindUnique },
        }),
    );
    h.bookingFindUnique
      .mockResolvedValueOnce({ lodgeId: "lodge-b" })
      .mockResolvedValueOnce({
        id: "booking-1",
        memberId: "member-1",
        lodgeId: "lodge-b",
        status: "PAID",
        checkIn: D("2027-09-01"),
        checkOut: D("2027-09-03"),
        guests: [],
        payment: null,
        member: { id: "member-1" },
        promoRedemption: null,
      });
    h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
    h.assertBookingNotQuotePriced.mockResolvedValue(undefined);
    h.assertProposedDateEditClearsXeroLockDate.mockResolvedValue(undefined);
  });

  it("throws the exact frozen non-default-lodge review before capacity or writes", async () => {
    const violation = {
      reasonCode: "MINIMUM_STAY",
      policyId: "policy-lodge-b",
      policyVersion: 9,
      policyName: "Lodge B winter week",
      resolvedScope: {
        kind: "LODGE",
        lodgeId: "lodge-b",
        effectiveLodgeId: "lodge-b",
      },
      affectedNights: ["2027-09-02", "2027-09-03"],
      exceptionEligible: true,
      capacityMode: "NO_HOLD",
      message: "Lodge B requires three nights.",
      triggerDay: "Thursday",
      minimumNights: 3,
      actualNights: 2,
      requirements: {
        kind: "MINIMUM_STAY",
        minimumNights: 3,
        actualNights: 2,
        triggerDays: [4],
      },
    } as const;
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const operation = modifyBookingDates({
      bookingId: "booking-1",
      actor: { id: "member-1", role: "USER" },
      input: { checkIn: "2027-09-02", checkOut: "2027-09-04" },
      ipAddress: "127.0.0.1",
    });

    await expect(operation).rejects.toBeInstanceOf(
      MinimumStayPolicyViolationError,
    );
    await expect(operation).rejects.toMatchObject({
      status: 400,
      code: "MINIMUM_STAY_VIOLATION",
      details: "Lodge B winter week: minimum 3 nights",
      violations: [violation],
      exceptionReview: {
        violations: [violation],
        capacityMode: "NO_HOLD",
      },
    });
    expect(h.validateMinimumStay).toHaveBeenCalledWith(
      D("2027-09-02"),
      D("2027-09-04"),
      "lodge-b",
    );
    expect(h.checkCapacity).not.toHaveBeenCalled();
    expect(h.checkCapacityForGuestRanges).not.toHaveBeenCalled();
  });
});
