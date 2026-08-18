// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGuestDateModes } from "@/components/edit-booking/hooks/use-guest-date-modes";
import { useMemberGuestFinder } from "@/components/edit-booking/hooks/use-member-guest-finder";
import { usePromoBeneficiaryReset } from "@/components/edit-booking/hooks/use-promo-selection";
import type { Guest, NewGuest } from "@/components/edit-booking/types";

/*
  #2690 — the three reset flows whose guards nothing was checking.

  An adversarial review of this PR mutated nine behaviours and ran 1,047 tests
  across 109 component files against each. Seven mutations survived every one of
  them. Three of the survivors are the guards below — E3's reset, E5's
  transition guard and E6's first-set latch — and all three had just crossed a
  file boundary in this refactor, which is the worst moment for a behaviour to be
  unguarded.

  The code was correct; the net under it was not there. These cases are written
  at the HOOK level rather than through the panel deliberately: each guard is a
  handful of state transitions, and driving them through a full render would
  test the panel's wiring instead of the rule, which is how the rules ended up
  unguarded in the first place.
*/

const BOOKING_CHECK_IN = "2026-09-04";
const BOOKING_CHECK_OUT = "2026-09-06";

function guest(overrides: Partial<Guest> = {}): Guest {
  return {
    id: "g1",
    firstName: "Ann",
    lastName: "Hughes",
    ageTier: "ADULT",
    isMember: true,
    memberId: "member-ann",
    stayStart: null,
    stayEnd: null,
    nights: null,
    priceCents: 5000,
    ...overrides,
  };
}

describe("E3 — per-guest dates switch off when the mode stops being available", () => {
  it("clears the toggle the moment per-guest dates are no longer offered", () => {
    // Seeded ON, because this guest's stay already differs from the booking's.
    const { result, rerender } = renderHook(
      ({ canEdit }: { canEdit: boolean }) =>
        useGuestDateModes({
          guests: [guest({ stayStart: "2026-09-05", stayEnd: BOOKING_CHECK_OUT })],
          bookingCheckIn: BOOKING_CHECK_IN,
          bookingCheckOut: BOOKING_CHECK_OUT,
          canEditPerGuestDates: canEdit,
        }),
      { initialProps: { canEdit: true } },
    );
    expect(result.current.perGuestDatesEnabled).toBe(true);

    // Removing a guest can take the party to one person, which is what makes
    // per-guest dates meaningless. Leaving the toggle on would keep sending
    // guestStayRanges for a party that cannot have them.
    rerender({ canEdit: false });
    expect(
      result.current.perGuestDatesEnabled,
      "the per-guest-dates reset no longer fires; the toggle survives the mode " +
        "that justified it",
    ).toBe(false);
  });

  it("leaves the toggle alone while the mode is still available", () => {
    const { result, rerender } = renderHook(() =>
      useGuestDateModes({
        guests: [guest({ stayStart: "2026-09-05", stayEnd: BOOKING_CHECK_OUT })],
        bookingCheckIn: BOOKING_CHECK_IN,
        bookingCheckOut: BOOKING_CHECK_OUT,
        canEditPerGuestDates: true,
      }),
    );
    rerender();
    rerender();
    expect(result.current.perGuestDatesEnabled).toBe(true);
  });
});

