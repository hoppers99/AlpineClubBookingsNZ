import type { AgeTier } from "@prisma/client";
import {
  calculateBookingPrice,
  type RateSource,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  addDaysDateOnly,
  formatDateOnlyForTimeZone,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import {
  expandStayEnvelopeToNightKeys,
  getExplicitGuestBedNightKeys,
  type GuestNightInput,
} from "@/lib/booking-guest-stay-ranges";
import type { MemberGuestConsentGuestFields } from "@/lib/member-guest-add-policy";

interface ExistingBookingEditGuest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  // Resolved rate membership type (#1930, E4); replaces the old
  // forceNonMemberRate boolean. Range pricing here never applies a group
  // discount, so rateSource is carried only for shape parity.
  rateMembershipTypeId: string;
  rateSource?: RateSource;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // The guest's CANONICAL night set — their `BookingGuestNight` rows (#2736).
  //
  // `stayStart`/`stayEnd` above is the DERIVED half-open envelope whose
  // `stayEnd` is the morning after the last night (INV-DATE-012), and for a
  // SPARSE stay the envelope silently fills the internal gaps. This plan used
  // to carry no night list at all, so an edit to a booking already under way
  // priced, persisted and reserved a bed for every gap night the guest is not
  // there for (INV-MOD-025). Every caller already loads these rows —
  // `LoadedBookingForModify` includes them — so before #2736 they were present
  // at runtime and invisible to the type system, which is exactly how the plan
  // came to be the one edit path that flattens a sparse stay.
  nights?: ReadonlyArray<GuestNightInput> | null;
  priceCents: number;
}

// Extends MemberGuestConsentGuestFields ("+ Add Member Guest", epic #2305, MG2
// #2307) so a cross-family guest added to an IN-PROGRESS stay carries its consent
// columns and its D-8 marker through this plan to the row writer. Without the
// declaration the fields would still be present at runtime and invisible to the
// type system, which is how an in-progress add would quietly become the one path
// that writes a consent-free cross-family guest row. Type-only import: nothing is
// pulled into this module at runtime.
// Deliberately declares NO stay range and NO night set. A guest added to a stay
// already under way is admitted for the booking's remaining future nights,
// `[editableFrom, newCheckOut)`, and this plan overrides whatever per-guest
// range or `nights` the request carried — which callers DO pass at runtime, from
// the shared stay-range resolver. That is unchanged by #2736 and is why the
// added-guest window is contiguous by construction: honouring a narrower or
// sparser requested set here would move the price of edits that have nothing to
// do with a gap. Leaving the fields undeclared keeps the override deliberate
// rather than accidental; see INV-MOD-025.
interface AddedBookingEditGuest extends MemberGuestConsentGuestFields {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  rateMembershipTypeId: string;
  rateSource?: RateSource;
}

interface ProposedExistingGuestRange {
  guest: ExistingBookingEditGuest;
  stayStart: Date;
  stayEnd: Date;
  // #2736: the nights this guest actually holds after the edit, sorted — the
  // guest's own canonical nights that survive the edit, plus the genuinely-new
  // nights a check-out extension adds after their last one AND after the
  // booking's old check-out (#2743). This, NOT `[stayStart, stayEnd)`, is what
  // gets priced, quoted per night and written back as `BookingGuestNight` rows,
  // so an internal gap stays a gap (INV-MOD-025). For a contiguous guest who
  // holds the booking's last night it IS `[stayStart, stayEnd)`, night for
  // night, which is what makes the change a no-op for every ordinary stay.
  nights: Date[];
  // The subset of `nights` from `futureStart` onwards — the nights this edit
  // actually prices and capacity-checks. Empty means the guest holds no future
  // night at all, which is how a sparse guest whose remaining nights are all
  // behind the edit window stops counting as future-active.
  futureNights: Date[];
  priceCents: number;
  oldFuturePriceCents: number;
  newFuturePriceCents: number;
  futureDeltaCents: number;
  removedFromFuture: boolean;
  // #2029: the earliest night this edit newly prices/occupies for the guest —
  // `maxDate(stayStart, minDate(editableFrom, originalStayEnd))`. Equals
  // editableFrom for the mid-stay/last-night cases, but drops back to the
  // guest's own (original) stay end for a check-out-day extension so the
  // genuinely-new [stayEnd, editableFrom) night is both charged and
  // capacity-checked. Both the pricing delta and the capacity range key off it.
  futureStart: Date;
}

