// "+ Add Member Guest" (epic #2305) MG2 (#2307) — the member-visible consent
// surfaces' shared brain: the booking-page card resolver, the predictable
// decline refusals and their copy, and the guest-list badges.
//
// The badge wording is owner decision MG2-M-2 AS TICKED (30 Jul) and the
// refusal copy is the signed-off mockup pack's, so several tests below pin
// EXACT strings on purpose: changing them is changing an owner decision, and
// the failing test is the reminder to go get a new tick first.
//
// EVERY sentence is pinned verbatim, in both voices and for both audiences,
// rather than probed for a name or a keyword. A "contains the booker's name"
// assertion is true of all four refusal sentences at once, so it would pass
// happily with two of them swapped — telling a member a stay had started when
// the real problem was the booking's status. Pinning is the only assertion
// that fails when the copy is wrong rather than merely absent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseDateOnly } from "@/lib/date-only";
import type { MemberGuestConsentColumns } from "@/lib/member-guest-consent";
import {
  describeConsentDeclineRefusal,
  describeConsentNightsCount,
  describeMemberGuestConsentBadge,
  formatConsentFullDate,
  formatConsentGuestName,
  formatConsentNightsLabel,
  formatConsentShortDate,
  formatConsentStayLabel,
  formatConsentWeekdayDate,
  predictConsentDeclineRefusal,
  resolveBookingConsentCard,
  type PredictableConsentDeclineBlocker,
} from "@/lib/member-guest-consent-card";

const TODAY = parseDateOnly("2026-08-01");
const CHECK_IN = parseDateOnly("2026-08-08");
const CHECK_OUT = parseDateOnly("2026-08-10");
const EXPIRES = parseDateOnly("2026-08-07");
const RESPONDED = parseDateOnly("2026-08-02");

const CONSENT_FREE: MemberGuestConsentColumns = {
  consentStatus: null,
  consentRequestedAt: null,
  consentRespondedAt: null,
  consentRespondedByMemberId: null,
  consentExpiresAt: null,
};

function guest(
  id: string,
  memberId: string | null,
  consent: Partial<MemberGuestConsentColumns> = {},
) {
  return { id, memberId, ...CONSENT_FREE, ...consent };
}

const PENDING = {
  consentStatus: "PENDING" as const,
  consentRequestedAt: TODAY,
  consentExpiresAt: EXPIRES,
};

// The fixtures above pin a check-in of 8 August 2026, and STAY_NOT_FUTURE
// outranks two of the blockers below it. Left to the wall clock these tests
// would quietly change their answers on 8 August 2026 and never again, so the
// clock is pinned to a day well after every fixture date: if a production
// default ever creeps back in, it produces STAY_NOT_FUTURE here and now rather
// than on one future morning in CI.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-03-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("predictConsentDeclineRefusal (D-14's predictable half)", () => {
  const base = {
    bookingStatus: "PAID",
    bookingCheckIn: CHECK_IN,
    bookingGuestCount: 3,
    isQuotePriced: false,
    today: TODAY,
  };

  it("predicts nothing for an ordinary future multi-guest booking", () => {
    expect(predictConsentDeclineRefusal(base)).toBeNull();
  });

  it("evaluates the gates in the removal service's own order", () => {
    // Status outranks everything: a COMPLETED, started, single-guest,
    // quote-priced booking reports BOOKING_STATUS, exactly as the service
    // would raise it first.
    expect(
      predictConsentDeclineRefusal({
        ...base,
        bookingStatus: "COMPLETED",
        bookingCheckIn: parseDateOnly("2026-07-20"),
        bookingGuestCount: 1,
        isQuotePriced: true,
      }),
    ).toBe("BOOKING_STATUS");
    expect(
      predictConsentDeclineRefusal({
        ...base,
        bookingCheckIn: TODAY,
        bookingGuestCount: 1,
        isQuotePriced: true,
      }),
    ).toBe("STAY_NOT_FUTURE");
    expect(
      predictConsentDeclineRefusal({ ...base, bookingGuestCount: 1, isQuotePriced: true }),
    ).toBe("LAST_GUEST");
    expect(predictConsentDeclineRefusal({ ...base, isQuotePriced: true })).toBe(
      "QUOTE_PRICED",
    );
  });
});