describe("E5 — a repeated member-guest refusal re-opens the finder once, not every time", () => {
  const REFUSAL = "This member can't be added to this booking right now.";

  /**
   * A candidate is a fresh OBJECT every time the finder hands one over, even for
   * the same person. That identity change is what re-runs the effect, and it is
   * the only thing that does: `[memberGuestAddError, lastMemberGuestAttempt]`.
   *
   * The first version of this suite re-rendered with an unchanged error and
   * asserted the finder stayed shut. It passed against the mutant that deletes
   * the guard entirely, because with both dependencies unchanged React never
   * re-runs the effect at all — so the test proved React's dependency check, not
   * the guard. Caught by mutation-testing it; the cases below change the
   * candidate's identity, which is what the real add path does.
   */
  const attempt = (memberId: string) => ({
    memberId,
    firstName: "Mia",
    lastName: "Ngata",
    ageTier: "ADULT" as const,
  });

  it("opens the finder when a refusal first arrives", () => {
    const { result, rerender } = renderHook(
      ({ error }: { error: string | null }) => useMemberGuestFinder(error),
      { initialProps: { error: null as string | null } },
    );
    expect(result.current.memberGuestFinderOpen).toBe(false);

    rerender({ error: REFUSAL });
    expect(result.current.memberGuestFinderOpen).toBe(true);
  });

  it("does NOT spring back open when the SAME member is attempted again", () => {
    const { result, rerender } = renderHook(
      ({ error }: { error: string | null }) => useMemberGuestFinder(error),
      { initialProps: { error: null as string | null } },
    );
    act(() => result.current.setLastMemberGuestAttempt(attempt("member-mia")));
    rerender({ error: REFUSAL });
    expect(result.current.memberGuestFinderOpen).toBe(true);

    // The booker reads the refusal and closes the panel.
    act(() => result.current.closeMemberGuestFinder());
    expect(result.current.memberGuestFinderOpen).toBe(false);

    // They try the same person again. A new candidate object re-runs the effect,
    // but the person and the refusal are unchanged — so the section must stay
    // shut rather than springing back open under a booker who has closed it and
    // moved on to their dates.
    act(() => result.current.setLastMemberGuestAttempt(attempt("member-mia")));
    rerender({ error: REFUSAL });
    act(() => result.current.setLastMemberGuestAttempt(attempt("member-mia")));
    rerender({ error: REFUSAL });
    expect(
      result.current.memberGuestFinderOpen,
      "the finder re-opened for a refusal it had already surfaced; the " +
        "already-surfaced signature guard is gone",
    ).toBe(false);
  });

  it("DOES open again when the refusal is about a different member", () => {
    // The other half of the rule: the guard must not be so broad that a genuinely
    // new refusal goes unseen.
    const { result, rerender } = renderHook(
      ({ error }: { error: string | null }) => useMemberGuestFinder(error),
      { initialProps: { error: null as string | null } },
    );
    act(() => result.current.setLastMemberGuestAttempt(attempt("member-mia")));
    rerender({ error: REFUSAL });
    act(() => result.current.closeMemberGuestFinder());
    expect(result.current.memberGuestFinderOpen).toBe(false);

    act(() => result.current.setLastMemberGuestAttempt(attempt("member-tane")));
    rerender({ error: REFUSAL });
    expect(result.current.memberGuestFinderOpen).toBe(true);
  });

  it("opens again once the refusal has cleared and a new one arrives", () => {
    const { result, rerender } = renderHook(
      ({ error }: { error: string | null }) => useMemberGuestFinder(error),
      { initialProps: { error: null as string | null } },
    );
    rerender({ error: REFUSAL });
    act(() => result.current.closeMemberGuestFinder());
    expect(result.current.memberGuestFinderOpen).toBe(false);

    // Cleared: the guard resets, so the next refusal is a fresh transition.
    rerender({ error: null });
    rerender({ error: REFUSAL });
    expect(result.current.memberGuestFinderOpen).toBe(true);
  });
});

describe("E6 — a guest-targeted promo is retired only when the party actually moves", () => {
  const added: NewGuest[] = [];
  const promoAction = {
    type: "new" as const,
    code: "SPRING",
    guestIndexes: [0],
  };

  function run(initialGuests: Guest[]) {
    const retirePromoSelection = vi.fn();
    const { rerender } = renderHook(
      ({ guests }: { guests: Guest[] }) =>
        usePromoBeneficiaryReset({
          promoAction,
          guests,
          removedGuestIds: new Set<string>(),
          addedGuests: added,
          retirePromoSelection,
        }),
      { initialProps: { guests: initialGuests } },
    );
    return { retirePromoSelection, rerender };
  }

  it("does NOT retire the code on the render it was applied in", () => {
    // The first-set branch. Without it the latch starts at null, compares
    // unequal to the very first signature, and drops a promo the member has
    // just successfully applied — before they have changed anything at all.
    const { retirePromoSelection, rerender } = run([guest()]);
    rerender({ guests: [guest()] });
    expect(
      retirePromoSelection,
      "a freshly applied guest-targeted promo was retired immediately; the " +
        "latch's first-set branch is gone",
    ).not.toHaveBeenCalled();
  });

  it("retires the code when the guest set it was aimed at changes", () => {
    const { retirePromoSelection, rerender } = run([guest()]);
    // A second guest shifts every positional beneficiary index by one, so the
    // discount would silently land on a different person.
    rerender({ guests: [guest(), guest({ id: "g2", memberId: "member-bo" })] });
    expect(retirePromoSelection).toHaveBeenCalledTimes(1);
  });

  it("does not retire it again while the new party holds still", () => {
    const { retirePromoSelection, rerender } = run([guest()]);
    rerender({ guests: [guest(), guest({ id: "g2", memberId: "member-bo" })] });
    rerender({ guests: [guest(), guest({ id: "g2", memberId: "member-bo" })] });
    expect(retirePromoSelection).toHaveBeenCalledTimes(1);
  });
});
