import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import {
  describeGuestSelfRemovalBlocker,
  evaluateGuestSelfRemoval,
  SELF_REMOVABLE_GUEST_BOOKING_STATUSES,
  type GuestSelfRemovalBlocker,
} from "@/lib/booking-guest-self-removal";

// #2250 — the one server-side rule behind BOTH the booking detail page's
// "Remove me from this booking" affordance and the night-conflict card's
// `canSelfRemove`. The removal service imports the status half of it, so a
// surface can never offer an action the service refuses.

const TODAY = parseDateOnly("2026-06-01");

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateGuestSelfRemoval({
    actorMemberId: "member-guest",
    guestMemberId: "member-guest",
    bookingOwnerMemberId: "member-owner",
    bookingStatus: BookingStatus.CONFIRMED,
    bookingCheckIn: parseDateOnly("2026-06-10"),
    bookingGuestCount: 2,
    today: TODAY,
    ...overrides,
  });
}

describe("evaluateGuestSelfRemoval", () => {
  it("lets a linked guest take themselves off a future booking somebody else owns", () => {
    expect(evaluate()).toEqual({ canSelfRemove: true, blocker: null });
  });

  it("refuses the booking's own owner — they edit the guest list instead", () => {
    expect(evaluate({ bookingOwnerMemberId: "member-guest" })).toEqual({
      canSelfRemove: false,
      blocker: "OWN_BOOKING",
    });
  });

  it("refuses removing somebody else's place, including a non-member guest row", () => {
    expect(evaluate({ guestMemberId: "member-other" })).toEqual({
      canSelfRemove: false,
      blocker: "NOT_THEIR_OWN_GUEST",
    });
    expect(evaluate({ guestMemberId: null })).toEqual({
      canSelfRemove: false,
      blocker: "NOT_THEIR_OWN_GUEST",
    });
  });

  it("refuses a status the removal service would reject", () => {
    expect(evaluate({ bookingStatus: BookingStatus.CANCELLED })).toEqual({
      canSelfRemove: false,
      blocker: "BOOKING_STATUS",
    });
    expect(evaluate({ bookingStatus: BookingStatus.COMPLETED })).toEqual({
      canSelfRemove: false,
      blocker: "BOOKING_STATUS",
    });
  });

  it("is future-only: a stay starting today or earlier can no longer be left", () => {
    expect(evaluate({ bookingCheckIn: TODAY })).toEqual({
      canSelfRemove: false,
      blocker: "STAY_NOT_FUTURE",
    });
    expect(evaluate({ bookingCheckIn: parseDateOnly("2026-05-31") })).toEqual({
      canSelfRemove: false,
      blocker: "STAY_NOT_FUTURE",
    });
    expect(evaluate({ bookingCheckIn: parseDateOnly("2026-06-02") })).toEqual({
      canSelfRemove: true,
      blocker: null,
    });
  });

  it("never empties a booking — the last guest must have it cancelled instead", () => {
    expect(evaluate({ bookingGuestCount: 1 })).toEqual({
      canSelfRemove: false,
      blocker: "LAST_GUEST",
    });
  });

  it("covers exactly the eight statuses the removal service self-removes from", () => {
    expect([...SELF_REMOVABLE_GUEST_BOOKING_STATUSES].sort()).toEqual(
      [
        BookingStatus.AWAITING_REVIEW,
        BookingStatus.CONFIRMED,
        BookingStatus.DRAFT,
        BookingStatus.PAID,
        BookingStatus.PAYMENT_PENDING,
        BookingStatus.PENDING,
        BookingStatus.WAITLISTED,
        BookingStatus.WAITLIST_OFFERED,
      ].sort(),
    );
    expect(SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(BookingStatus.CANCELLED)).toBe(
      false,
    );
    expect(SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(BookingStatus.COMPLETED)).toBe(
      false,
    );
  });
});

describe("describeGuestSelfRemovalBlocker", () => {
  const blockers: GuestSelfRemovalBlocker[] = [
    "NOT_THEIR_OWN_GUEST",
    "OWN_BOOKING",
    "BOOKING_STATUS",
    "STAY_NOT_FUTURE",
    "LAST_GUEST",
  ];

  it("gives every blocker a plain-English member-facing reason", () => {
    for (const blocker of blockers) {
      const reason = describeGuestSelfRemovalBlocker(blocker);
      expect(reason.length).toBeGreaterThan(20);
      expect(reason).toMatch(/\.$/);
    }
  });

  it("points the member at a real next step when the stay has started or is nearly empty", () => {
    expect(describeGuestSelfRemovalBlocker("STAY_NOT_FUTURE")).toContain(
      "already started",
    );
    expect(describeGuestSelfRemovalBlocker("LAST_GUEST")).toContain("cancel it");
  });
});
