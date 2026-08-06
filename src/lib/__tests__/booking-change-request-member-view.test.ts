import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  MEMBER_BOOKING_CHANGE_REQUEST_COLUMNS,
  MEMBER_BOOKING_CHANGE_REQUEST_EXCLUDED_COLUMNS,
  memberBookingChangeRequestSelect,
} from "@/lib/booking-change-request-member-view";

/**
 * #2562 — the census behind the member-reachable `BookingChangeRequest` read.
 *
 * The leak this guards was not a typo: `GET /api/bookings/[id]/change-requests`
 * read the table with `include:` (every scalar column) and the table then gained
 * `internalNotes`, the officer's private note, which went straight to the member it
 * was written about. The manifest names every column either way; this test proves
 * the naming is EXHAUSTIVE, so the next column added to the model fails here until
 * somebody decides whether a member may read it.
 *
 * `Prisma.BookingChangeRequestScalarFieldEnum` is the authoritative universe: it
 * holds every stored field including the enum-typed ones (`status`, `kind`,
 * `aggregateCapacityMode`), which a DMMF filter on `kind === "scalar"` would miss
 * — that filter fails OPEN, and this one must fail closed.
 */
describe("member BookingChangeRequest column manifest", () => {
  const universe = Object.keys(
    Prisma.BookingChangeRequestScalarFieldEnum,
  ).sort();

  it("classifies every column on the model exactly once", () => {
    const classified = [
      ...MEMBER_BOOKING_CHANGE_REQUEST_COLUMNS,
      ...MEMBER_BOOKING_CHANGE_REQUEST_EXCLUDED_COLUMNS,
    ];
    expect([...classified].sort()).toEqual(universe);
    // Once, not twice: a column in both halves would read as excluded while the
    // select still returned it.
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("never returns the officer's internal note", () => {
    expect(MEMBER_BOOKING_CHANGE_REQUEST_EXCLUDED_COLUMNS).toContain(
      "internalNotes",
    );
    expect(MEMBER_BOOKING_CHANGE_REQUEST_COLUMNS).not.toContain(
      "internalNotes",
    );
    expect(memberBookingChangeRequestSelect).not.toHaveProperty(
      "internalNotes",
    );
  });

  it("still returns the officer's member-facing explanation", () => {
    // The mirror of the rule above: the split is only safe while the member CAN
    // read the decision explanation written for them.
    expect(memberBookingChangeRequestSelect).toHaveProperty("adminNotes", true);
  });

  it("selects every included column with a literal true", () => {
    expect(Object.keys(memberBookingChangeRequestSelect).sort()).toEqual(
      [...MEMBER_BOOKING_CHANGE_REQUEST_COLUMNS].sort(),
    );
    expect(
      Object.values(memberBookingChangeRequestSelect).every(
        (value) => value === true,
      ),
    ).toBe(true);
  });
});
