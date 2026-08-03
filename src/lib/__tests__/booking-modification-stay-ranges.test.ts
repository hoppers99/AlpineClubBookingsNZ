import { describe, expect, it } from "vitest";

import { parseDateOnly } from "@/lib/date-only";
import {
  deltaHasStayRangeInputs,
  resolveModificationStayRanges,
} from "@/lib/booking-modification-stay-ranges";
import { buildModificationProposalParties } from "@/lib/booking-exception-request-service";

/**
 * The contract that makes the booking-policy exception workflow sound (#2526):
 * the party frozen for an officer to review is the party the canonical
 * modification planner will build from the same delta.
 *
 * These tests drive the SHARED resolver — the one `resolveTargetDates` and
 * `prepareGuestPlan` now call — and compare it against the frozen proposal, so a
 * future change that moves one and not the other reddens here rather than
 * shipping a proposal nobody executed.
 */

const BOOKING_CHECK_IN = parseDateOnly("2026-08-01");
const BOOKING_CHECK_OUT = parseDateOnly("2026-08-03");

function guest(id: string, start: string, end: string, nights?: string[]) {
  return {
    id,
    firstName: id.toUpperCase(),
    lastName: "Guest",
    ageTier: "ADULT",
    isMember: false,
    memberId: null,
    stayStart: parseDateOnly(start),
    stayEnd: parseDateOnly(end),
    ...(nights
      ? { nights: nights.map((night) => ({ stayDate: parseDateOnly(night) })) }
      : {}),
  };
}

/** The nights the frozen proposal claims for each guest, by guest name. */
function frozenNightsByGuest(
  liveGuests: ReturnType<typeof guest>[],
  delta: Parameters<typeof buildModificationProposalParties>[0]["delta"],
) {
  const { proposed } = buildModificationProposalParties({
    bookingCheckIn: BOOKING_CHECK_IN,
    bookingCheckOut: BOOKING_CHECK_OUT,
    liveGuests,
    delta,
  });
  return {
    envelope: [proposed.checkIn, proposed.checkOut],
    byGuest: Object.fromEntries(
      proposed.guests.map((g) => [`${g.firstName} ${g.lastName}`, g.nights]),
    ),
  };
}

