import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import {
  describeGuestSelfRemovalBlocker,
  evaluateGuestSelfRemoval,
  resolveBookingSelfRemovalCard,
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

  // #2250 — the removal service's LAST gate, assertBookingNotQuotePriced. The
  // booking detail page can afford the one indexed lookup, so it predicts the
  // refusal instead of offering a button the server would reject.
  it("refuses a quote-priced booking, after every other gate", () => {
    expect(evaluate({ isQuotePriced: true })).toEqual({
      canSelfRemove: false,
      blocker: "QUOTE_PRICED",
    });
    // Order matters: the reason the member reads must be the one the service
    // would have raised first, and the service checks status/date/last-guest
    // before the quote-priced lookup.
    expect(
      evaluate({ isQuotePriced: true, bookingStatus: BookingStatus.CANCELLED }),
    ).toEqual({ canSelfRemove: false, blocker: "BOOKING_STATUS" });
    expect(evaluate({ isQuotePriced: true, bookingGuestCount: 1 })).toEqual({
      canSelfRemove: false,
      blocker: "LAST_GUEST",
    });
  });

  it("defaults to not-quote-priced for callers that cannot afford the lookup", () => {
    // The member-night guard runs inside the booking-write transaction and
    // must not add a per-conflict query, so it omits the flag and keeps its
    // pre-#2250 behaviour exactly.
    expect(evaluate({ isQuotePriced: undefined })).toEqual({
      canSelfRemove: true,
      blocker: null,
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
    "QUOTE_PRICED",
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
    // Member-facing, not the operator-facing QUOTE_PRICED_EDIT_BLOCK_MESSAGE:
    // "re-price from its booking request" is advice a member cannot act on.
    const quotePriced = describeGuestSelfRemovalBlocker("QUOTE_PRICED");
    expect(quotePriced).toContain("Ask the person who made the booking");
    expect(quotePriced).not.toContain("season rates");
  });
});

// #2250 — the booking detail page's own gate: WHO sees the card at all. The
// page renders `<SelfRemoveFromBookingCard>` if and only if this returns a
// value, so widening it (to the owner, to an admin, to a viewer with no guest
// row, to a soft-deleted booking) has to fail here rather than only in review.
describe("resolveBookingSelfRemovalCard", () => {
  const GUESTS = [
    { id: "guest-owner", memberId: "member-owner" },
    { id: "guest-viewer", memberId: "member-guest" },
    { id: "guest-nonmember", memberId: null },
  ];

  function resolve(overrides: Record<string, unknown> = {}) {
    return resolveBookingSelfRemovalCard({
      actorMemberId: "member-guest",
      isBookingOwner: false,
      isAdminViewer: false,
      bookingDeletedAt: null,
      bookingOwnerMemberId: "member-owner",
      bookingStatus: BookingStatus.CONFIRMED,
      bookingCheckIn: parseDateOnly("2026-06-10"),
      guests: GUESTS,
      today: TODAY,
      ...overrides,
    });
  }

  it("gives a linked guest their own guest row and the action", () => {
    expect(resolve()).toEqual({
      guestId: "guest-viewer",
      canSelfRemove: true,
      blockedReason: null,
    });
  });

  it("shows nothing at all to the booking's owner", () => {
    // The owner edits the guest list through the booking edit flow. Even with a
    // guest row of their own on the booking, no card.
    expect(
      resolve({
        actorMemberId: "member-owner",
        isBookingOwner: true,
      }),
    ).toBeNull();
  });

  it("shows nothing at all to an admin viewer", () => {
    expect(resolve({ isAdminViewer: true })).toBeNull();
  });

  it("shows nothing to a viewer who is not on the booking", () => {
    expect(resolve({ actorMemberId: "member-stranger" })).toBeNull();
  });

  it("never matches a non-member guest row on a null actor id", () => {
    // `guests` carries rows with memberId null; a lookup that compared loosely
    // would hand a stranger somebody else's guest id.
    expect(
      resolve({ actorMemberId: null as unknown as string }),
    ).toBeNull();
  });

  it("shows nothing on a soft-deleted booking", () => {
    expect(resolve({ bookingDeletedAt: new Date("2026-05-01") })).toBeNull();
  });

  it("keeps the card but hides the action, with the reason, when the rule says no", () => {
    expect(resolve({ bookingStatus: BookingStatus.CANCELLED })).toEqual({
      guestId: "guest-viewer",
      canSelfRemove: false,
      blockedReason: describeGuestSelfRemovalBlocker("BOOKING_STATUS"),
    });
    expect(resolve({ bookingCheckIn: TODAY })).toEqual({
      guestId: "guest-viewer",
      canSelfRemove: false,
      blockedReason: describeGuestSelfRemovalBlocker("STAY_NOT_FUTURE"),
    });
    expect(
      resolve({ guests: [{ id: "guest-viewer", memberId: "member-guest" }] }),
    ).toEqual({
      guestId: "guest-viewer",
      canSelfRemove: false,
      blockedReason: describeGuestSelfRemovalBlocker("LAST_GUEST"),
    });
  });

  it("hides the action on a quote-priced booking and says why", () => {
    expect(resolve({ isQuotePriced: true })).toEqual({
      guestId: "guest-viewer",
      canSelfRemove: false,
      blockedReason: describeGuestSelfRemovalBlocker("QUOTE_PRICED"),
    });
  });

  it("counts every guest on the booking, not just the member-linked ones", () => {
    // Two rows, one of them a non-member guest: removing the viewer still
    // leaves somebody on the booking, so it is not the LAST_GUEST case.
    expect(
      resolve({
        guests: [
          { id: "guest-viewer", memberId: "member-guest" },
          { id: "guest-nonmember", memberId: null },
        ],
      }),
    ).toEqual({
      guestId: "guest-viewer",
      canSelfRemove: true,
      blockedReason: null,
    });
  });
});
