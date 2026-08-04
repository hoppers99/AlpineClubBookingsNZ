import { describe, expect, it } from "vitest";

import { POLICY_EXCEPTION_REQUEST_STATUSES } from "@/lib/booking-exception-requests";
import { POLICY_EXCEPTION_REASON_CODES } from "@/lib/booking-policy-exceptions";
import {
  MEMBER_EXCEPTION_RULE_LABELS,
  MEMBER_EXCEPTION_STATUS_EXPLANATIONS,
  MEMBER_EXCEPTION_STATUS_LABELS,
  memberExceptionCapacityWording,
  memberExceptionSubmitCapacityWording,
  toMemberExceptionProposal,
  toMemberExceptionRequestItem,
  toMemberExceptionRequestStatus,
  toMemberExceptionRules,
} from "@/lib/member-exception-requests";

/**
 * #2562 — the ONE place a policy-exception request row becomes something a member
 * may see.
 *
 * Three things are pinned here, and two of them are privacy rules: the officer's
 * internal note has no route to a member surface; a REQUESTED row that an officer
 * has already tried and the lodge stopped reads as a capacity wait rather than as
 * undecided; and the capacity answer comes from what the request ACTUALLY reserves
 * rather than from the policy's intent.
 */

const NEW_BOOKING_SNAPSHOT = {
  kind: "NEW_BOOKING",
  lodgeId: "lodge-1",
  proposed: {
    checkIn: "2026-07-03",
    checkOut: "2026-07-05",
    guests: [
      {
        firstName: "Sam",
        lastName: "Skier",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        nights: ["2026-07-03", "2026-07-04"],
      },
      {
        firstName: "Robin",
        lastName: "Visitor",
        ageTier: "YOUTH",
        isMember: false,
        memberId: null,
        nights: ["2026-07-04"],
      },
    ],
  },
};

const MODIFICATION_SNAPSHOT = {
  kind: "MODIFICATION",
  lodgeId: "lodge-1",
  bookingId: "booking-1",
  base: {
    checkIn: "2026-08-01",
    checkOut: "2026-08-03",
    guests: [
      {
        firstName: "Sam",
        lastName: "Skier",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        nights: ["2026-08-01", "2026-08-02"],
      },
    ],
  },
  proposed: {
    checkIn: "2026-08-01",
    checkOut: "2026-08-02",
    guests: [
      {
        firstName: "Sam",
        lastName: "Skier",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        nights: ["2026-08-01"],
      },
    ],
  },
};

const FROZEN_EVIDENCE = {
  reasonCodes: ["MINIMUM_STAY"],
  violations: [
    {
      reasonCode: "MINIMUM_STAY",
      message: "Friday nights need a two-night booking.",
      affectedNights: ["2026-07-03"],
      exceptionEligible: true,
      capacityMode: "HOLD",
    },
  ],
};

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    source: "NEW_BOOKING" as const,
    status: "REQUESTED" as const,
    createdAt: new Date("2026-07-01T10:00:00Z"),
    reviewedAt: null,
    proposalSnapshot: NEW_BOOKING_SNAPSHOT,
    frozenEvidence: FROZEN_EVIDENCE,
    memberMessage: "Driving up after work on Friday.",
    adminNotes: null,
    lastConflictReason: null,
    lastConflictAt: null,
    bookingId: null,
    createdBookingId: null,
    supersededByRequestId: null,
    holdsReservationNights: false,
    // The frozen aggregate every stored row carries. NO_HOLD here because the
    // default fixture is a new-booking request, which reserves nothing.
    aggregateCapacityMode: "NO_HOLD" as const,
    ...overrides,
  };
}

