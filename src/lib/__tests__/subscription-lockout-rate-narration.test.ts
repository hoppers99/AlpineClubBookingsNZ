import { describe, expect, it } from "vitest";

/**
 * #2543 — the two places a repriced member's RATE has to be visible in the record
 * rather than contradicted by it: the Xero invoice line's wording, and the
 * per-guest rate snapshot an edit is allowed to overwrite.
 *
 * Neither is a new money path. The first is narration on a line whose amount, item
 * code and account code do not move; the second decides whether a stored snapshot
 * is left alone. Both were found by review as places where the reprice told the
 * truth about the cents and a lie about everything else.
 */

import {
  describeGuestRateMembershipLabel,
  type HutFeeItemCodeResolver,
} from "@/lib/xero-mappings";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoices";
import { rateSnapshotUpdateForRepricedGuest } from "@/lib/booking-modify-plan";

const FULL_TYPE = "type-full";
const NON_MEMBER_TYPE = "type-nonmember";

/** A configured resolver: keyed rows present, both built-in type ids resolved. */
function resolver(overrides: Partial<HutFeeItemCodeResolver> = {}): HutFeeItemCodeResolver {
  return {
    byKey: new Map([
      [`${FULL_TYPE}_SUMMER_ADULT`, "HUT-MEMBER"],
      [`${NON_MEMBER_TYPE}_SUMMER_ADULT`, "HUT-NONMEMBER"],
    ]),
    fullTypeId: FULL_TYPE,
    nonMemberTypeId: NON_MEMBER_TYPE,
    legacyItemCode: null,
    size: 2,
    ...overrides,
  } as HutFeeItemCodeResolver;
}

describe("describeGuestRateMembershipLabel — the invoice line says what was charged", () => {
  it("calls a repriced member a Non-member, because that is the rate they paid", () => {
    // The failure it fixes: `isMember` stays true for a repriced member (it is
    // load-bearing elsewhere), so the line read "(ADULT, Member)" at the non-member
    // amount inside the NON_MEMBER item — a Member line sitting in the non-member
    // account, visible to the treasurer reconciling the two and to the member
    // reading their own invoice.
    expect(
      describeGuestRateMembershipLabel(resolver(), {
        isMember: true,
        rateMembershipTypeId: NON_MEMBER_TYPE,
      }),
    ).toBe("Non-member");
  });

  it("still calls a member priced on their own rows a Member", () => {
    expect(
      describeGuestRateMembershipLabel(resolver(), {
        isMember: true,
        rateMembershipTypeId: FULL_TYPE,
      }),
    ).toBe("Member");
  });

  it("labels a real non-member unchanged", () => {
    expect(
      describeGuestRateMembershipLabel(resolver(), {
        isMember: false,
        rateMembershipTypeId: NON_MEMBER_TYPE,
      }),
    ).toBe("Non-member");
  });

  it.each([
    [true, "Member"],
    [false, "Non-member"],
  ] as const)(
    "falls back to isMember=%s when the guest has NO snapshot (pre-#1930 booking)",
    (isMember, expected) => {
      expect(
        describeGuestRateMembershipLabel(resolver(), {
          isMember,
          rateMembershipTypeId: null,
        }),
      ).toBe(expected);
    },
  );

  it("falls back to isMember when the club has no built-in NON_MEMBER type resolved", () => {
    // Without a reference point there is nothing to compare the snapshot against,
    // and guessing would be worse than the old wording.
    expect(
      describeGuestRateMembershipLabel(resolver({ nonMemberTypeId: null }), {
        isMember: true,
        rateMembershipTypeId: NON_MEMBER_TYPE,
      }),
    ).toBe("Member");
  });
});

