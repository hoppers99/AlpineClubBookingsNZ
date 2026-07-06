import { describe, expect, it } from "vitest";
import { AdminReviewStatus, BookingStatus } from "@prisma/client";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  checkinNotBlockedByMinorsReviewFilter,
  isCheckinBlockedByMinorsReview,
  minorsReviewAlertShouldFire,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";

describe("booking review helper", () => {
  it("flags bookings with only minors", () => {
    expect(
      requiresAdultSupervisionReview([
        { ageTier: "CHILD" },
        { ageTier: "YOUTH" },
      ])
    ).toBe(true);
    expect(ADULT_SUPERVISION_REVIEW_REASON).toContain("adult");
  });

  it("does not flag bookings that include an adult", () => {
    expect(
      requiresAdultSupervisionReview([
        { ageTier: "ADULT" },
        { ageTier: "INFANT" },
      ])
    ).toBe(false);
  });

  it("does not flag empty guest lists", () => {
    expect(requiresAdultSupervisionReview([])).toBe(false);
  });
});

describe("minors-only check-in block (#1372)", () => {
  const blocked = {
    requiresAdminReview: true,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
  };

  describe("isCheckinBlockedByMinorsReview", () => {
    it("blocks a booking with a pending adult-supervision review", () => {
      expect(isCheckinBlockedByMinorsReview(blocked)).toBe(true);
    });

    it("does not block once the review is APPROVED", () => {
      expect(
        isCheckinBlockedByMinorsReview({
          ...blocked,
          adminReviewStatus: AdminReviewStatus.APPROVED,
        }),
      ).toBe(false);
    });

    it("does not block when no review is flagged", () => {
      expect(
        isCheckinBlockedByMinorsReview({
          requiresAdminReview: false,
          adminReviewStatus: null,
          adminReviewReason: null,
        }),
      ).toBe(false);
    });

    it("is scoped to the adult-supervision reason (other reasons do not block)", () => {
      expect(
        isCheckinBlockedByMinorsReview({
          ...blocked,
          adminReviewReason: "Some other pending review reason",
        }),
      ).toBe(false);
    });
  });

  describe("checkinNotBlockedByMinorsReviewFilter", () => {
    it("excludes exactly the blocked composite (reason-scoped)", () => {
      expect(checkinNotBlockedByMinorsReviewFilter()).toEqual({
        NOT: {
          requiresAdminReview: true,
          adminReviewStatus: AdminReviewStatus.PENDING,
          adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
        },
      });
    });
  });

  describe("minorsReviewAlertShouldFire", () => {
    const notPreviouslyFlagged = {
      requiresAdminReview: false,
      adminReviewStatus: null,
    };

    it("fires when an edit newly blocks a PAID booking", () => {
      expect(
        minorsReviewAlertShouldFire({
          previous: notPreviouslyFlagged,
          updated: { ...blocked, status: BookingStatus.PAID },
        }),
      ).toBe(true);
    });

    it("fires for a CONFIRMED (capacity-holding) booking", () => {
      expect(
        minorsReviewAlertShouldFire({
          previous: notPreviouslyFlagged,
          updated: { ...blocked, status: BookingStatus.CONFIRMED },
        }),
      ).toBe(true);
    });

    it("does not fire when the booking still has an adult (not blocked)", () => {
      expect(
        minorsReviewAlertShouldFire({
          previous: notPreviouslyFlagged,
          updated: {
            requiresAdminReview: false,
            adminReviewStatus: null,
            adminReviewReason: null,
            status: BookingStatus.PAID,
          },
        }),
      ).toBe(false);
    });

    it("does not fire when the booking was already pending review", () => {
      expect(
        minorsReviewAlertShouldFire({
          previous: {
            requiresAdminReview: true,
            adminReviewStatus: AdminReviewStatus.PENDING,
          },
          updated: { ...blocked, status: BookingStatus.PAID },
        }),
      ).toBe(false);
    });

    it("does not fire for a pre-payment booking parked to AWAITING_REVIEW", () => {
      expect(
        minorsReviewAlertShouldFire({
          previous: notPreviouslyFlagged,
          updated: { ...blocked, status: BookingStatus.AWAITING_REVIEW },
        }),
      ).toBe(false);
    });
  });
});