describe("the global range-input flag decides the whole request", () => {
  it("switches on ANY range anywhere, and on nothing else", () => {
    // The one predicate the whole resolution hinges on, pinned as a table so the
    // "any range anywhere" reading cannot quietly narrow to "any range on THIS
    // guest" — which is the shape of the bug this module was written to close.
    // A range entry that carries no dates and no nights is NOT a range input.
    // `resolvable: false` marks an input the predicate accepts as a range input
    // but the resolver then REFUSES (a half-supplied range) — the refusal itself
    // is pinned further down. Everything else is resolved as well, so the flag the
    // resolver acted on is checked against the predicate that decided it.
    const cases: Array<[Record<string, unknown>, boolean, boolean?]> = [
      [{}, false],
      [{ guestStayRanges: [{ guestId: "a" }] }, false],
      [{ addGuests: [{}] }, false],
      [{ checkIn: "2026-08-02", checkOut: "2026-08-05" }, false],
      [
        {
          guestStayRanges: [
            { guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-02" },
          ],
        },
        true,
      ],
      [{ guestStayRanges: [{ guestId: "a", stayStart: "2026-08-01" }] }, true, false],
      [{ guestStayRanges: [{ guestId: "a", nights: ["2026-08-02"] }] }, true],
      [{ addGuests: [{ stayStart: "2026-08-01", stayEnd: "2026-08-04" }] }, true],
      // A range on a guest who is NOT the one being asked about still switches
      // the mode for everybody.
      [
        {
          removeGuestIds: ["z"],
          guestStayRanges: [
            { guestId: "z", stayStart: "2026-08-01", stayEnd: "2026-08-02" },
          ],
        },
        true,
      ],
    ];
    for (const [input, expected, resolvable = true] of cases) {
      expect(deltaHasStayRangeInputs(input as never), JSON.stringify(input)).toBe(
        expected,
      );
      if (!resolvable) continue;
      // And the resolver reports the same flag it acted on.
      const resolved = resolveModificationStayRanges({
        booking: { checkIn: BOOKING_CHECK_IN, checkOut: BOOKING_CHECK_OUT },
        guests: [guest("a", "2026-08-01", "2026-08-03")],
        input: input as never,
      });
      expect(resolved.hasRangeInputs, JSON.stringify(input)).toBe(expected);
    }
  });

  it("a dates change WITH a partial range leaves the other guests on their stored nights", () => {
    // THE DIVERGENCE THAT MADE THIS MODULE NECESSARY. The old frozen model reset
    // every guest with no range entry to the new envelope whenever the dates
    // moved; the planner keeps them on their stored nights because SOME range
    // input was supplied. An officer therefore approved a 3-guest x 3-night party
    // and the execution built 3 + 2 + 2 guest-nights: a different party, a
    // different price, and a hosting/minimum-stay judgement made on a party that
    // was never created.
    const liveGuests = [
      guest("a", "2026-08-01", "2026-08-03"),
      guest("b", "2026-08-01", "2026-08-03"),
      guest("c", "2026-08-01", "2026-08-03"),
    ];
    const delta = {
      checkOut: "2026-08-04",
      guestStayRanges: [
        { guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-04" },
      ],
    };

    const resolved = resolveModificationStayRanges({
      booking: { checkIn: BOOKING_CHECK_IN, checkOut: BOOKING_CHECK_OUT },
      guests: liveGuests,
      input: delta,
    });
    expect(resolved.hasRangeInputs).toBe(true);
    // Only guest A moved; B and C kept their stored two nights.
    expect(resolved.remaining.map((entry) => entry.guest.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(resolved.remaining[1].stayEnd.toISOString().slice(0, 10)).toBe(
      "2026-08-03",
    );
    expect(resolved.remaining[2].stayEnd.toISOString().slice(0, 10)).toBe(
      "2026-08-03",
    );

    // And the FROZEN proposal says exactly the same thing.
    const frozen = frozenNightsByGuest(liveGuests, delta);
    expect(frozen.byGuest["A Guest"]).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(frozen.byGuest["B Guest"]).toEqual(["2026-08-01", "2026-08-02"]);
    expect(frozen.byGuest["C Guest"]).toEqual(["2026-08-01", "2026-08-02"]);
    // 7 guest-nights, not 9.
    expect(
      Object.values(frozen.byGuest).reduce((sum, nights) => sum + nights.length, 0),
    ).toBe(7);
  });

  it("a dates change with NO range input DOES reset every remaining guest", () => {
    // The other branch, unchanged: without any range input a date move resets
    // everybody, which is the behaviour the planner has always had.
    const liveGuests = [
      guest("a", "2026-08-01", "2026-08-03"),
      guest("b", "2026-08-01", "2026-08-03"),
    ];
    const frozen = frozenNightsByGuest(liveGuests, { checkOut: "2026-08-04" });
    expect(frozen.envelope).toEqual(["2026-08-01", "2026-08-04"]);
    expect(frozen.byGuest["A Guest"]).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(frozen.byGuest["B Guest"]).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });
});

describe("a stored sparse night set survives the freeze", () => {
  it("preserves the gap instead of flattening it to the envelope", () => {
    // The old model expanded stayStart..stayEnd, so a guest booked for the 1st
    // and the 3rd was frozen as staying the 1st, 2nd AND 3rd — claiming a bed on
    // a night the execution never books, and pricing it.
    const sparse = guest("a", "2026-08-01", "2026-08-04", [
      "2026-08-01",
      "2026-08-03",
    ]);
    const frozen = frozenNightsByGuest([sparse], {});
    expect(frozen.byGuest["A Guest"]).toEqual(["2026-08-01", "2026-08-03"]);
  });

  it("still resets a sparse guest when a bare date change resets everybody", () => {
    const sparse = guest("a", "2026-08-01", "2026-08-04", [
      "2026-08-01",
      "2026-08-03",
    ]);
    const frozen = frozenNightsByGuest([sparse], { checkOut: "2026-08-02" });
    expect(frozen.byGuest["A Guest"]).toEqual(["2026-08-01"]);
  });
});

describe("the envelope expands to cover the resolved ranges", () => {
  it("widens past the requested check-out when a guest range reaches further", () => {
    const resolved = resolveModificationStayRanges({
      booking: { checkIn: BOOKING_CHECK_IN, checkOut: BOOKING_CHECK_OUT },
      guests: [guest("a", "2026-08-01", "2026-08-03")],
      input: {
        guestStayRanges: [
          { guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-10" },
        ],
      },
    });
    expect(resolved.checkOut.toISOString().slice(0, 10)).toBe("2026-08-10");
    expect(resolved.datesChanged).toBe(true);
  });

  it("leaves the envelope alone when no range input is supplied", () => {
    const resolved = resolveModificationStayRanges({
      booking: { checkIn: BOOKING_CHECK_IN, checkOut: BOOKING_CHECK_OUT },
      guests: [guest("a", "2026-08-01", "2026-08-03")],
      input: {},
    });
    expect(resolved.hasRangeInputs).toBe(false);
    expect(resolved.datesChanged).toBe(false);
    expect(resolved.checkIn.getTime()).toBe(BOOKING_CHECK_IN.getTime());
    expect(resolved.checkOut.getTime()).toBe(BOOKING_CHECK_OUT.getTime());
  });
});

describe("a delta the canonical planner would refuse is refused at freeze time", () => {
  it("throws on a half-supplied range rather than completing it from the envelope", () => {
    // `normalizeGuestStayRange` refuses a Date In with no Date Out, so the
    // canonical service would answer 400. The old model silently filled the
    // missing half from the new envelope and froze a proposal that could never be
    // executed.
    expect(() =>
      buildModificationProposalParties({
        bookingCheckIn: BOOKING_CHECK_IN,
        bookingCheckOut: BOOKING_CHECK_OUT,
        liveGuests: [guest("a", "2026-08-01", "2026-08-03")],
        delta: { guestStayRanges: [{ guestId: "a", stayStart: "2026-08-02" }] },
      }),
    ).toThrow(/both required/i);
  });

  it("treats a range entry with BOTH sides absent as no range at all", () => {
    // `{ guestId }` with nothing on it is not a range input, so the request stays
    // in the no-range branch — which is what the planner's predicate says too.
    const liveGuests = [guest("a", "2026-08-01", "2026-08-03")];
    const frozen = frozenNightsByGuest(liveGuests, {
      checkOut: "2026-08-04",
      guestStayRanges: [{ guestId: "a" }],
    });
    expect(frozen.byGuest["A Guest"]).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });
});

describe("removals and additions", () => {
  it("drops removed guests and lands added ones on the resolved envelope", () => {
    const liveGuests = [
      guest("a", "2026-08-01", "2026-08-03"),
      guest("b", "2026-08-01", "2026-08-03"),
    ];
    const frozen = frozenNightsByGuest(liveGuests, {
      removeGuestIds: ["b"],
      addGuests: [
        {
          firstName: "New",
          lastName: "Person",
          ageTier: "ADULT",
          isMember: false,
        },
      ],
    });
    expect(Object.keys(frozen.byGuest).sort()).toEqual(["A Guest", "New Person"]);
    expect(frozen.byGuest["New Person"]).toEqual(["2026-08-01", "2026-08-02"]);
  });

  it("does not let a removed guest's stored range widen the envelope", () => {
    const resolved = resolveModificationStayRanges({
      booking: { checkIn: BOOKING_CHECK_IN, checkOut: BOOKING_CHECK_OUT },
      guests: [
        guest("a", "2026-08-01", "2026-08-03"),
        guest("b", "2026-08-01", "2026-08-20"),
      ],
      input: {
        removeGuestIds: ["b"],
        guestStayRanges: [
          { guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-03" },
        ],
      },
    });
    expect(resolved.checkOut.toISOString().slice(0, 10)).toBe("2026-08-03");
  });
});
