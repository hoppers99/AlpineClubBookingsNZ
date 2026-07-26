import { BookingStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import {
  assertNoBookingMemberNightConflicts,
  BookingMemberNightConflictError,
  findBookingMemberNightConflicts,
  getBookingMemberNightConflictResponse,
  MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES,
  type BookingMemberNightConflict,
} from "@/lib/booking-member-night-conflicts";

function existingGuest(overrides: Record<string, unknown> = {}) {
  return {
    id: "guest-1",
    memberId: "member-1",
    firstName: "Alice",
    lastName: "Smith",
    stayStart: null,
    stayEnd: null,
    nights: [],
    member: { firstName: "Alice", lastName: "Smith" },
    booking: {
      id: "booking-1",
      memberId: "member-1",
      status: BookingStatus.DRAFT,
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      member: { firstName: "Alice", lastName: "Smith" },
      guests: [
        { id: "guest-1", memberId: "member-1" },
        { id: "guest-2", memberId: "member-2" },
      ],
    },
    ...overrides,
  };
}

function conflictDb(rows: unknown[]) {
  return {
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue(rows),
    },
  };
}

describe("findBookingMemberNightConflicts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks a member from being added twice on the same lodge night", async () => {
    const db = conflictDb([existingGuest()]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [{ memberId: "member-1" }],
    });

    expect(conflicts).toEqual([
      expect.objectContaining({
        memberId: "member-1",
        memberName: "Alice Smith",
        bookingId: "booking-1",
        bookingStatus: BookingStatus.DRAFT,
        conflictingNights: ["2026-06-01", "2026-06-02"],
        isOwnBooking: true,
        canOpenBooking: true,
        canSelfRemove: false,
        // #2250 — the clashing place is the actor's own, even though they may
        // not self-remove from a booking they own. The copy needs this to
        // address them directly instead of narrating them by name.
        isSelfGuest: true,
      }),
    ]);
  });

  it("marks a future booking self-guest conflict as self-removable", async () => {
    const db = conflictDb([
      existingGuest({
        id: "guest-2",
        memberId: "member-2",
        firstName: "Bob",
        lastName: "Jones",
        member: { firstName: "Bob", lastName: "Jones" },
        booking: {
          id: "booking-2",
          memberId: "member-1",
          status: BookingStatus.PAYMENT_PENDING,
          checkIn: parseDateOnly("2026-06-10"),
          checkOut: parseDateOnly("2026-06-13"),
          member: { firstName: "Alice", lastName: "Smith" },
          guests: [
            { id: "guest-1", memberId: "member-1" },
            { id: "guest-2", memberId: "member-2" },
          ],
        },
      }),
    ]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      actorMemberId: "member-2",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-11"),
      checkOut: parseDateOnly("2026-06-12"),
      guests: [{ memberId: "member-2" }],
    });

    expect(conflicts[0]).toMatchObject({
      memberId: "member-2",
      memberName: "Bob Jones",
      bookingId: "booking-2",
      bookingOwnerName: "Alice Smith",
      conflictingNights: ["2026-06-11"],
      isOwnBooking: false,
      canOpenBooking: true,
      canSelfRemove: true,
      isSelfGuest: true,
    });
  });

  it("does not mark somebody else's clashing place as the actor's own", async () => {
    const db = conflictDb([existingGuest()]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      actorMemberId: "member-9",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [{ memberId: "member-1" }],
    });

    expect(conflicts[0]).toMatchObject({
      memberId: "member-1",
      isOwnBooking: false,
      canOpenBooking: false,
      canSelfRemove: false,
      isSelfGuest: false,
    });
  });

  it("honors sparse explicit nights before reporting a conflict", async () => {
    const db = conflictDb([
      existingGuest({
        nights: [{ stayDate: parseDateOnly("2026-06-01") }],
      }),
    ]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [
        {
          memberId: "member-1",
          nights: ["2026-06-02"],
        },
      ],
    });

    expect(conflicts).toEqual([]);
  });

  it("queries only live booking statuses without changing capacity semantics", async () => {
    const db = conflictDb([]);

    await findBookingMemberNightConflicts(db as any, {
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [{ memberId: "member-1" }],
    });

    expect(MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES).toContain(BookingStatus.DRAFT);
    expect(MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES).toContain(BookingStatus.PAYMENT_PENDING);
    expect(MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES).not.toContain(BookingStatus.CANCELLED);
    expect(db.bookingGuest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining({
            deletedAt: null,
            status: { in: [...MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES] },
            OR: expect.arrayContaining([
              { status: { not: BookingStatus.DRAFT } },
              { draftExpiresAt: null },
              expect.objectContaining({ draftExpiresAt: expect.any(Object) }),
            ]),
          }),
        }),
      }),
    );
  });

  // #1881 — the authoritative assert takes a per-member advisory lock (sorted,
  // in its own namespace) BEFORE reading, so the cross-lodge person-night
  // invariant is serialised even though capacity locks are per-lodge only.
  it("locks every member-linked guest's per-member key (sorted) before reading, then throws on a conflict", async () => {
    const executeRawCalls: string[] = [];
    const lockValues: unknown[][] = [];
    const db = {
      $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        executeRawCalls.push(strings.join("|"));
        lockValues.push(values);
        return Promise.resolve(1);
      }),
      bookingGuest: {
        findMany: vi.fn().mockImplementation(async () => {
          // Reads must happen AFTER both per-member locks are taken.
          expect(executeRawCalls).toHaveLength(2);
          return [];
        }),
      },
    };

    await assertNoBookingMemberNightConflicts(db as never, {
      actorMemberId: "member-2",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      // Deliberately out of order to prove sorted acquisition.
      guests: [{ memberId: "member-2" }, { memberId: "member-1" }],
    });

    // Two per-member advisory locks were taken before the read.
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    for (const call of executeRawCalls) {
      expect(call).toContain("pg_advisory_xact_lock");
      expect(call).toContain("hashtext");
    }
    // Sorted memberId order: each lock's bind params are [namespace, memberId],
    // and the sorted acquisition puts member-1 before member-2.
    const lockOrder = lockValues.map((values) => values[1]);
    expect(lockOrder).toEqual(["member-1", "member-2"]);
  });
});