describe("toMemberExceptionRequestStatus", () => {
  it("classifies every stored status, and splits REQUESTED on a recorded conflict", () => {
    expect(toMemberExceptionRequestStatus("REQUESTED", false)).toBe("pending");
    expect(toMemberExceptionRequestStatus("REQUESTED", true)).toBe(
      "pending-capacity-conflict",
    );
    expect(toMemberExceptionRequestStatus("APPROVED", false)).toBe("approved");
    expect(toMemberExceptionRequestStatus("REJECTED", false)).toBe("refused");
    expect(toMemberExceptionRequestStatus("CANCELLED", false)).toBe("withdrawn");
    expect(toMemberExceptionRequestStatus("SUPERSEDED", false)).toBe("superseded");
    expect(toMemberExceptionRequestStatus("EXPIRED", false)).toBe("expired");
  });

  it("covers the whole stored lifecycle, so a new status cannot default into a word", () => {
    // The `never` check in the mapper is the compile-time half of this; running the
    // full status list through it is the runtime half.
    for (const status of POLICY_EXCEPTION_REQUEST_STATUSES) {
      expect(() => toMemberExceptionRequestStatus(status, false)).not.toThrow();
      expect(
        MEMBER_EXCEPTION_STATUS_LABELS[
          toMemberExceptionRequestStatus(status, false)
        ],
      ).toBeTruthy();
      expect(
        MEMBER_EXCEPTION_STATUS_EXPLANATIONS[
          toMemberExceptionRequestStatus(status, false)
        ],
      ).toBeTruthy();
    }
  });

  it("never reads a conflict on a decided row as a live capacity wait", () => {
    const refused = toMemberExceptionRequestItem(
      baseRow({
        status: "REJECTED",
        lastConflictAt: new Date("2026-07-05T00:00:00Z"),
        lastConflictReason: "The lodge is full.",
      }),
    );
    // The officer decided; an old conflict is history, not the current state.
    expect(refused.status).toBe("refused");
  });
});

describe("toMemberExceptionProposal", () => {
  it("reads the exact frozen new-booking proposal, including the guest-night total", () => {
    const proposal = toMemberExceptionProposal(NEW_BOOKING_SNAPSHOT);
    expect(proposal.lodgeId).toBe("lodge-1");
    expect(proposal.checkIn).toBe("2026-07-03");
    expect(proposal.checkOut).toBe("2026-07-05");
    expect(proposal.guests).toHaveLength(2);
    // 2 nights + 1 night: the allocation, not the headcount.
    expect(proposal.guestNights).toBe(3);
    // A new booking has no base to change from.
    expect(proposal.baseCheckIn).toBeNull();
    expect(proposal.baseGuestNights).toBeNull();
  });

  it("reads a modification's base alongside its proposal, so the member sees the change", () => {
    const proposal = toMemberExceptionProposal(MODIFICATION_SNAPSHOT);
    expect(proposal.baseCheckIn).toBe("2026-08-01");
    expect(proposal.baseCheckOut).toBe("2026-08-03");
    expect(proposal.baseGuestNights).toBe(2);
    expect(proposal.guestNights).toBe(1);
  });

  it("carries no member ids through to the member view", () => {
    // The member sees names and nights. Ids are internal handles and nothing on a
    // member screen needs them, so the DTO simply does not have the field.
    const proposal = toMemberExceptionProposal(NEW_BOOKING_SNAPSHOT);
    expect(JSON.stringify(proposal)).not.toContain("m1");
  });

  it("survives an unreadable snapshot with an empty party rather than throwing", () => {
    for (const input of [null, undefined, "not json", [], 7, {}]) {
      const proposal = toMemberExceptionProposal(input);
      expect(proposal.guests).toEqual([]);
      expect(proposal.guestNights).toBe(0);
      expect(proposal.checkIn).toBeNull();
    }
  });

  it("drops a guest entry that is not a readable guest, rather than rendering a blank", () => {
    const proposal = toMemberExceptionProposal({
      lodgeId: "lodge-1",
      proposed: {
        checkIn: "2026-07-03",
        checkOut: "2026-07-04",
        guests: [
          { firstName: "Sam", lastName: "Skier", ageTier: "ADULT", nights: ["2026-07-03"] },
          { firstName: 42, lastName: null },
          null,
        ],
      },
    });
    expect(proposal.guests).toHaveLength(1);
    expect(proposal.guests[0].firstName).toBe("Sam");
    // `isMember` defaults to false rather than undefined: a missing flag must not
    // render as "member".
    expect(proposal.guests[0].isMember).toBe(false);
  });
});

