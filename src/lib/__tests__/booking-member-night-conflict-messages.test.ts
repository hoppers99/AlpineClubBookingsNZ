import { describe, expect, it } from "vitest";
import {
  buildBookingMemberNightConflictMessage,
  describeBookingMemberNightConflictBooking,
  describeBookingMemberNightConflictNextStep,
  describeBookingMemberNightConflictNights,
  type BookingMemberNightConflictCopyInput,
} from "@/lib/booking-member-night-conflict-messages";

// #2250 — the already-booked copy must say WHO is already booked, WHICH nights,
// and WHAT to do next, without telling a viewer about a booking they are not
// entitled to see.

function conflict(
  overrides: Partial<BookingMemberNightConflictCopyInput> = {},
): BookingMemberNightConflictCopyInput {
  return {
    memberName: "Alice Smith",
    conflictingNights: ["2026-06-01", "2026-06-02"],
    bookingStatus: "PAYMENT_PENDING",
    bookingOwnerName: "Bob Jones",
    isOwnBooking: false,
    canOpenBooking: false,
    canSelfRemove: false,
    ...overrides,
  };
}

describe("buildBookingMemberNightConflictMessage", () => {
  it("names the person, the nights, and what to do about somebody else's booking", () => {
    const message = buildBookingMemberNightConflictMessage([conflict()]);

    expect(message).toContain("Alice Smith");
    expect(message).toContain("1 Jun 2026 and 2 Jun 2026");
    expect(message).toContain("Ask whoever made that booking");
    expect(message).toContain("choose different dates");
  });

  it("addresses the member in the second person when they can take themselves off", () => {
    const message = buildBookingMemberNightConflictMessage([
      conflict({ canSelfRemove: true, canOpenBooking: true }),
    ]);

    expect(message).toContain("You are already on another booking");
    expect(message).toContain("1 Jun 2026 and 2 Jun 2026");
    expect(message).toContain("Take yourself off that booking");
  });

  it("sends the member to their own clashing booking when they own it", () => {
    const message = buildBookingMemberNightConflictMessage([
      conflict({ isOwnBooking: true, canOpenBooking: true }),
    ]);

    expect(message).toContain("Alice Smith is already on a booking");
    expect(message).toContain("Open that booking and change it");
  });

  it("lists every person and the union of their nights when several clash", () => {
    const message = buildBookingMemberNightConflictMessage([
      conflict({ conflictingNights: ["2026-06-02"] }),
      conflict({ memberName: "Cara Lee", conflictingNights: ["2026-06-01"] }),
    ]);

    expect(message).toContain("Alice Smith and Cara Lee");
    expect(message).toContain("1 Jun 2026 and 2 Jun 2026");
    expect(message).toContain("Nobody can be on two bookings for the same night");
  });

  it("does not repeat a member who clashes on more than one booking", () => {
    const message = buildBookingMemberNightConflictMessage([
      conflict({ conflictingNights: ["2026-06-01"] }),
      conflict({ conflictingNights: ["2026-06-05"] }),
    ]);

    expect(message).toContain("Alice Smith are already");
    expect(message).not.toContain("Alice Smith and Alice Smith");
  });

  it("summarises a long clash rather than listing every night", () => {
    const message = buildBookingMemberNightConflictMessage([
      conflict({
        conflictingNights: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
        ],
      }),
    ]);

    expect(message).toContain(
      "1 Jun 2026, 2 Jun 2026, 3 Jun 2026 and 2 more nights",
    );
  });

  it("never leaks the other booking's owner, id, or stay dates into the summary", () => {
    for (const viewer of [
      conflict(),
      conflict({ canSelfRemove: true, canOpenBooking: true }),
      conflict({ isOwnBooking: true, canOpenBooking: true }),
    ]) {
      const message = buildBookingMemberNightConflictMessage([viewer]);
      // The summary is composed only from what the requester already supplied:
      // the member they tried to book and the nights they chose.
      expect(message).not.toContain("Bob Jones");
      expect(message).not.toContain("payment pending");
    }
  });

  it("stays useful with an empty conflict list", () => {
    expect(buildBookingMemberNightConflictMessage([])).toContain(
      "already booked",
    );
  });
});

describe("describeBookingMemberNightConflictBooking", () => {
  it("withholds the other booking entirely from a viewer who may not open it", () => {
    expect(describeBookingMemberNightConflictBooking(conflict())).toBeNull();
  });

  it("names the owner and status only for an entitled viewer", () => {
    expect(
      describeBookingMemberNightConflictBooking(
        conflict({ canOpenBooking: true }),
      ),
    ).toBe("It is a payment pending booking made by Bob Jones.");
  });

  it("does not tell a member their own booking was made by somebody else", () => {
    expect(
      describeBookingMemberNightConflictBooking(
        conflict({ canOpenBooking: true, isOwnBooking: true }),
      ),
    ).toBe("It is your own payment pending booking.");
  });
});

describe("describeBookingMemberNightConflictNights", () => {
  it("renders date-only nights as club dates, never a browser-local timestamp", () => {
    expect(describeBookingMemberNightConflictNights(conflict())).toBe(
      "Already on a booking for 1 Jun 2026 and 2 Jun 2026.",
    );
    expect(
      describeBookingMemberNightConflictNights(
        conflict({ conflictingNights: ["2026-12-25"], canSelfRemove: true }),
      ),
    ).toBe("Already on another booking for 25 Dec 2026.");
  });

  it("falls back gracefully when no nights were reported", () => {
    expect(
      describeBookingMemberNightConflictNights(
        conflict({ conflictingNights: [] }),
      ),
    ).toContain("the nights you chose");
  });
});

describe("describeBookingMemberNightConflictNextStep", () => {
  it("offers self-removal first, then opening the booking, then asking someone", () => {
    expect(
      describeBookingMemberNightConflictNextStep(
        conflict({ canSelfRemove: true, canOpenBooking: true }),
      ),
    ).toContain("Take yourself off that booking");
    expect(
      describeBookingMemberNightConflictNextStep(
        conflict({ isOwnBooking: true, canOpenBooking: true }),
      ),
    ).toContain("Open that booking and change it");
    expect(
      describeBookingMemberNightConflictNextStep(
        conflict({ canOpenBooking: true }),
      ),
    ).toContain("Open that booking to sort it out");
    expect(describeBookingMemberNightConflictNextStep(conflict())).toContain(
      "Ask whoever made that booking",
    );
  });
});
