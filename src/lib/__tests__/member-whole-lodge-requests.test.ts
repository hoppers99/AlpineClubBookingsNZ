import { describe, expect, it } from "vitest";
import { BookingRequestStatus } from "@prisma/client";
import {
  MEMBER_WHOLE_LODGE_OPEN_STATUSES,
  toMyWholeLodgeRequestItem,
  toMyWholeLodgeRequestStatus,
  type MyWholeLodgeRequestStatus,
} from "@/lib/member-whole-lodge-requests";

/*
  #2263 — the member-facing projection of a whole-lodge booking request.

  Two things are pinned here, and both are privacy properties rather than
  presentation ones.

  1. THE ALLOWLIST IS EXACT. The DTO's key set is asserted whole, so a field
     added to the mapper shows up as a failing test rather than as a value on a
     member's screen. `declineReason` is the specific field this guards: on a
     member-origin request the officer's note is never even persisted, and this
     makes sure no future refactor reintroduces a path for it.

  2. EVERY STATUS MAPS TO ONE OF FOUR WORDS. The raw pipeline statuses are an
     ADMIN-ACTIVITY ORACLE. "PRICED" tells a member an officer has started
     costing their dates; "QUOTE_SENT" tells them a decision is imminent. On a
     WHOLE-LODGE request that shades into information about the calendar, which
     is the one thing ADR-001 decision 6 says a member is never given. The test
     iterates the enum itself, so a status added later is covered without anyone
     remembering to add a case.
*/

const ALLOWED_LABELS: MyWholeLodgeRequestStatus[] = [
  "pending",
  "approved",
  "declined",
  "withdrawn",
];

const BASE_ROW = {
  id: "req-1",
  status: BookingRequestStatus.VERIFIED,
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-05T00:00:00.000Z"),
  createdAt: new Date("2026-07-20T03:04:05.000Z"),
  convertedBookingId: null as string | null,
  heldBookingId: null as string | null,
  guestCount: 12,
};

describe("member whole-lodge request DTO (#2263)", () => {
  it("carries exactly the allowlisted keys and nothing else", () => {
    const item = toMyWholeLodgeRequestItem(BASE_ROW);

    expect(Object.keys(item).sort()).toEqual(
      [
        "bookingId",
        "canWithdraw",
        "checkIn",
        "checkOut",
        "createdAt",
        "headcount",
        "id",
        "status",
      ].sort(),
    );
  });

  it("never carries the officer's decline note, conflicts, holds, prices or admin identities", () => {
    const item = toMyWholeLodgeRequestItem({
      ...BASE_ROW,
      status: BookingRequestStatus.DECLINED,
    }) as Record<string, unknown>;

    for (const forbidden of [
      "declineReason",
      "responseMessage",
      "reviewedByMemberId",
      "pricedByMemberId",
      "priceCents",
      "indicativePriceCents",
      "heldBookingId",
      "exclusiveHoldConflicts",
      "contactEmail",
      "message",
    ]) {
      expect(item, `${forbidden} must never reach a member`).not.toHaveProperty(
        forbidden,
      );
    }
  });

  it("maps every BookingRequestStatus to one of the four member-visible words", () => {
    const statuses = Object.values(BookingRequestStatus);
    // Guard against the enum being empty/mocked away, which would make the loop
    // below vacuously pass.
    expect(statuses.length).toBeGreaterThan(5);

    for (const status of statuses) {
      const label = toMyWholeLodgeRequestStatus(status);
      expect(
        ALLOWED_LABELS,
        `${status} mapped to "${label}", which is not one of the four words a member may see`,
      ).toContain(label);
    }
  });

  it("collapses every mid-pipeline status to Pending, so admin activity is not observable", () => {
    for (const status of [
      BookingRequestStatus.NEW,
      BookingRequestStatus.VERIFIED,
      BookingRequestStatus.PRICED,
      BookingRequestStatus.QUOTED,
      BookingRequestStatus.QUOTE_SENT,
      BookingRequestStatus.QUERY_PENDING,
      BookingRequestStatus.MODIFICATION_REQUESTED,
    ]) {
      expect(toMyWholeLodgeRequestStatus(status)).toBe("pending");
    }
  });

  it("links to the booking only once the conversion has actually committed", () => {
    // APPROVED with no converted booking is the instant before the row commits.
    expect(
      toMyWholeLodgeRequestItem({
        ...BASE_ROW,
        status: BookingRequestStatus.APPROVED,
        convertedBookingId: null,
      }),
    ).toMatchObject({ status: "approved", bookingId: null });

    expect(
      toMyWholeLodgeRequestItem({
        ...BASE_ROW,
        status: BookingRequestStatus.CONVERTED,
        convertedBookingId: "booking-9",
      }),
    ).toMatchObject({ status: "approved", bookingId: "booking-9" });
  });

  it("offers withdraw only for a request the withdraw API will actually accept", () => {
    expect(toMyWholeLodgeRequestItem(BASE_ROW).canWithdraw).toBe(true);

    // Mirrors the service guard: a request holding beds must go through admin
    // decline, which releases the hold. Offering a button the API refuses is
    // worse than offering none.
    expect(
      toMyWholeLodgeRequestItem({ ...BASE_ROW, heldBookingId: "booking-held" })
        .canWithdraw,
    ).toBe(false);

    // EXHAUSTIVE over the enum, driven off the one open-status list the
    // service's guarded claim names. The affordance used to be derived from
    // "the member-visible status reads as pending", which is a DIFFERENT
    // predicate: NEW and ACCEPTED both read as "pending" and are both outside
    // the claim's status set, so both rendered a Withdraw button that the API
    // answered with a 409. This walk fails if that drift is ever reintroduced,
    // for any status, in either direction.
    for (const status of Object.values(BookingRequestStatus)) {
      const expected = MEMBER_WHOLE_LODGE_OPEN_STATUSES.includes(
        status as (typeof MEMBER_WHOLE_LODGE_OPEN_STATUSES)[number],
      );
      expect(
        toMyWholeLodgeRequestItem({ ...BASE_ROW, status }).canWithdraw,
        `${status}: canWithdraw must match whether the withdraw claim accepts it`,
      ).toBe(expected);
    }

    // Named explicitly, because these two are the exact regression: they read as
    // "pending" to the member and are NOT withdrawable.
    for (const status of [
      BookingRequestStatus.NEW,
      BookingRequestStatus.ACCEPTED,
    ]) {
      const item = toMyWholeLodgeRequestItem({ ...BASE_ROW, status });
      expect(item.status).toBe("pending");
      expect(item.canWithdraw, `${status} must not offer withdraw`).toBe(false);
    }
  });

  it("renders dates as NZ date-only strings, never timestamps", () => {
    const item = toMyWholeLodgeRequestItem(BASE_ROW);
    expect(item.checkIn).toBe("2026-08-01");
    expect(item.checkOut).toBe("2026-08-05");
  });
});