describe("toMemberExceptionRules", () => {
  it("carries every covered rule with its own frozen sentence and nights", () => {
    const rules = toMemberExceptionRules(FROZEN_EVIDENCE);
    expect(rules).toEqual([
      {
        reasonCode: "MINIMUM_STAY",
        message: "Friday nights need a two-night booking.",
        affectedNights: ["2026-07-03"],
      },
    ]);
  });

  it("returns nothing for unreadable evidence", () => {
    for (const input of [null, undefined, {}, [], "x", { violations: "no" }]) {
      expect(toMemberExceptionRules(input)).toEqual([]);
    }
  });

  it("has a member-facing label for every #2363 allowlisted reason code", () => {
    // Typed against the union, so this is really pinning that the labels are
    // populated as well as present.
    for (const code of POLICY_EXCEPTION_REASON_CODES) {
      expect(MEMBER_EXCEPTION_RULE_LABELS[code]).toBeTruthy();
    }
  });
});

describe("toMemberExceptionRequestItem — the privacy boundary", () => {
  it("carries the officer's MEMBER-FACING explanation", () => {
    const item = toMemberExceptionRequestItem(
      baseRow({ status: "REJECTED", adminNotes: "Not that weekend, sorry." }),
    );
    expect(item.decisionExplanation).toBe("Not that weekend, sorry.");
  });

  it("has no field for the internal note, and cannot be handed one", () => {
    const item = toMemberExceptionRequestItem(baseRow());
    expect(Object.keys(item)).not.toContain("internalNotes");
    // The input type does not accept `internalNotes`, so a caller passing it is a
    // typecheck failure. Cast here only to prove the runtime mapper drops it too:
    // it names every field it copies and never spreads the row.
    const withNote = toMemberExceptionRequestItem({
      ...baseRow(),
      internalNotes: "This member asks every single season.",
    } as never);
    expect(JSON.stringify(withNote)).not.toContain("every single season");
  });
});

describe("toMemberExceptionRequestItem — capacity and the lifecycle actions", () => {
  it("reports capacity from the reservation fact, not the policy's mode", () => {
    expect(
      toMemberExceptionRequestItem(baseRow({ holdsReservationNights: false }))
        .capacityHeld,
    ).toBe(false);
    expect(
      toMemberExceptionRequestItem(
        baseRow({ source: "MODIFICATION", holdsReservationNights: true }),
      ).capacityHeld,
    ).toBe(true);
  });

  it("offers withdraw and replace only while the request is open", () => {
    const open = toMemberExceptionRequestItem(baseRow());
    expect(open.canWithdraw).toBe(true);
    expect(open.canReplace).toBe(true);
    for (const status of ["APPROVED", "REJECTED", "CANCELLED", "SUPERSEDED", "EXPIRED"] as const) {
      const decided = toMemberExceptionRequestItem(baseRow({ status }));
      expect(decided.canWithdraw).toBe(false);
      expect(decided.canReplace).toBe(false);
    }
  });

  it("links to the created booking only once the request really executed", () => {
    // An APPROVED row is only ever written in the same transaction as the booking,
    // so this is belt and braces — but the alternative is a dead link on a row that
    // has no booking behind it.
    expect(
      toMemberExceptionRequestItem(
        baseRow({ status: "APPROVED", createdBookingId: "booking-9" }),
      ).createdBookingId,
    ).toBe("booking-9");
    expect(
      toMemberExceptionRequestItem(
        baseRow({ status: "REQUESTED", createdBookingId: "booking-9" }),
      ).createdBookingId,
    ).toBeNull();
  });
});