// #2250 — the already-booked copy on both paths a member can hit it: the
// advisory pre-check that builds a 409 body from a found conflict list
// (getBookingMemberNightConflictResponse, what the booking wizard renders) and
// the transactional guard that throws (BookingMemberNightConflictError, whose
// message every 409 route surfaces). Both must say who, which nights, and what
// to do next — without telling the requester about a booking they may not see.
describe("booking member-night conflict messages", () => {
  function conflictRow(
    overrides: Partial<BookingMemberNightConflict> = {},
  ): BookingMemberNightConflict {
    return {
      memberId: "member-2",
      memberName: "Bob Jones",
      bookingId: "booking-2",
      bookingStatus: BookingStatus.PAYMENT_PENDING,
      bookingOwnerName: "Carol Nguyen",
      bookingCheckIn: "2026-06-10",
      bookingCheckOut: "2026-06-13",
      guestId: "guest-2",
      conflictingNights: ["2026-06-11", "2026-06-12"],
      isOwnBooking: false,
      canOpenBooking: false,
      canSelfRemove: false,
      isSelfGuest: false,
      ...overrides,
    };
  }

  it("tells the wizard path who, which nights, and what to do next", () => {
    const body = getBookingMemberNightConflictResponse([conflictRow()]);

    expect(body.code).toBe("BOOKING_MEMBER_NIGHT_CONFLICT");
    expect(body.error).toBe(
      "Bob Jones is already on a booking for 11 Jun 2026 and 12 Jun 2026. " +
        "Ask whoever made that booking, or the club, to take them off it.",
    );
  });

  it("keeps the 409 flow-neutral, because admin booking-request routes return it too", () => {
    // approve / hold / send-quote all surface this body; "choose different
    // dates" is advice only the person picking the dates can act on, and the
    // booking wizard opts back into it when it renders the next step itself.
    for (const conflicts of [
      [conflictRow()],
      [conflictRow({ canSelfRemove: true, isSelfGuest: true })],
      [conflictRow(), conflictRow({ memberName: "Dana Patel" })],
    ]) {
      expect(getBookingMemberNightConflictResponse(conflicts).error).not.toContain(
        "choose different dates",
      );
    }
  });

  it("offers self-removal in the message when this viewer may take themselves off", () => {
    const body = getBookingMemberNightConflictResponse([
      conflictRow({ canSelfRemove: true, isSelfGuest: true, canOpenBooking: true }),
    ]);

    expect(body.error).toContain("You are already on another booking");
    expect(body.error).toContain("Take yourself off that booking");
  });

  it("addresses the member directly when they clash with their own earlier booking", () => {
    const body = getBookingMemberNightConflictResponse([
      conflictRow({
        isSelfGuest: true,
        isOwnBooking: true,
        canOpenBooking: true,
        canSelfRemove: false,
      }),
    ]);

    expect(body.error).toBe(
      "You are already on another booking for 11 Jun 2026 and 12 Jun 2026. " +
        "Open that booking and change it.",
    );
    expect(body.error).not.toContain("Bob Jones");
  });

  it("carries the same message on the transactional 409 path", () => {
    const error = new BookingMemberNightConflictError([conflictRow()]);

    expect(error.message).toBe(
      getBookingMemberNightConflictResponse([conflictRow()]).error,
    );
    expect(error.name).toBe("BookingMemberNightConflictError");
    expect(error.conflicts).toHaveLength(1);
  });

  it("never names the other booking's owner in a message a stranger receives", () => {
    // The conflicts array still carries the fields it always did — this asserts
    // only that the human-readable message does not restate them, because the
    // 409 body goes to whoever made the request (possibly a member adding
    // somebody else as a guest).
    const body = getBookingMemberNightConflictResponse([conflictRow()]);

    expect(body.error).not.toContain("Carol Nguyen");
    expect(body.error).not.toContain("booking-2");
    expect(body.error).not.toContain("payment pending");
  });

  it("names everyone and the union of the clashing nights when several members clash", () => {
    const body = getBookingMemberNightConflictResponse([
      conflictRow({ conflictingNights: ["2026-06-12"] }),
      conflictRow({
        memberId: "member-3",
        memberName: "Dana Patel",
        conflictingNights: ["2026-06-11"],
      }),
    ]);

    expect(body.error).toBe(
      "Bob Jones and Dana Patel are already on other bookings for 11 Jun 2026 and 12 Jun 2026. " +
        "Nobody can be on two bookings for the same night, so somebody has to come off one of the bookings.",
    );
  });

  it("agrees the verb with the number of PEOPLE, not the number of conflict rows", () => {
    // One member on two different clashing bookings inside the requested window
    // is two rows and one name — "Bob Jones are already" was reachable.
    const body = getBookingMemberNightConflictResponse([
      conflictRow({ bookingId: "booking-2", conflictingNights: ["2026-06-11"] }),
      conflictRow({ bookingId: "booking-3", conflictingNights: ["2026-06-12"] }),
    ]);

    expect(body.error).toContain(
      "Bob Jones is already on other bookings for 11 Jun 2026 and 12 Jun 2026.",
    );
    expect(body.error).not.toContain("Bob Jones are already");
  });
});
