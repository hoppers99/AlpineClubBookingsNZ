import { describe, expect, it, vi } from "vitest";

/*
  #2263 (owner decision OD-A) / #2337 — HOW a placeholder guest on an approved
  member whole-lodge booking becomes a member-rated guest.

  This file used to pin "There is NO in-place re-link" as intended behaviour. That
  is no longer true: the owner chose (1 Aug 2026, quote-first) to build a
  first-class placeholder→member link that re-rates in place (#2337). So the file
  now pins the two halves of the CURRENT contract, and they are load-bearing in
  opposite directions:

    1. A RENAME still cannot re-rate. `resolveGuestNameUpdates` accepts name
       changes only, and refuses outright the moment an update targets a
       member-linked guest (`booking-modify-plan.ts:250-252`). That refusal is
       deliberate and UNTOUCHED by #2337 — a rename must never be able to quietly
       transfer who a booking is for (#1386's paid-name lock is the same instinct),
       and a rename is structurally incapable of reaching the rate class. The
       re-rate lives in a SEPARATE, narrowly gated operation, not in a loosened
       rename.

    2. The link is a first-class, narrowly gated sibling. `resolveGuestMemberLinks`
       admits a link ONLY when the actor is an admin/officer, the booking is a
       whole-lodge booking, and the target is an UNLINKED placeholder — never
       member→member. Loosen any one of those and an ineligible link would be
       admitted; each is pinned below.

  Together these mean the modify engine's member-guest refusal is reversed for the
  one narrow case the owner sanctioned, and for nothing else.
*/

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: vi.fn() },
    member: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import {
  GUEST_MEMBER_LINK_ADMIN_ONLY_MESSAGE,
  GUEST_MEMBER_LINK_ALREADY_ON_BOOKING_MESSAGE,
  GUEST_MEMBER_LINK_PLACEHOLDER_ONLY_MESSAGE,
  GUEST_MEMBER_LINK_WHOLE_LODGE_ONLY_MESSAGE,
  PAID_NAME_TYPO_ONLY_MESSAGE,
  resolveGuestMemberLinks,
  resolveGuestNameUpdates,
} from "@/lib/booking-modify-plan";

/**
 * The shape an approved member whole-lodge booking has right after approval: a
 * party of unnamed, unlinked placeholders priced at non-member rates, plus (for
 * the refusal case) one guest who IS member-linked. `wholeLodgeHold` is set,
 * because #2337's link is fenced to exactly this booking class.
 */