interface ProposedAddedGuestRange {
  guest: AddedBookingEditGuest;
  stayStart: Date;
  stayEnd: Date;
  // #2736: the nights the added guest holds. A guest added to a stay already
  // under way is admitted for the booking's remaining future nights and nothing
  // else — this plan deliberately overrides whatever per-guest range or night
  // set the request carried (see `proposedAddedGuests` below) — so this window
  // is CONTIGUOUS BY CONSTRUCTION and equals `[stayStart, stayEnd)` exactly.
  // It is materialised anyway so the write path, the capacity check and the
  // per-night quote all read one night list whichever kind of guest they hold.
  nights: Date[];
  priceCents: number;
}

export interface BookingEditGuestRangePlan {
  proposedExistingGuests: ProposedExistingGuestRange[];
  proposedAddedGuests: ProposedAddedGuestRange[];
  remainingGuests: ExistingBookingEditGuest[];
  removedGuests: ExistingBookingEditGuest[];
  newTotalPriceCents: number;
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  newFinalPriceCents: number;
  priceDiffCents: number;
  futureExistingDeltaCents: number;
  futureActiveGuestCount: number;
  capacityGuestRanges: Array<{
    stayStart: Date;
    stayEnd: Date;
    // #2736: the exact nights this range occupies a bed on. `countActiveGuestsForNight`
    // reads an explicit night set in preference to the envelope, so a sparse
    // guest no longer claims a bed on a gap night they are not in the lodge for.
    // Identical to expanding `[stayStart, stayEnd)` for every contiguous guest
    // and for every added guest.
    nights: Date[];
    // Carried so the partner-shared admission check (#1746) can tell a
    // flagged sharer's range from the ordinary ones; null for non-members.
    memberId?: string | null;
  }>;
  // #2029: the earliest night the capacity check must cover for this edit — the
  // minimum `futureStart` across the included ranges, never later than
  // editableFrom. The capacity call sites use this (not editableFrom) as the
  // window start so a check-out-day extension's new night is inside the checked
  // window; for mid-stay/last-night edits it equals editableFrom (unchanged).
  capacityRangeStart: Date;
}