describe("describeConsentDeclineRefusal — the signed-off warning copy", () => {
  // Every sentence, both voices, pinned word for word. Swapping any two of
  // them — the exact mistake a "contains Dave" assertion cannot catch — turns
  // one of these red.
  const MEMBER_VOICE: Record<PredictableConsentDeclineBlocker, string> = {
    // The mockup's variant A, verbatim.
    LAST_GUEST:
      "You are the only guest on this booking, so taking you off would leave it empty. " +
      "Only Dave or the club can cancel it. Ask Dave to cancel the booking if you do " +
      "not want to go.",
    // The mockup's variant C, verbatim.
    QUOTE_PRICED:
      "This booking was priced by hand, so guests cannot be taken off it here. " +
      "Only the club can take you off — it will re-quote the request. " +
      "Reply to the club and they will sort it.",
    // Not drawn on the mockup pack; composed in the same voice from the shared
    // self-removal wording, and pinned here so it stays that way.
    BOOKING_STATUS:
      "This booking is in a state where guests cannot be taken off it, so saying no " +
      "cannot release your place. Ask Dave or the club to take you off if you do not " +
      "want to go.",
    STAY_NOT_FUTURE:
      "This stay starts today or has already started, so your place can no longer be " +
      "released here. Ask Dave or the club if your plans have changed.",
  };

  const DELEGATE_VOICE: Record<PredictableConsentDeclineBlocker, string> = {
    LAST_GUEST:
      "Tama is the only guest on this booking, so taking Tama off would leave it " +
      "empty. Only Dave or the club can cancel it. Ask Dave to cancel the booking " +
      "if Tama does not want to go.",
    QUOTE_PRICED:
      "This booking was priced by hand, so guests cannot be taken off it here. " +
      "Only the club can take Tama off — it will re-quote the request. " +
      "Reply to the club and they will sort it.",
    BOOKING_STATUS:
      "This booking is in a state where guests cannot be taken off it, so saying no " +
      "cannot release Tama's place. Ask Dave or the club to take Tama off if they " +
      "do not want to go.",
    STAY_NOT_FUTURE:
      "This stay starts today or has already started, so the place can no longer be " +
      "released here. Ask Dave or the club if Tama's plans have changed.",
  };

  const ALL_BLOCKERS = Object.keys(
    MEMBER_VOICE,
  ) as PredictableConsentDeclineBlocker[];

  it.each(ALL_BLOCKERS)(
    "gives the member their own %s sentence, word for word",
    (blocker) => {
      expect(
        describeConsentDeclineRefusal({
          blocker,
          voice: { kind: "TARGET" },
          bookerFirstName: "Dave",
        }),
      ).toBe(MEMBER_VOICE[blocker]);
    },
  );

  it.each(ALL_BLOCKERS)(
    "restates the %s sentence in the third person for a delegate, word for word",
    (blocker) => {
      expect(
        describeConsentDeclineRefusal({
          blocker,
          voice: { kind: "DELEGATE", guestFirstName: "Tama" },
          bookerFirstName: "Dave",
        }),
      ).toBe(DELEGATE_VOICE[blocker]);
    },
  );

  it("never addresses a delegate as the person whose place it is", () => {
    for (const blocker of ALL_BLOCKERS) {
      const copy = DELEGATE_VOICE[blocker];
      expect(copy).not.toMatch(/\byou\b/i);
      expect(copy).not.toContain("your");
      // ...and it does name the guest whose place it actually is.
      expect(copy).toContain("Tama");
    }
  });

  it("gives each blocker its own distinct sentence in both voices", () => {
    // A swap between two reasons would leave four values here, not eight.
    const all = [
      ...Object.values(MEMBER_VOICE),
      ...Object.values(DELEGATE_VOICE),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("resolveBookingConsentCard", () => {
  const base = {
    actorMemberId: "m-viewer",
    bookingDeletedAt: null,
    bookingStatus: "PAID",
    bookingCheckIn: CHECK_IN,
    isQuotePriced: false,
    selfRemovalCardPresent: true,
    today: TODAY,
  };

  it("shows the ask card for the viewer's own PENDING row, with its deadline", () => {
    const card = resolveBookingConsentCard({
      ...base,
      guests: [guest("g-owner", "m-owner"), guest("g-viewer", "m-viewer", PENDING)],
    });
    expect(card).toEqual({
      kind: "PENDING_ASK",
      guestId: "g-viewer",
      consentExpiresAt: EXPIRES,
      refusalBlocker: null,
    });
  });

  it("predicts the decline refusal from the same facts the server enforces", () => {
    const card = resolveBookingConsentCard({
      ...base,
      isQuotePriced: true,
      guests: [guest("g-owner", "m-owner"), guest("g-viewer", "m-viewer", PENDING)],
    });
    expect(card?.kind === "PENDING_ASK" && card.refusalBlocker).toBe("QUOTE_PRICED");
  });

  it("counts every guest row toward the last-guest prediction", () => {
    const card = resolveBookingConsentCard({
      ...base,
      guests: [guest("g-viewer", "m-viewer", PENDING)],
    });
    expect(card?.kind === "PENDING_ASK" && card.refusalBlocker).toBe("LAST_GUEST");
  });

  it("shows the told-not-asked notice only for a notify-only row, and only while the self-removal card is present to point at", () => {
    const notifyOnly = {
      consentStatus: "CONFIRMED" as const,
    };
    const guests = [
      guest("g-owner", "m-owner"),
      guest("g-viewer", "m-viewer", notifyOnly),
    ];
    expect(resolveBookingConsentCard({ ...base, guests })).toEqual({
      kind: "NOTIFY_ONLY_NOTICE",
    });
    // No self-removal card below (owner, admin, deleted...) — the pointer
    // would dangle, so no notice either.
    expect(
      resolveBookingConsentCard({ ...base, guests, selfRemovalCardPresent: false }),
    ).toBeNull();
  });

  it("shows nothing for an answered, admin-assigned, family, or absent row", () => {
    // TARGET_APPROVED — they said yes themselves; the badge carries the state.
    expect(
      resolveBookingConsentCard({
        ...base,
        guests: [
          guest("g-viewer", "m-viewer", {
            consentStatus: "CONFIRMED",
            consentRequestedAt: TODAY,
            consentRespondedAt: RESPONDED,
            consentRespondedByMemberId: "m-viewer",
          }),
        ],
      }),
    ).toBeNull();
    // ADMIN_ASSIGNED — placed by the club; the ordinary page tells the truth.
    expect(
      resolveBookingConsentCard({
        ...base,
        guests: [
          guest("g-viewer", "m-viewer", {
            consentStatus: "CONFIRMED",
            consentRespondedAt: RESPONDED,
            consentRespondedByMemberId: "m-admin",
          }),
        ],
      }),
    ).toBeNull();
    // Family-scope row: no consent was ever needed.
    expect(
      resolveBookingConsentCard({
        ...base,
        guests: [guest("g-viewer", "m-viewer")],
      }),
    ).toBeNull();
    // The viewer is not on the booking at all.
    expect(
      resolveBookingConsentCard({
        ...base,
        guests: [guest("g-other", "m-other", PENDING)],
      }),
    ).toBeNull();
  });

  it("shows nothing on a soft-deleted booking or for an absent actor id", () => {
    const guests = [guest("g-viewer", "m-viewer", PENDING)];
    expect(
      resolveBookingConsentCard({
        ...base,
        bookingDeletedAt: new Date(),
        guests,
      }),
    ).toBeNull();
    expect(
      resolveBookingConsentCard({ ...base, actorMemberId: "", guests }),
    ).toBeNull();
  });
});

describe("describeMemberGuestConsentBadge (owner decision MG2-M-2 as ticked)", () => {
  // The two mockups do not agree, on purpose, so every badge is pinned for
  // BOTH audiences. docs/member-guests/mockups/member-surfaces.html:199-203 is
  // the member column; docs/member-guests/mockups/admin-surfaces.html:142-148
  // is the admin one.
  const TARGET_APPROVED = {
    consentStatus: "CONFIRMED" as const,
    consentRequestedAt: TODAY,
    consentRespondedAt: RESPONDED,
    consentRespondedByMemberId: "m-1",
  };
  const DELEGATE_APPROVED = {
    consentStatus: "CONFIRMED" as const,
    consentRequestedAt: TODAY,
    consentRespondedAt: RESPONDED,
    consentRespondedByMemberId: "m-2",
  };
  const ADMIN_ASSIGNED = {
    consentStatus: "CONFIRMED" as const,
    consentRespondedAt: RESPONDED,
    consentRespondedByMemberId: "m-admin",
  };
  const DECLINED = {
    consentStatus: "DECLINED" as const,
    consentRequestedAt: TODAY,
    consentRespondedAt: RESPONDED,
    consentRespondedByMemberId: "m-1",
  };
  const LAPSED = {
    consentStatus: "EXPIRED" as const,
    consentRequestedAt: TODAY,
    consentExpiresAt: EXPIRES,
  };

  it("gives family and non-member rows no badge at all, whoever is looking", () => {
    for (const audience of ["MEMBER", "ADMIN"] as const) {
      expect(
        describeMemberGuestConsentBadge({ guest: guest("g", "m-family"), audience }),
      ).toBeNull();
      expect(
        describeMemberGuestConsentBadge({ guest: guest("g", null), audience }),
      ).toBeNull();
    }
  });

  it("labels a pending row with its expiry date, the same way for both", () => {
    for (const audience of ["MEMBER", "ADMIN"] as const) {
      expect(
        describeMemberGuestConsentBadge({
          guest: guest("g", "m-1", PENDING),
          audience,
        }),
      ).toEqual({ tone: "pending", label: "Waiting for consent · expires 7 Aug" });
    }
  });

  it("labels a notify-only row Told, not asked for both audiences", () => {
    for (const audience of ["MEMBER", "ADMIN"] as const) {
      expect(
        describeMemberGuestConsentBadge({
          guest: guest("g", "m-1", { consentStatus: "CONFIRMED" }),
          audience,
        }),
      ).toEqual({ tone: "ok", label: "Told, not asked" });
    }
  });

  it("shows a member the bare forms the member mockup signs off", () => {
    // Nothing here names anybody or carries a date. The responder is routinely
    // a family adult who is not on this booking at all, and a name is passed in
    // anyway to prove the member wording ignores it rather than merely lacking
    // it.
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", TARGET_APPROVED),
        audience: "MEMBER",
      }),
    ).toEqual({ tone: "ok", label: "Consented" });
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", DELEGATE_APPROVED),
        audience: "MEMBER",
        responderName: "Ana Kaur",
      }),
    ).toEqual({ tone: "ok", label: "Consented" });
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", ADMIN_ASSIGNED),
        audience: "MEMBER",
        responderName: "Jo Admin",
      }),
    ).toEqual({ tone: "ok", label: "Added by the club" });
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", DECLINED),
        audience: "MEMBER",
      }),
    ).toEqual({ tone: "blocked", label: "Said no — still on the booking" });
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", LAPSED),
        audience: "MEMBER",
      }),
    ).toEqual({ tone: "blocked", label: "Lapsed — still on the booking" });
  });

  it("never leaks a responder's name to a member, for any row shape", () => {
    for (const consent of [TARGET_APPROVED, DELEGATE_APPROVED, ADMIN_ASSIGNED]) {
      const badge = describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", consent),
        audience: "MEMBER",
        responderName: "Ana Kaur",
      });
      expect(badge?.label).not.toContain("Ana");
      expect(badge?.label).not.toContain("Kaur");
    }
  });

  it("shows the club the named and dated forms the admin mockup signs off", () => {
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", TARGET_APPROVED),
        audience: "ADMIN",
      }),
    ).toEqual({ tone: "ok", label: "Consented 2 Aug" });
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", DELEGATE_APPROVED),
        audience: "ADMIN",
        responderName: "Ana Kaur",
      }),
    ).toEqual({ tone: "ok", label: "Consented by Ana Kaur, 2 Aug" });
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", ADMIN_ASSIGNED),
        audience: "ADMIN",
        responderName: "Jo Admin",
      }),
    ).toEqual({ tone: "ok", label: "Added by Jo Admin" });
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", DECLINED),
        audience: "ADMIN",
      }),
    ).toEqual({ tone: "blocked", label: "Said no — could not be removed" });
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", LAPSED),
        audience: "ADMIN",
      }),
    ).toEqual({ tone: "blocked", label: "Lapsed — could not be removed" });
  });

  it("falls back to a still-true form for the club when the responder's record is gone", () => {
    // The date survives even when the name does not, and an admin-placed row
    // still says the club placed it.
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", DELEGATE_APPROVED),
        audience: "ADMIN",
        responderName: null,
      }),
    ).toEqual({ tone: "ok", label: "Consented 2 Aug" });
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", ADMIN_ASSIGNED),
        audience: "ADMIN",
      }),
    ).toEqual({ tone: "ok", label: "Added by the club" });
  });

  it("still badges a row that matches no legal sub-state, from its raw status", () => {
    // A CONFIRMED row carrying a stale expiry is a broken shape the model
    // rejects — but a viewer must still see an honest badge, not a blank.
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", {
          consentStatus: "CONFIRMED",
          consentExpiresAt: EXPIRES,
        }),
        audience: "MEMBER",
      }),
    ).toEqual({ tone: "ok", label: "Consented" });
    // A PENDING row with no expiry (the shape the writer refuses) still warns.
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", {
          consentStatus: "PENDING",
          consentRequestedAt: TODAY,
        }),
        audience: "ADMIN",
      }),
    ).toEqual({ tone: "pending", label: "Waiting for consent" });
  });
});