function wholeLodgeBooking() {
  return {
    status: "CONFIRMED",
    finalPriceCents: 30000,
    wholeLodgeHold: true,
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

describe("OD-A: a rename still cannot re-rate a whole-lodge placeholder (#2263, #1386)", () => {
  it("refuses any guest NAME update that targets a member-linked guest — :250-252 stays intact", () => {
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
    // why #2337's re-rate is a separate operation and not a loosened rename.
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

  it("still refuses a free-text rename once the whole-lodge booking is fully paid", () => {
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

describe("#2337: the placeholder→member link gate (resolveGuestMemberLinks)", () => {
  const link = [{ guestId: "guest-placeholder-1", memberId: "member-42" }];

  it("resolves a valid admin link on a whole-lodge booking to the placeholder's identity", () => {
    const links = resolveGuestMemberLinks({
      booking: wholeLodgeBooking(),
      input: { linkGuestToMember: link },
      role: "ADMIN",
    });
    expect(links).toEqual([
      {
        guestId: "guest-placeholder-1",
        memberId: "member-42",
        previousFirstName: "Guest",
        previousLastName: "1",
      },
    ]);
  });

  it("returns nothing when no link is requested — the resolver is inert on every other edit", () => {
    expect(
      resolveGuestMemberLinks({
        booking: wholeLodgeBooking(),
        input: {},
        role: "ADMIN",
      }),
    ).toEqual([]);
  });

  it("REFUSES a member-initiated link — the reversal is admin-only", () => {
    expect(() =>
      resolveGuestMemberLinks({
        booking: wholeLodgeBooking(),
        input: { linkGuestToMember: link },
        role: "USER",
      }),
    ).toThrowError(GUEST_MEMBER_LINK_ADMIN_ONLY_MESSAGE);
  });

  it("REFUSES a link on a booking that is not a whole-lodge hold — the narrow fence", () => {
    const ordinary = wholeLodgeBooking() as unknown as { wholeLodgeHold: boolean };
    ordinary.wholeLodgeHold = false;
    expect(() =>
      resolveGuestMemberLinks({
        booking: ordinary as never,
        input: { linkGuestToMember: link },
        role: "ADMIN",
      }),
    ).toThrowError(GUEST_MEMBER_LINK_WHOLE_LODGE_ONLY_MESSAGE);
  });

  it("REFUSES linking a guest that is ALREADY member-linked — never member→member", () => {
    expect(() =>
      resolveGuestMemberLinks({
        booking: wholeLodgeBooking(),
        input: {
          linkGuestToMember: [{ guestId: "guest-member", memberId: "member-42" }],
        },
        role: "ADMIN",
      }),
    ).toThrowError(GUEST_MEMBER_LINK_PLACEHOLDER_ONLY_MESSAGE);
  });

  it("REFUSES linking a guest that is also being removed in the same change", () => {
    expect(() =>
      resolveGuestMemberLinks({
        booking: wholeLodgeBooking(),
        input: {
          linkGuestToMember: link,
          removeGuestIds: ["guest-placeholder-1"],
        },
        role: "ADMIN",
      }),
    ).toThrowError(/cannot be linked and removed in the same change/);
  });

  it("REFUSES linking a guest that is also being renamed in the same change", () => {
    expect(() =>
      resolveGuestMemberLinks({
        booking: wholeLodgeBooking(),
        input: {
          linkGuestToMember: link,
          guestUpdates: [
            {
              guestId: "guest-placeholder-1",
              firstName: "Grace",
              lastName: "Hopper",
            },
          ],
        },
        role: "ADMIN",
      }),
    ).toThrowError(/cannot be renamed and linked in the same change/);
  });

  it("REFUSES linking the same member to two placeholders IN ONE REQUEST", () => {
    const twoPlaceholders = wholeLodgeBooking() as unknown as {
      guests: Array<{ id: string; firstName: string; lastName: string; isMember: boolean; memberId: string | null }>;
    };
    twoPlaceholders.guests.push({
      id: "guest-placeholder-2",
      firstName: "Guest",
      lastName: "2",
      isMember: false,
      memberId: null,
    });
    expect(() =>
      resolveGuestMemberLinks({
        booking: twoPlaceholders as never,
        input: {
          linkGuestToMember: [
            { guestId: "guest-placeholder-1", memberId: "member-42" },
            { guestId: "guest-placeholder-2", memberId: "member-42" },
          ],
        },
        role: "ADMIN",
      }),
    ).toThrowError(/same member cannot be linked to two guests/);
  });

  it("REFUSES linking a member who is ALREADY on the booking to another placeholder — the CROSS-REQUEST double-bill (#2337)", () => {
    // `guest-member` already carries member-9 (a prior committed link, or a
    // member guest placed at approval). Linking member-9 to a placeholder in a
    // SEPARATE request would bill the member rate twice. The within-request
    // `seenMemberIds` guard cannot see it, and the person-night conflict check
    // excludes THIS booking, so only the existing-row guard catches it. On the
    // apply path `booking.guests` is the post-lock re-read, so this same guard is
    // the in-transaction re-check that closes a concurrent double-link.
    expect(() =>
      resolveGuestMemberLinks({
        booking: wholeLodgeBooking(),
        input: {
          linkGuestToMember: [
            { guestId: "guest-placeholder-1", memberId: "member-9" },
          ],
        },
        role: "ADMIN",
      }),
    ).toThrowError(GUEST_MEMBER_LINK_ALREADY_ON_BOOKING_MESSAGE);
  });

  it("REFUSES a link to a guest that is not on the booking", () => {
    expect(() =>
      resolveGuestMemberLinks({
        booking: wholeLodgeBooking(),
        input: {
          linkGuestToMember: [{ guestId: "ghost", memberId: "member-42" }],
        },
        role: "ADMIN",
      }),
    ).toThrowError(/guest not found on this booking/);
  });
});