export interface BuildInProgressGuestRangePlanInput {
  booking: {
    checkIn: Date;
    checkOut: Date;
    totalPriceCents: number;
    discountCents: number;
    promoAdjustmentCents: number;
    finalPriceCents: number;
    guests: ExistingBookingEditGuest[];
  };
  editableFrom: Date;
  newCheckOut: Date;
  addGuests?: AddedBookingEditGuest[];
  removeGuestIds?: string[];
  seasons: SeasonRateData[];
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

/** The NZ date-only key of a date-only value, the scheme every night set uses. */
function dateOnlyKey(value: Date): string {
  return formatDateOnlyForTimeZone(value);
}

/**
 * Price EXACTLY these nights at current season rates, in integer cents.
 *
 * #2736 replaced the old `priceGuestRangeCents(start, end, …)`, which handed
 * `calculateBookingPrice` a bare `[start, end)` envelope and let it expand the
 * range itself. Passing the night list instead takes the *same* per-night code
 * path — `calculateBookingPrice` prefers a guest's explicit `nights` over the
 * envelope (issue #713) and looks the season rate up once per night — so
 * seasonal, age-tier and member/non-member differentiation still apply night by
 * night and nothing is ever a rate multiplied by a night count. For a
 * contiguous night list the two forms price the identical set of nights in the
 * identical order, which is why every ordinary stay is unchanged to the cent.
 *
 * Integer cents throughout: every term is a `pricePerNightCents` integer summed
 * by `calculateBookingPrice` (INV-MONEY-001, INV-MONEY-003). No float, no
 * parse, no rounding.
 *
 * Deliberately passes NO `lockedNightPrices`, exactly as `priceGuestRangeCents`
 * did: every night here is valued at the CURRENT season rate, including the
 * nights an edit gives back. The other edit paths do pass them
 * (`lockedNightPricesForGuest`, `booking-modify-plan.ts`), so this plan is the
 * exception, and after a rate rise it can credit a night back for more than the
 * member paid for it. Not changed by #2736 — passing them would move contiguous
 * stays' refunds and give up the equivalence this plan's safety rests on — and
 * carried as #2744 with the options.
 */
function priceGuestNightKeysCents(
  nightKeys: readonly string[],
  guest: Pick<
    ExistingBookingEditGuest,
    "ageTier" | "isMember" | "rateMembershipTypeId" | "rateSource"
  >,
  seasons: SeasonRateData[]
): number {
  if (nightKeys.length === 0) {
    return 0;
  }
  const nights = nightKeys.map((key) => parseDateOnly(key));

  return calculateBookingPrice(
    nights[0],
    addDaysDateOnly(nights[nights.length - 1], 1),
    [{
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      rateMembershipTypeId: guest.rateMembershipTypeId,
      rateSource: guest.rateSource,
      nights,
    }],
    seasons
  ).totalPriceCents;
}

/**
 * The plan behind an edit to a booking that is already UNDER WAY: what each
 * guest ends up holding, what that costs, and what capacity must be checked.
 * Shared by the modify-quote preview and the modify-charge apply, so a quote and
 * a charge can never disagree.
 *
 * **Price the nights, never the envelope (INV-MOD-025).** A guest's nights are
 * `BookingGuestNight` rows; `stayStart`/`stayEnd` is a derived half-open
 * envelope (INV-DATE-012) that silently fills a sparse stay's internal gaps.
 * This plan used to carry only the envelope, so a guest booked on nights
 * {20, 22} was priced, quoted, given a bed and written back as if the 21st were
 * theirs — and because the charge is a delta against their stored price, a
 * mid-stay REMOVAL or a SHORTENED check-out subtracted those phantom nights and
 * refunded money the member had never paid (#2736).
 *
 * **Sell only the nights the edit creates (INV-MOD-025).** An edit adds a night
 * to a guest only when it moves the booking's check-out, and only past the OLD
 * check-out. This plan used to run each guest's added-nights leg from their own
 * last held night to the new check-out whether the check-out had moved or not,
 * so a #713 partial-stay guest whose stay had already finished was put back on
 * the booking for the rest of its nights and charged for them by an edit that
 * changed nothing else — a name correction bought seven nights (#2743).
 *
 * For a contiguous stay that runs to the booking's own check-out — every
 * ordinary edit — every output here is identical to the pre-#2736 envelope
 * arithmetic, to the cent, to the night, to the capacity range and to the thrown
 * error. That equivalence is the property that makes the rule safe on live
 * bookings, and `booking-edit-guest-ranges-sparse.test.ts` proves it by
 * re-implementing the old maths and comparing, rather than asserting it. The
 * one deliberate exception is #2743's own shape, and the same suite measures it:
 * the bound never charges MORE than the old arithmetic did, and never lets
 * through an edit the old arithmetic refused.
 */
export function buildInProgressGuestRangePlan(
  input: BuildInProgressGuestRangePlanInput
): BookingEditGuestRangePlan {
  const editableFrom = normalizeDateOnlyForTimeZone(input.editableFrom);
  const bookingCheckIn = normalizeDateOnlyForTimeZone(input.booking.checkIn);
  const bookingCheckOut = normalizeDateOnlyForTimeZone(input.booking.checkOut);
  const newCheckOut = normalizeDateOnlyForTimeZone(input.newCheckOut);
  const addGuests = input.addGuests ?? [];
  const removeSet = new Set(input.removeGuestIds ?? []);

  if (newCheckOut < editableFrom) {
    throw new Error("Check-out cannot move before NZ tomorrow");
  }

  if (addGuests.length > 0 && newCheckOut <= editableFrom) {
    throw new Error("Guests can only be added when the booking has future nights");
  }

  const remainingGuests = input.booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = input.booking.guests.filter((g) => removeSet.has(g.id));
  const proposedExistingGuests = input.booking.guests.map((guest) => {
    const stayStart = normalizeDateOnlyForTimeZone(guest.stayStart ?? bookingCheckIn);
    const stayEnd = normalizeDateOnlyForTimeZone(guest.stayEnd ?? bookingCheckOut);
    // #2736: the nights this guest actually holds today. The explicit
    // `BookingGuestNight` set wins; the half-open envelope is the fallback for a
    // guest carrying no night rows at all (a legacy row, or a booking converted
    // from a request — see #2739). That is `getGuestBedNightKeys`'s own rule,
    // taken through the canonical helpers rather than re-expanded here
    // (INV-DATE-020), and for a contiguous guest the two branches agree night
    // for night.
    const heldNightKeys =
      getExplicitGuestBedNightKeys(guest) ??
      expandStayEnvelopeToNightKeys(stayStart, stayEnd);
    const stayEndKey = dateOnlyKey(stayEnd);

    const oldFutureStart = maxDate(stayStart, editableFrom);
    const oldFutureStartKey = dateOnlyKey(oldFutureStart);
    // The nights of the CURRENT stay this edit is about to reprice. Bounded by
    // the guest's own stay end exactly as the old `[oldFutureStart, stayEnd)`
    // range was, so a contiguous guest is unchanged; for a sparse one the gap
    // nights drop out, which is what stops a mid-stay removal or a shortened
    // check-out from refunding nights the guest never bought.
    //
    // WHICH nights, not what they are worth: this leg still values them at
    // TODAY's season rates, because no `lockedNightPrices` is passed (see
    // `priceGuestNightKeysCents`). After a rate rise a removal can therefore
    // credit back more than the member paid. Pre-existing on this line, frozen
    // here for the same equivalence reason, and carried as #2744.
    const oldFuturePriceCents = priceGuestNightKeysCents(
      heldNightKeys.filter(
        (key) => key >= oldFutureStartKey && key < stayEndKey
      ),
      guest,
      input.seasons
    );
    const removedFromFuture = removeSet.has(guest.id);
    const proposedStayEnd = removedFromFuture
      ? minDate(stayEnd, editableFrom)
      : newCheckOut;
    // #2029: the check-out-day extension the widened edit window opened adds
    // genuinely-new nights in [stayEnd, editableFrom) — a slice that sits INSIDE
    // the locked window (editableFrom = NZ tomorrow, but the guest's old stay
    // ended today). Anchoring the new-price window at editableFrom (as the
    // old-price window correctly does — nothing of the old stay is left to
    // reprice there) would drop that slice and hand those nights out free.
    // Start the new-price window at the guest's own stay end whenever it
    // precedes editableFrom. `maxDate(stayStart, …)` keeps a future-dated
    // partial-range guest (#713) from being charged before they arrive;
    // whenever editableFrom <= stayEnd this is byte-identical to the prior
    // `maxDate(stayStart, editableFrom)` (the mid-stay / last-night case).
    //
    // #2743 leaves this anchor exactly where it was and bounds the ADDED leg
    // instead (see `extensionStart` below). The anchor answers "from which night
    // does this edit reprice the guest", and reaching back is right for that —
    // what was wrong was letting the added leg SELL every night between a
    // departed guest's last one and the booking's own check-out.
    const newFutureStart = maxDate(stayStart, minDate(editableFrom, stayEnd));

    // #2736: the night set this edit proposes, in two parts.
    //
    //  1. KEPT — every night the guest already holds that survives the new
    //     check-out. Gaps survive as gaps: this is the whole fix. A shortened
    //     check-out drops the nights beyond it and nothing else.
    //  2. ADDED — the genuinely-new nights an extension buys, which run
    //     contiguously from the morning after the guest's last held night, and
    //     never earlier than the booking's own old check-out (#2743). They are
    //     new occupancy, so there is no pattern to preserve and expanding the
    //     envelope is the right answer for them.
    //
    // The two parts are disjoint by construction (part 1 is entirely before the
    // anchor part 2 starts at), and for a contiguous guest who holds the
    // booking's LAST night they compose to exactly `[stayStart, proposedStayEnd)`
    // — the range this used to expand — whether the edit extends, shortens, or
    // leaves the check-out alone. A guest who goes home before the booking does
    // is the shape #2743 changes: their held nights are kept, and only nights
    // past the old check-out can be added to them.
    const proposedEndKey = dateOnlyKey(proposedStayEnd);
    const keptNightKeys = heldNightKeys.filter((key) => key < proposedEndKey);
    // The morning after their last held night. Read off the night set rather
    // than off `stayEnd` so a guest whose stored envelope has drifted wider than
    // their rows still extends from where they really stop; identical to
    // `stayEnd` for every guest whose envelope agrees with their nights
    // (INV-DATE-012), and for the envelope-fallback guest by construction.
    const heldEndExclusive =
      heldNightKeys.length > 0
        ? addDaysDateOnly(
            parseDateOnly(heldNightKeys[heldNightKeys.length - 1]),
            1
          )
        : stayEnd;
    // #2743: an edit may only SELL nights the edit itself creates. The added leg
    // therefore starts no earlier than the booking's ORIGINAL check-out as well
    // as no earlier than the morning after the guest's last held night, so
    // `[bookingCheckOut, newCheckOut)` — the nights this edit adds to the
    // BOOKING — is the only ground it can ever cover. An edit that leaves the
    // check-out where it is cannot add a night to anybody.
    //
    // Without that bound the reach-back above did double duty: right when a
    // guest's stay ended one day behind the edit window (#2029's check-out-day
    // extension, where the check-out IS moving and the guest's stay end IS the
    // old check-out), wrong when it ended a week behind, because the leg then
    // ran from their last held night all the way to the new check-out whether or
    // not the check-out had moved. A #713 partial-stay guest who had gone home
    // was put back on the booking for every remaining night and charged for
    // them, on ANY edit — a name correction bought seven nights.
    //
    // The three boundaries, stated because getting one wrong either keeps that
    // over-charge or evicts somebody who is still in the lodge:
    //
    //  - STILL HERE — last held night on or after editableFrom. Every future
    //    night they hold is kept and repriced exactly as before; nothing about a
    //    mid-stay guest moves.
    //  - LEAVING TODAY — stay end equals the booking's check-out, one day behind
    //    editableFrom. #2029's case: the check-out IS moving, bookingCheckOut is
    //    behind the new nights, and the leg buys them from the same anchor and
    //    at the same price as before.
    //  - ALREADY GONE — stay end before the booking's check-out. The nights
    //    between their last one and that check-out are the rest of somebody
    //    else's stay, not something this edit created, and are no longer sold to
    //    them. Nights past the OLD check-out still are: an extension admits every
    //    remaining guest, because the software has no way to say "this one is not
    //    coming back" (INV-MOD-025 states that plainly rather than implying it).
    const extensionStart = maxDate(
      maxDate(newFutureStart, heldEndExclusive),
      bookingCheckOut
    );
    // The upper half of that intersection, `[…, newCheckOut)`, is already
    // implied: `proposedStayEnd` IS newCheckOut for a guest who stays on the
    // booking, and never later than editableFrom (hence never later than
    // newCheckOut, which was refused above if it preceded editableFrom) for a
    // guest being removed.
    const addedNightKeys = expandStayEnvelopeToNightKeys(
      extensionStart,
      proposedStayEnd
    );
    const proposedNightKeys = [
      ...new Set([...keptNightKeys, ...addedNightKeys]),
    ].sort();

    const newFutureStartKey = dateOnlyKey(newFutureStart);
    const futureNightKeys = proposedNightKeys.filter(
      (key) => key >= newFutureStartKey
    );
    const newFuturePriceCents = removedFromFuture
      ? 0
      : priceGuestNightKeysCents(futureNightKeys, guest, input.seasons);
    const futureDeltaCents = newFuturePriceCents - oldFuturePriceCents;

    return {
      guest,
      stayStart,
      stayEnd: proposedStayEnd,
      nights: proposedNightKeys.map((key) => parseDateOnly(key)),
      futureNights: futureNightKeys.map((key) => parseDateOnly(key)),
      priceCents: guest.priceCents + futureDeltaCents,
      oldFuturePriceCents,
      newFuturePriceCents,
      futureDeltaCents,
      removedFromFuture,
      futureStart: newFutureStart,
    };
  });

  // A guest ADDED to a stay already under way is admitted for the booking's
  // remaining future nights and nothing else: this plan deliberately overrides
  // whatever per-guest range or night set the request carried, exactly as it
  // did before #2736. So this window is contiguous by construction and there is
  // no sparse input to preserve — but it is still materialised as a night list,
  // so the write path, the capacity check and the per-night quote read one shape
  // for both kinds of guest.
  const addedGuestNightKeys = expandStayEnvelopeToNightKeys(
    editableFrom,
    newCheckOut
  );
  const proposedAddedGuests = addGuests.map((guest) => ({
    guest,
    stayStart: editableFrom,
    stayEnd: newCheckOut,
    nights: addedGuestNightKeys.map((key) => parseDateOnly(key)),
    priceCents: priceGuestNightKeysCents(
      addedGuestNightKeys,
      guest,
      input.seasons
    ),
  }));

  // #2029: a guest is "active in the future window" when its corrected future
  // window [futureStart, proposedStayEnd) is non-empty. Using futureStart (not
  // editableFrom) folds in the check-out-day extension night, which the old
  // `maxDate(stayStart, editableFrom) < stayEnd` test dropped (proposedStayEnd
  // could equal editableFrom on a +1 extension). Byte-identical for mid-stay /
  // last-night edits, where futureStart === editableFrom.
  //
  // #2736 states the same test over the night set instead of the window: a
  // guest is future-active when they hold at least one night from futureStart
  // on. Identical for a contiguous guest — a non-empty window is exactly a
  // non-empty run of nights — and correct for a sparse one, whose remaining
  // nights can all sit behind a window that is still nominally open.
  const futureActiveGuestCount =
    proposedExistingGuests.filter(
      (entry) => !entry.removedFromFuture && entry.futureNights.length > 0
    ).length + proposedAddedGuests.length;

  if (newCheckOut > editableFrom && futureActiveGuestCount === 0) {
    // #2736 makes one refusal this rule never used to make, and it deserves to
    // say which one it is. A guest whose remaining nights all sit BEHIND the
    // edit window still has a nominally-open window [futureStart, stayEnd), so
    // the old count called them future-active and let the edit through — leaving
    // the booking with future nights nobody occupies. The night test refuses it
    // instead, which is right, but "must have at least one guest" describes the
    // rule rather than the problem: the officer's actual mistake is the
    // check-out date, and the recoverable answer is the morning after the last
    // night anybody still holds.
    //
    // #2743 widens the same refusal to one more booking, and it is worth being
    // plain about it: a booking whose check-out is still ahead but EVERY guest's
    // stay has already finished. That edit used to go through by re-admitting
    // and charging those guests for the remaining nights; the nights are no
    // longer sold, so nobody is left holding one and the save is refused with
    // the same recoverable sentence. The booking is inconsistent — its check-out
    // claims nights no guest ever booked — and the message names the check-out
    // that matches who is actually there.
    //
    // Unreachable for a contiguous stay that runs to the booking's own
    // check-out. Such a guest, if they keep any proposed night, always holds one
    // from futureStart on (their nights are a run that starts at or before it),
    // so this branch cannot change the wording of any refusal the pre-#2736
    // arithmetic also made — which is what the 480-case matrix in
    // `booking-edit-guest-ranges-sparse.test.ts` compares. Removing every guest
    // still lands on the original sentence.
    //
    // This string is a LOG line, not operator copy: the quote route replaces it
    // with "Unable to price the requested future-night changes" and the save
    // route with "Failed to modify booking" (#1888 keeps raw messages off the
    // wire). Making the edit panel explain this properly is a UI change, not
    // this function's to make.
    const lastRemainingNightKeys = proposedExistingGuests
      .filter((entry) => !entry.removedFromFuture)
      .flatMap((entry) => entry.nights.map(dateOnlyKey))
      .sort();
    const lastRemainingNightKey =
      lastRemainingNightKeys[lastRemainingNightKeys.length - 1];
    if (lastRemainingNightKey !== undefined) {
      const workableCheckOut = dateOnlyKey(
        addDaysDateOnly(parseDateOnly(lastRemainingNightKey), 1)
      );
      throw new Error(
        `No remaining guest is booked for a night on or after ${dateOnlyKey(editableFrom)}, ` +
          `so the nights up to the new check-out ${dateOnlyKey(newCheckOut)} would be unoccupied. ` +
          `Set the check-out to ${workableCheckOut} instead.`
      );
    }
    throw new Error("Booking must have at least one guest for future nights");
  }

  const newTotalPriceCents =
    proposedExistingGuests.reduce((sum, entry) => sum + entry.priceCents, 0) +
    proposedAddedGuests.reduce((sum, entry) => sum + entry.priceCents, 0);
  const newDiscountCents = input.booking.discountCents;
  const newPromoAdjustmentCents = input.booking.promoAdjustmentCents;
  const newFinalPriceCents = newTotalPriceCents + newPromoAdjustmentCents;
  const priceDiffCents = newFinalPriceCents - input.booking.finalPriceCents;
  const futureExistingDeltaCents = proposedExistingGuests.reduce(
    (sum, entry) => sum + entry.futureDeltaCents,
    0
  );
  const capacityGuestRanges = [
    ...proposedExistingGuests
      .filter(
        (entry) => !entry.removedFromFuture && entry.futureNights.length > 0
      )
      .map((entry) => ({
        // #2029: anchor the checked range at the guest's corrected futureStart,
        // not editableFrom, so the genuinely-new check-out-day night is inside
        // the window the capacity resolver iterates (it would otherwise be
        // invisible and overbookable). Unchanged for mid-stay / last-night.
        stayStart: entry.futureStart,
        stayEnd: entry.stayEnd,
        // #2736: the window still bounds which nights are examined; the night
        // set decides which of them this guest actually occupies. Expanding to
        // the same nights for a contiguous guest, so no ordinary edit's capacity
        // verdict moves.
        nights: entry.futureNights,
        memberId: entry.guest.memberId ?? null,
      })),
    ...proposedAddedGuests.map((entry) => ({
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
      nights: entry.nights,
      memberId: entry.guest.memberId ?? null,
    })),
  ];

  // #2029: the capacity window must start no later than the earliest checked
  // night. Seed at editableFrom (so it is never pushed later than today+1) and
  // pull it back to the earliest range start — which drops to the check-out-day
  // night for such an extension, and stays editableFrom for every mid-stay edit.
  const capacityRangeStart = capacityGuestRanges.reduce(
    (earliest, range) => (range.stayStart < earliest ? range.stayStart : earliest),
    editableFrom
  );

  return {
    proposedExistingGuests,
    proposedAddedGuests,
    remainingGuests,
    removedGuests,
    newTotalPriceCents,
    newDiscountCents,
    newPromoAdjustmentCents,
    newFinalPriceCents,
    priceDiffCents,
    futureExistingDeltaCents,
    futureActiveGuestCount,
    capacityGuestRanges,
    capacityRangeStart,
  };
}