describe("the date and count labels", () => {
  it("formats the shapes the mockups draw, in club time", () => {
    expect(formatConsentShortDate(EXPIRES)).toBe("7 Aug");
    expect(formatConsentWeekdayDate(CHECK_IN)).toBe("Sat 8 Aug");
    expect(formatConsentFullDate(EXPIRES)).toBe("Fri 7 Aug 2026");
    expect(formatConsentStayLabel(CHECK_IN, CHECK_OUT)).toBe(
      "Sat 8 Aug – Mon 10 Aug 2026 (2 nights)",
    );
    expect(
      formatConsentNightsLabel([CHECK_IN, parseDateOnly("2026-08-09")]),
    ).toBe("Sat 8 Aug, Sun 9 Aug");
  });

  it("composes a guest's name without a hole where a missing surname was", () => {
    expect(
      formatConsentGuestName({ firstName: "Tama", lastName: "Kaur", ageYears: 9 }),
    ).toBe("Tama Kaur (age 9)");
    // An adult's age is nobody's business; the age is there so the person
    // answering knows when a CHILD is being put on a booking.
    expect(
      formatConsentGuestName({ firstName: "Tama", lastName: "Kaur", ageYears: 41 }),
    ).toBe("Tama Kaur");
    expect(
      formatConsentGuestName({ firstName: "Tama", lastName: "Kaur", ageYears: null }),
    ).toBe("Tama Kaur");
    // The row that broke it: a member with one name and a known age rendered
    // as "Tama  (age 9)" — two spaces, in the page's own heading.
    expect(
      formatConsentGuestName({ firstName: "Tama", lastName: "", ageYears: 9 }),
    ).toBe("Tama (age 9)");
    expect(
      formatConsentGuestName({ firstName: "Tama", lastName: "  ", ageYears: null }),
    ).toBe("Tama");
    expect(
      formatConsentGuestName({ firstName: "", lastName: "Kaur", ageYears: null }),
    ).toBe("Kaur");
  });

  it("spells small night counts in words, as the mockup's intro sentence does", () => {
    expect(describeConsentNightsCount(1)).toBe("one night");
    expect(describeConsentNightsCount(2)).toBe("two nights");
    expect(describeConsentNightsCount(14)).toBe("14 nights");
  });
});
