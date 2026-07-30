import { describe, expect, it, vi } from "vitest";

/*
  #2263 (owner decision OD-A, as corrected in ADR-001's dated entry) — HOW a
  placeholder guest on an approved member whole-lodge booking becomes a
  member-rated guest.

  OD-A was ticked on the understanding that guests "re-rate per-guest as names
  and links are edited in". Review proved that path does not exist, and this file
  is the pin for what does. Two assertions, and they are load-bearing in opposite
  directions:

    1. There is NO in-place re-link. The guest-edit engine accepts name changes
       only, and refuses outright the moment an update targets a guest that is
       member-linked. That refusal is deliberate — a rename must never be able to
       quietly transfer who a booking is for (#1386's paid-name lock is the same
       instinct) — so it is pinned as intended behaviour, not worked around.

    2. A rename ALONE cannot re-rate. The resolved update carries names and only
       names, so nothing in it can reach the rate class. That is correct: a
       spelling fix does not change who the person is for pricing purposes.

  Together those two mean the only working route to a member rate is REMOVE the
  placeholder and ADD the real member as a guest, which prices the added guest at
  their own rate and settles the difference through the ordinary
  BookingModification refund/re-charge path. If somebody later adds a first-class
  link-and-re-rate path, assertion 1 fails and this file is the reviewable place
  the decision gets revisited.
*/

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: vi.fn() },
    member: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import {
  PAID_NAME_TYPO_ONLY_MESSAGE,
  resolveGuestNameUpdates,
} from "@/lib/booking-modify-plan";

/**
 * The shape an approved member whole-lodge booking has right after approval: a
 * party of unnamed, unlinked placeholders priced at non-member rates, plus (for
 * the refusal case) one guest who IS member-linked.
 */
function wholeLodgeBooking() {
  return {
    status: "CONFIRMED",
    finalPriceCents: 30000,
    // A PENDING internet-banking receivable — nothing paid, so the fully-paid
    // name lock is not what any of these assertions are about.
    payment: {
      status: "PENDING",
      amountCents: 30000,
      source: "INTERNET_BANKING",
    },
    guests: [
      {
        id: "guest-placeholder-1",
        firstName: "Guest",
        lastName: "1",
        isMember: false,
        memberId: null,
      },
      {
        id: "guest-member",
        firstName: "Ada",
        lastName: "Lovelace",
        isMember: true,
        memberId: "member-9",
      },
    ],
  } as never;
}

describe("OD-A: turning a whole-lodge placeholder into a member-rated guest (#2263)", () => {
  it("refuses any guest update that targets a member-linked guest — there is no in-place re-link", () => {
    expect(() =>
      resolveGuestNameUpdates({
        booking: wholeLodgeBooking(),
        input: {
          guestUpdates: [
            { guestId: "guest-member", firstName: "Ada", lastName: "Byron" },
          ],
        },
      }),
    ).toThrowError(/Member guest names cannot be edited on a booking/);
  });

  it("renames a placeholder without touching anything that could change its rate", () => {
    const updates = resolveGuestNameUpdates({
      booking: wholeLodgeBooking(),
      input: {
        guestUpdates: [
          {
            guestId: "guest-placeholder-1",
            firstName: "Grace",
            lastName: "Hopper",
          },
        ],
      },
    });

    expect(updates).toHaveLength(1);
    // The resolved update's ENTIRE field set is names (plus the previous names,
    // for the audit). There is no memberId, no isMember, no rate class, no
    // price: a rename is structurally incapable of re-rating the guest, which is
    // why remove-and-re-add is the mechanism and not an inconvenience.
    expect(Object.keys(updates[0]).sort()).toEqual(
      [
        "firstName",
        "guestId",
        "lastName",
        "previousFirstName",
        "previousLastName",
      ].sort(),
    );
    expect(updates[0]).toMatchObject({
      guestId: "guest-placeholder-1",
      firstName: "Grace",
      lastName: "Hopper",
      previousFirstName: "Guest",
      previousLastName: "1",
    });
  });

  it("refuses to rename and remove the same guest in one change, so remove-and-re-add stays an explicit two-part edit", () => {
    // The officer's working route is remove + add. This guard means they cannot
    // half-express it as "rename this one and also delete it", which would leave
    // the audit trail ambiguous about whether a person was replaced or renamed.
    expect(() =>
      resolveGuestNameUpdates({
        booking: wholeLodgeBooking(),
        input: {
          guestUpdates: [
            {
              guestId: "guest-placeholder-1",
              firstName: "Grace",
              lastName: "Hopper",
            },
          ],
          removeGuestIds: ["guest-placeholder-1"],
        },
      }),
    ).toThrowError(/cannot be renamed and removed in the same change/);
  });

  it("still refuses a free-text rename once the whole-lodge booking is fully paid", () => {
    // Once the member has paid the internet-banking invoice, the same lock every
    // other member booking has applies: only an identity-preserving typo fix.
    // So the money-moving route (remove-and-re-add) is also the only route to
    // change who is coming after payment, and it settles rather than silently
    // transferring the stay.
    const paid = wholeLodgeBooking() as unknown as {
      payment: { status: string; amountCents: number };
    };
    paid.payment.status = "SUCCEEDED";

    expect(() =>
      resolveGuestNameUpdates({
        booking: paid as never,
        input: {
          guestUpdates: [
            {
              guestId: "guest-placeholder-1",
              firstName: "Completely",
              lastName: "Different",
            },
          ],
        },
        allowTypoFixWhenFullyPaid: true,
      }),
    ).toThrowError(PAID_NAME_TYPO_ONLY_MESSAGE);
  });
});