describe("the built invoice line agrees with its own item code (#2543)", () => {
  const checkIn = new Date("2026-08-01T00:00:00.000Z");
  const checkOut = new Date("2026-08-03T00:00:00.000Z");

  function lineFor(rateMembershipTypeId: string) {
    return buildInvoiceLineItems(
      [
        {
          firstName: "Jane",
          lastName: "Smith",
          ageTier: "ADULT",
          isMember: true,
          rateMembershipTypeId,
          priceCents: 4800,
          nights: [
            { stayDate: new Date("2026-08-01T00:00:00.000Z"), priceCents: 2400 },
            { stayDate: new Date("2026-08-02T00:00:00.000Z"), priceCents: 2400 },
          ],
        },
      ],
      checkIn,
      checkOut,
      2,
      "200",
      null,
      false,
      resolver(),
      "SUMMER",
    );
  }

  it("a repriced member's line reads Non-member and carries the non-member item code", () => {
    const [line] = lineFor(NON_MEMBER_TYPE);
    expect(line.description).toContain("(ADULT, Non-member)");
    expect(line.description).not.toContain("Member)");
    expect(line.itemCode).toBe("HUT-NONMEMBER");
    // Narration only: the amount is untouched.
    expect(line.unitAmount).toBe(24);
    expect(line.quantity).toBe(2);
  });

  it("a member priced on their own rows is unchanged in both", () => {
    const [line] = lineFor(FULL_TYPE);
    expect(line.description).toContain("(ADULT, Member)");
    expect(line.itemCode).toBe("HUT-MEMBER");
  });

  it("the legacy no-per-night-detail line uses the same label", () => {
    // Two description sites exist in the builder; a fix applied to one only is how
    // a pre-#713 booking keeps the contradiction forever.
    const [line] = buildInvoiceLineItems(
      [
        {
          firstName: "Jane",
          lastName: "Smith",
          ageTier: "ADULT",
          isMember: true,
          rateMembershipTypeId: NON_MEMBER_TYPE,
          priceCents: 4800,
          nights: [],
        },
      ],
      checkIn,
      checkOut,
      0,
      "200",
      null,
      false,
      resolver(),
      "SUMMER",
    );
    expect(line.description).toContain("(ADULT, Non-member)");
  });
});

describe("rateSnapshotUpdateForRepricedGuest — a locked night keeps its coding", () => {
  const night = (day: number) => new Date(`2026-08-0${day}T00:00:00.000Z`);

  it("leaves the snapshot alone when the guest keeps a night they already bought", () => {
    // The money failure: a member with an unpaid subscription extends a PAID
    // 3-night booking. The 3 original nights keep 1000 c each; the new night prices
    // at 2400 c. Overwriting the guest's snapshot to NON_MEMBER posts 3000 c of
    // MEMBER-rate hut-fee revenue to the non-member item, because Xero resolves ONE
    // item code per guest and applies it to every night run.
    expect(
      rateSnapshotUpdateForRepricedGuest(
        {
          rateMembershipTypeId: NON_MEMBER_TYPE,
          nightDates: [night(1), night(2), night(3), night(4)],
        },
        [
          { stayDate: night(1) },
          { stayDate: night(2) },
          { stayDate: night(3) },
        ],
      ),
    ).toBeUndefined();
  });

  it("writes the new snapshot when NO locked night survives into the priced set", () => {
    // A date change that moves the stay entirely: every night prices fresh, so one
    // item code describes the whole guest correctly.
    expect(
      rateSnapshotUpdateForRepricedGuest(
        {
          rateMembershipTypeId: NON_MEMBER_TYPE,
          nightDates: [night(7), night(8)],
        },
        [{ stayDate: night(1) }],
      ),
    ).toBe(NON_MEMBER_TYPE);
  });

  it("writes the new snapshot when the guest has no locked nights at all", () => {
    // The #2337 placeholder→member link clears them deliberately, so the whole stay
    // re-rates at the member rate and the snapshot MUST follow.
    expect(
      rateSnapshotUpdateForRepricedGuest(
        { rateMembershipTypeId: FULL_TYPE, nightDates: [night(1)] },
        [],
      ),
    ).toBe(FULL_TYPE);
    expect(
      rateSnapshotUpdateForRepricedGuest(
        { rateMembershipTypeId: FULL_TYPE, nightDates: [night(1)] },
        null,
      ),
    ).toBe(FULL_TYPE);
  });

  it("accepts a string stayDate, as the stored rows can carry", () => {
    expect(
      rateSnapshotUpdateForRepricedGuest(
        { rateMembershipTypeId: NON_MEMBER_TYPE, nightDates: [night(1)] },
        [{ stayDate: "2026-08-01" }],
      ),
    ).toBeUndefined();
  });

  it("leaves the snapshot alone for a guest the breakdown does not cover", () => {
    // An index mismatch must not write `undefined` over a real snapshot as if it
    // were a decision — Prisma reads undefined as "leave it", which is the safe
    // answer here either way.
    expect(rateSnapshotUpdateForRepricedGuest(undefined, [])).toBeUndefined();
  });
});