describe("capacity wording", () => {
  it("promises nothing on a pending new-booking request, whatever the mode says", () => {
    for (const capacityMode of ["HOLD", "NO_HOLD", null] as const) {
      const submit = memberExceptionSubmitCapacityWording({
        source: "NEW_BOOKING",
        capacityMode,
      });
      expect(submit).toContain("No beds are held");
      expect(submit).toContain("checked again");
    }
    const listed = memberExceptionCapacityWording({
      source: "NEW_BOOKING",
      status: "pending",
      capacityHeld: false,
    });
    expect(listed).toContain("No beds are held");
  });

  it("states the modification's real hold, and never a generic promise", () => {
    expect(
      memberExceptionCapacityWording({
        source: "MODIFICATION",
        status: "pending",
        capacityHeld: true,
        capacityMode: "HOLD",
      }),
    ).toContain("held while it waits");
    expect(
      memberExceptionCapacityWording({
        source: "MODIFICATION",
        status: "pending",
        capacityHeld: false,
        capacityMode: "HOLD",
      }),
    ).toContain("no extra beds");
  });

  /**
   * The reason the frozen mode is carried at all. "Nothing is held" has two
   * causes and only one of them means "this change needs nothing":
   *
   *  - HOLD with an empty footprint — a pure shrink. Nothing is needed, so
   *    nothing is held, and the member has nothing to race for.
   *  - NO_HOLD — the rule holds nothing whatever the change needs, so the member
   *    may well be racing a filling lodge and must be told so.
   *
   * Deciding on `capacityHeld` alone asserted the first about both.
   */
  it("never tells a NO_HOLD modification that it needs no extra beds", () => {
    const noHold = memberExceptionCapacityWording({
      source: "MODIFICATION",
      status: "pending",
      capacityHeld: false,
      capacityMode: "NO_HOLD",
    });
    expect(noHold).not.toMatch(/needs no extra beds/);
    expect(noHold).toContain("could fill before it is decided");
    expect(noHold).toContain("cannot be approved");

    // Mode unknown to the caller: say only what is certainly true — nothing is
    // held — and never the "needs none" claim.
    const unknown = memberExceptionCapacityWording({
      source: "MODIFICATION",
      status: "pending",
      capacityHeld: false,
      capacityMode: null,
    });
    expect(unknown).not.toMatch(/needs no extra beds/);
    expect(unknown).toContain("No extra beds are held");
  });

  it("says approval can never put the lodge over capacity, on both submit paths", () => {
    for (const source of ["NEW_BOOKING", "MODIFICATION"] as const) {
      for (const capacityMode of ["HOLD", "NO_HOLD"] as const) {
        const wording = memberExceptionSubmitCapacityWording({ source, capacityMode });
        expect(wording.toLowerCase()).toMatch(
          /cannot be approved|never put the lodge over capacity/,
        );
      }
    }
  });

  it("tells a capacity-conflicted request the lodge was full, not that nobody looked", () => {
    const wording = memberExceptionCapacityWording({
      source: "NEW_BOOKING",
      status: "pending-capacity-conflict",
      capacityHeld: false,
    });
    expect(wording).toContain("full");
    expect(MEMBER_EXCEPTION_STATUS_EXPLANATIONS["pending-capacity-conflict"]).toContain(
      "did not have room",
    );
    // And the plain pending sentence must NOT claim anybody has looked.
    expect(MEMBER_EXCEPTION_STATUS_EXPLANATIONS.pending).toContain(
      "has not decided yet",
    );
  });

  it("stops promising held beds the moment a request is no longer open", () => {
    for (const status of ["refused", "withdrawn", "superseded"] as const) {
      expect(
        memberExceptionCapacityWording({
          source: "MODIFICATION",
          status,
          capacityHeld: true,
        }),
      ).toContain("No beds are held");
    }
    expect(
      memberExceptionCapacityWording({
        source: "MODIFICATION",
        status: "expired",
        capacityHeld: false,
      }),
    ).toContain("ran out");
  });
});
