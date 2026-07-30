// "+ Add Member Guest" (epic #2305) MG2 (#2307) — the member-visible consent
// surfaces' shared brain: the booking-page card resolver, the predictable
// decline refusals and their copy, and the guest-list badges.
//
// The badge wording is owner decision MG2-M-2 AS TICKED (30 Jul) and the
// refusal copy is the signed-off mockup pack's, so several tests below pin
// EXACT strings on purpose: changing them is changing an owner decision, and
// the failing test is the reminder to go get a new tick first.
import { describe, expect, it } from "vitest";

import { parseDateOnly } from "@/lib/date-only";
import type { MemberGuestConsentColumns } from "@/lib/member-guest-consent";
import {
  describeConsentDeclineRefusal,
  describeConsentNightsCount,
  describeMemberGuestConsentBadge,
  formatConsentFullDate,
  formatConsentNightsLabel,
  formatConsentShortDate,
  formatConsentStayLabel,
  formatConsentWeekdayDate,
  predictConsentDeclineRefusal,
  resolveBookingConsentCard,
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
  it("uses the mockup's variant A copy verbatim for the last guest", () => {
    expect(
      describeConsentDeclineRefusal({
        blocker: "LAST_GUEST",
        voice: { kind: "TARGET" },
        bookerFirstName: "Dave",
      }),
    ).toBe(
      "You are the only guest on this booking, so taking you off would leave it empty. " +
        "Only Dave or the club can cancel it. Ask Dave to cancel the booking if you do " +
        "not want to go.",
    );
  });

  it("uses the mockup's variant C copy verbatim for a quote-priced booking", () => {
    expect(
      describeConsentDeclineRefusal({
        blocker: "QUOTE_PRICED",
        voice: { kind: "TARGET" },
        bookerFirstName: "Dave",
      }),
    ).toBe(
      "This booking was priced by hand, so guests cannot be taken off it here. " +
        "Only the club can take you off — it will re-quote the request. " +
        "Reply to the club and they will sort it.",
    );
  });

  it("names who can act in every member-voice variant", () => {
    for (const blocker of [
      "BOOKING_STATUS",
      "STAY_NOT_FUTURE",
      "LAST_GUEST",
    ] as const) {
      const copy = describeConsentDeclineRefusal({
        blocker,
        voice: { kind: "TARGET" },
        bookerFirstName: "Dave",
      });
      expect(copy).toContain("Dave");
      expect(copy).toContain("club");
    }
  });

  it("restates every variant in the third person for a delegate", () => {
    for (const blocker of [
      "BOOKING_STATUS",
      "STAY_NOT_FUTURE",
      "LAST_GUEST",
      "QUOTE_PRICED",
    ] as const) {
      const copy = describeConsentDeclineRefusal({
        blocker,
        voice: { kind: "DELEGATE", guestFirstName: "Tama" },
        bookerFirstName: "Dave",
      });
      // The delegate is never addressed as the person whose place it is.
      expect(copy).not.toMatch(/\byou off\b/i);
      expect(copy).not.toContain("your place");
      expect(copy).toContain(blocker === "QUOTE_PRICED" ? "Tama" : "Tama");
    }
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
  it("gives family and non-member rows no badge at all", () => {
    expect(
      describeMemberGuestConsentBadge({ guest: guest("g", "m-family") }),
    ).toBeNull();
    expect(describeMemberGuestConsentBadge({ guest: guest("g", null) })).toBeNull();
  });

  it("labels a pending row with its expiry date", () => {
    expect(
      describeMemberGuestConsentBadge({ guest: guest("g", "m-1", PENDING) }),
    ).toEqual({
      tone: "pending",
      label: "Waiting for consent · expires 7 Aug",
    });
  });

  it("labels the target's own yes as Consented", () => {
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", {
          consentStatus: "CONFIRMED",
          consentRequestedAt: TODAY,
          consentRespondedAt: RESPONDED,
          consentRespondedByMemberId: "m-1",
        }),
      }),
    ).toEqual({ tone: "ok", label: "Consented" });
  });

  it("names the delegate and the date when somebody answered for the target", () => {
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", {
          consentStatus: "CONFIRMED",
          consentRequestedAt: TODAY,
          consentRespondedAt: RESPONDED,
          consentRespondedByMemberId: "m-2",
        }),
        responderName: "Ana Kaur",
      }),
    ).toEqual({ tone: "ok", label: "Consented by Ana Kaur, 2 Aug" });
  });

  it("falls back to a plain Consented when the delegate's record is gone", () => {
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", {
          consentStatus: "CONFIRMED",
          consentRequestedAt: TODAY,
          consentRespondedAt: RESPONDED,
          consentRespondedByMemberId: "m-2",
        }),
        responderName: null,
      }),
    ).toEqual({ tone: "ok", label: "Consented" });
  });

  it("labels a notify-only row Told, not asked", () => {
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", { consentStatus: "CONFIRMED" }),
      }),
    ).toEqual({ tone: "ok", label: "Told, not asked" });
  });

  it("names the admin who placed an admin-assigned row, with an honest fallback", () => {
    const adminAssigned = {
      consentStatus: "CONFIRMED" as const,
      consentRespondedAt: RESPONDED,
      consentRespondedByMemberId: "m-admin",
    };
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", adminAssigned),
        responderName: "Jo Admin",
      }),
    ).toEqual({ tone: "ok", label: "Added by Jo Admin" });
    expect(
      describeMemberGuestConsentBadge({ guest: guest("g", "m-1", adminAssigned) }),
    ).toEqual({ tone: "ok", label: "Added by the club" });
  });

  it("labels the two stuck states with the could-not-be-removed wording", () => {
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", {
          consentStatus: "DECLINED",
          consentRequestedAt: TODAY,
          consentRespondedAt: RESPONDED,
          consentRespondedByMemberId: "m-1",
        }),
      }),
    ).toEqual({ tone: "blocked", label: "Said no — could not be removed" });
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", {
          consentStatus: "EXPIRED",
          consentRequestedAt: TODAY,
          consentExpiresAt: EXPIRES,
        }),
      }),
    ).toEqual({ tone: "blocked", label: "Lapsed — could not be removed" });
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
      }),
    ).toEqual({ tone: "ok", label: "Consented" });
    // A PENDING row with no expiry (the shape the writer refuses) still warns.
    expect(
      describeMemberGuestConsentBadge({
        guest: guest("g", "m-1", {
          consentStatus: "PENDING",
          consentRequestedAt: TODAY,
        }),
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

  it("spells small night counts in words, as the mockup's intro sentence does", () => {
    expect(describeConsentNightsCount(1)).toBe("one night");
    expect(describeConsentNightsCount(2)).toBe("two nights");
    expect(describeConsentNightsCount(14)).toBe("14 nights");
  });
});
