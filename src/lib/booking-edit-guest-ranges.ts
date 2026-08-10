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
  // The guest's CANONICAL night set — their `BookingGuestNight` rows (#2736),
  // each carrying what that night was SOLD for (#2744).
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
  //
  // `priceCents` was the same story a second time (#2744). The loaded rows carry
  // it — `LoadedBookingForModify` types it, and `lockedNightPricesForGuest`
  // reads exactly this column on every other edit path — but this plan's type
  // stopped at `GuestNightInput`, so the one thing that says what the member
  // actually paid for a night was invisible here and every night was valued at
  // today's rate instead.
  nights?: ReadonlyArray<StoredGuestNight> | null;
  priceCents: number;
}

/**
 * One loaded `BookingGuestNight` row as this plan reads it: the night, and what
 * the member was charged for it (#2744).
 *
 * `GuestNightInput` (a bare `Date`, a `yyyy-MM-dd` string, or `{ stayDate }`) is
 * what the canonical stay-range helpers accept and is kept in the union so a
 * caller holding any of those shapes still type-checks. The extra member is
 * assignable to `{ stayDate }`, so the night set still flows into
 * `getExplicitGuestBedNightKeys` unchanged; the price is simply no longer
 * dropped on the floor on the way in.
 */
type StoredGuestNight =
  | GuestNightInput
  | { stayDate: Date | string; priceCents?: number | null };

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
  // nights a check-out extension adds after their last one. This, NOT
  // `[stayStart, stayEnd)`, is what gets priced, quoted per night and written
  // back as `BookingGuestNight` rows, so an internal gap stays a gap
  // (INV-MOD-025). For a contiguous guest it IS `[stayStart, stayEnd)`, night
  // for night, which is what makes the change a no-op for every ordinary stay.
  nights: Date[];
  // #2744: what each of `nights` is worth, in the same order and in integer
  // cents, summing EXACTLY to `priceCents`. This is what gets written to
  // `BookingGuestNight.priceCents`, and therefore what the NEXT edit is told the
  // member paid — so it is each night's real rate (the price it was sold at for
  // a night the guest already held, the current season rate for a night this
  // edit newly buys), not the guest's total divided by their night count. See
  // `composeProposedNightPrices` for the one case that still has to average.
  perNightCents: number[];
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
  // #2744: what each of `nights` costs, in order, summing exactly to
  // `priceCents`. Every night here is newly bought, so each is its own current
  // season rate straight from `calculateBookingPrice` — a guest added across a
  // season boundary now stores 50/50/90/90 rather than four averaged 70s.
  perNightCents: number[];
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
 * What the guest was CHARGED for each night they already hold, by NZ date-only
 * key (#2744) — read straight off their loaded `BookingGuestNight` rows, which
 * is the same column `lockedNightPricesForGuest` hands every other edit path.
 *
 * A night with no row, or a row loaded without its price, is simply absent: that
 * night has no recoverable sold price and prices at the current season rate,
 * which is exactly what INV-MOD-005 already says happens to a legacy guest
 * carrying no night rows. Absence is therefore a documented, pre-existing
 * degradation rather than a new silent fallback — but it IS a degradation, and
 * for a booking that predates `BookingGuestNight` it means the old behaviour:
 * the night is credited back at today's rate.
 */
function storedNightPricesByKey(
  guest: Pick<ExistingBookingEditGuest, "nights">
): Map<string, number> {
  const byKey = new Map<string, number>();
  for (const entry of guest.nights ?? []) {
    if (entry instanceof Date || typeof entry === "string") {
      continue;
    }
    const priceCents = "priceCents" in entry ? entry.priceCents : undefined;
    if (typeof priceCents !== "number" || !Number.isFinite(priceCents)) {
      continue;
    }
    const stayDate =
      typeof entry.stayDate === "string"
        ? parseDateOnly(entry.stayDate)
        : entry.stayDate;
    byKey.set(dateOnlyKey(stayDate), priceCents);
  }
  return byKey;
}

/**
 * Price EXACTLY these nights, in integer cents, and say what each one costs.
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
 * Integer cents throughout: every term is either a stored `priceCents` or a
 * `pricePerNightCents` integer, summed by `calculateBookingPrice`
 * (INV-MONEY-001, INV-MONEY-003). No float, no parse, no rounding.
 *
 * #2744: `lockedNightPrices` is now passed, which is what brings this plan into
 * line with INV-MOD-005 — "a night a guest already bought keeps the price stored
 * on its `BookingGuestNight` row … removing one returns exactly theirs". Every
 * other edit path already did this; the in-progress plan was the sole exception,
 * so a night given back after a rate rise was credited at TODAY's rate and the
 * club refunded more than it had ever charged. The locks are passed to BOTH
 * legs, deliberately: a night the guest keeps then carries the same price in the
 * old window and the new one and cancels exactly, so an extension is untouched
 * and no held night is ever re-rated (INV-MOD-005, INV-MOD-006). Passing them to
 * the old leg alone would have made every extension reprice the nights the
 * member had already bought — the very thing the locked-price rule exists to
 * prevent.
 *
 * `perNightCents` is parallel to `nightKeys`, and that alignment is structural
 * rather than hoped for: `calculateBookingPrice` prices a guest's explicit
 * nights deduped and sorted ascending, and `nightKeys` reaches here already
 * deduped (through a `Set`) and sorted, so the two are the same nights in the
 * same order. It matters because these amounts are written per night — a
 * misalignment would put one night's price on another night's row — so the
 * contiguous matrix in `booking-edit-guest-ranges-sparse.test.ts` re-asserts
 * length and sum on every one of its cases against the real pricing function.
 */
function priceGuestNights(
  nightKeys: readonly string[],
  guest: Pick<
    ExistingBookingEditGuest,
    "ageTier" | "isMember" | "rateMembershipTypeId" | "rateSource"
  >,
  seasons: SeasonRateData[],
  lockedNightPricesByKey?: ReadonlyMap<string, number>
): { totalCents: number; perNightCents: number[] } {
  if (nightKeys.length === 0) {
    return { totalCents: 0, perNightCents: [] };
  }
  const nights = nightKeys.map((key) => parseDateOnly(key));
  // Keyed by night, so an entry for a night outside this leg simply never
  // matches; `calculateBookingPrice` looks a lock up per priced night.
  const lockedNightPrices = [...(lockedNightPricesByKey ?? new Map())].map(
    ([stayDate, priceCents]) => ({ stayDate, priceCents })
  );

  const breakdown = calculateBookingPrice(
    nights[0],
    addDaysDateOnly(nights[nights.length - 1], 1),
    [{
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      rateMembershipTypeId: guest.rateMembershipTypeId,
      rateSource: guest.rateSource,
      nights,
      lockedNightPrices,
    }],
    seasons
  );
  return {
    totalCents: breakdown.totalPriceCents,
    perNightCents: breakdown.guests[0].perNightCents,
  };
}

/**
 * Split `totalCents` evenly across `count` nights in integer cents, the
 * remainder spread one cent at a time over the earliest nights so the parts sum
 * back to the total EXACTLY — for a negative total too, where `Math.floor`
 * rounds away from zero and the remainder is added back cent by cent
 * (INV-MONEY-001, INV-MONEY-003).
 *
 * This is the fallback, not the rule: see `composeProposedNightPrices`.
 */
function distributeEvenlyCents(totalCents: number, count: number): number[] {
  if (count <= 0) {
    return [];
  }
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  const parts: number[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(base + (i < remainder ? 1 : 0));
  }
  return parts;
}

/**
 * What to write on each of a guest's proposed night rows (#2744).
 *
 * The rows this returns become `BookingGuestNight.priceCents`, which is the only
 * record of what a night was sold for and therefore what the NEXT edit is told
 * the member paid. They used to be the guest's total divided by their night
 * count, so an edit spanning a season boundary stored the average — four nights
 * of 50/50/90/90 written back as four 70s, and the next edit charging 70 for a
 * 50-cent night and 70 for a 90-cent one. Sums reconciled, so nothing went out
 * of balance; the snapshot simply was not the price list.
 *
 * Two parts, and the split between them is the edit window:
 *
 *  - FUTURE nights — the ones this edit prices — take the amounts
 *    `calculateBookingPrice` just produced: the locked price for a night the
 *    guest already held, the current season rate for a night newly bought.
 *  - PAST nights — the ones behind the window, which this edit does not touch —
 *    keep the prices already stored against them.
 *
 * The whole list must sum to `totalCents` (= the guest's stored total plus this
 * edit's delta), because that is the number written to `BookingGuest.priceCents`
 * and summed into the booking total; a per-night list that disagreed with it
 * would leave a phantom balance the moment Xero rebuilt its lines from the runs.
 * The future part sums to its own total by construction, so the real rates can
 * be written only when the stored past prices account EXACTLY for the rest —
 * every past night has one, and together they come to `totalCents` less the
 * future part. That is the ordinary case, and it is what makes the rows honest.
 *
 * Anything else falls back to the even split this function replaced, over the
 * guest's whole night list — the behaviour every in-progress edit had before.
 * It covers a guest whose rows carry no prices at all (pre-#713, or a booking
 * converted from a request) and a guest whose stored total has drifted from
 * their rows: in both, the per-night record does not support the total, so
 * inventing a distribution from it would be a guess dressed as a rate. Falling
 * back rather than improvising also means a guest with no stored per-night
 * prices comes out of this function EXACTLY where they came out before — the
 * same amounts on the same nights — so the change reaches only guests whose real
 * rates are actually recoverable.
 */
function composeProposedNightPrices(args: {
  pastNightKeys: readonly string[];
  futureNightKeys: readonly string[];
  futurePerNightCents: readonly number[];
  storedNightPriceByKey: ReadonlyMap<string, number>;
  totalCents: number;
}): number[] {
  const futureTotalCents = args.futurePerNightCents.reduce(
    (sum, cents) => sum + cents,
    0
  );
  const pastTotalCents = args.totalCents - futureTotalCents;
  const storedPastCents = args.pastNightKeys.map((key) =>
    args.storedNightPriceByKey.get(key)
  );
  // `null` the moment one past night has no stored price — an unknown night
  // cannot be part of a total that adds up. An empty past list sums to 0, which
  // is the guest whose every proposed night is priced by this edit.
  const storedPastTotalCents = storedPastCents.reduce<number | null>(
    (sum, cents) => (sum === null || cents === undefined ? null : sum + cents),
    0
  );

  if (storedPastTotalCents === pastTotalCents) {
    return [...(storedPastCents as number[]), ...args.futurePerNightCents];
  }
  return distributeEvenlyCents(
    args.totalCents,
    args.pastNightKeys.length + args.futureNightKeys.length
  );
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
 * For a contiguous stay every output here is identical to that envelope
 * arithmetic — to the cent, to the night, to the capacity range and to the
 * thrown error. That equivalence is the property that makes the rule safe on
 * live bookings, and `booking-edit-guest-ranges-sparse.test.ts` proves it by
 * re-implementing the old maths and comparing, rather than asserting it.
 *
 * **Value a night at what it was sold for, not at today's rate (#2744).** The
 * guest's stored `BookingGuestNight.priceCents` is passed as `lockedNightPrices`
 * to both pricing legs, so a night given back is credited at the price the
 * member actually paid and a night they keep cancels between the two windows
 * exactly as before (INV-MOD-005). The per-night amounts written back are those
 * same real rates rather than the guest's total divided by their night count.
 * The equivalence above still holds, and is still proved rather than asserted:
 * a stay whose stored per-night prices equal the current season rates — every
 * booking where no rate has moved since it was made — comes out cent for cent
 * where it did, and so does a guest carrying no stored prices at all. What DOES
 * move, deliberately, is a refund on a stay whose rate has changed since: it is
 * now what the club charged rather than what it would charge today.
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
    // #2744: what this guest was charged for each night they already hold. Every
    // night that has one is priced at it in BOTH windows below, so a night given
    // back is credited at the price it was sold for and a night kept still
    // cancels between the two (INV-MOD-005).
    const storedNightPriceByKey = storedNightPricesByKey(guest);

    const oldFutureStart = maxDate(stayStart, editableFrom);
    const oldFutureStartKey = dateOnlyKey(oldFutureStart);
    // The nights of the CURRENT stay this edit is about to reprice. Bounded by
    // the guest's own stay end exactly as the old `[oldFutureStart, stayEnd)`
    // range was, so a contiguous guest is unchanged; for a sparse one the gap
    // nights drop out, which is what stops a mid-stay removal or a shortened
    // check-out from refunding nights the guest never bought.
    //
    // And what they are worth: each at the price it was SOLD for (#2744), via
    // the locked prices below, falling back to the current season rate only for
    // a night that has no stored price to recover. This is the leg a removal or
    // a shortened check-out credits back, so it is the one that decides whether
    // the club hands back what it took.
    const oldFuturePriceCents = priceGuestNights(
      heldNightKeys.filter(
        (key) => key >= oldFutureStartKey && key < stayEndKey
      ),
      guest,
      input.seasons,
      storedNightPriceByKey
    ).totalCents;
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
    // precedes editableFrom, so futureDelta always equals exactly the added
    // nights [stayEnd, newCheckOut) per guest. `maxDate(stayStart, …)` keeps a
    // future-dated partial-range guest (#713) from being charged before they
    // arrive; whenever editableFrom <= stayEnd this is byte-identical to the
    // prior `maxDate(stayStart, editableFrom)` (the mid-stay / last-night case).
    //
    // KNOWN AND FROZEN (#2743): the reach-back is right when the guest's stay
    // ended one day behind editableFrom and wrong when it ended a week behind —
    // a #713 partial-stay guest who has already gone home is re-admitted for the
    // booking's remaining nights and charged for them, on ANY edit, including one
    // that does not move the check-out. That is what the pre-#2736 arithmetic
    // did too (the matrix proves the two agree on it), so correcting it here
    // would trade away the equivalence that makes #2736 safe. It is a money
    // decision of its own; #2743 carries the options.
    const newFutureStart = maxDate(stayStart, minDate(editableFrom, stayEnd));

    // #2736: the night set this edit proposes, in two parts.
    //
    //  1. KEPT — every night the guest already holds that survives the new
    //     check-out. Gaps survive as gaps: this is the whole fix. A shortened
    //     check-out drops the nights beyond it and nothing else.
    //  2. ADDED — the genuinely-new nights an extension buys, which run
    //     contiguously from the morning after the guest's last held night to
    //     the new check-out. They are new occupancy, so there is no pattern to
    //     preserve and expanding the envelope is the right answer for them.
    //
    // The two parts are disjoint by construction (part 1 is entirely before the
    // anchor part 2 starts at), and for a CONTIGUOUS guest they compose to
    // exactly `[stayStart, proposedStayEnd)` — the range this used to expand —
    // whether the edit extends, shortens, or leaves the check-out alone.
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
    const addedNightKeys = expandStayEnvelopeToNightKeys(
      maxDate(newFutureStart, heldEndExclusive),
      proposedStayEnd
    );
    const proposedNightKeys = [
      ...new Set([...keptNightKeys, ...addedNightKeys]),
    ].sort();

    const newFutureStartKey = dateOnlyKey(newFutureStart);
    const futureNightKeys = proposedNightKeys.filter(
      (key) => key >= newFutureStartKey
    );
    // #2744: the same locked prices go into the NEW window too. A night the
    // guest keeps therefore carries one price on both sides of the difference
    // and cancels to nothing, which is why an extension's delta is still exactly
    // the nights it adds and no night anybody already bought is ever re-rated
    // (INV-MOD-005). Only genuinely-new nights reach a season lookup.
    const newFuture = removedFromFuture
      ? // A removed guest holds no future night — `proposedStayEnd` collapses to
        // the edit window, so `futureNightKeys` is empty and this maps to `[]`.
        // Written as a zero per night rather than a bare `[]` so the per-night
        // list stays the same length as the night list by construction.
        { totalCents: 0, perNightCents: futureNightKeys.map(() => 0) }
      : priceGuestNights(
          futureNightKeys,
          guest,
          input.seasons,
          storedNightPriceByKey
        );
    const newFuturePriceCents = newFuture.totalCents;
    const futureDeltaCents = newFuturePriceCents - oldFuturePriceCents;
    const priceCents = guest.priceCents + futureDeltaCents;

    return {
      guest,
      stayStart,
      stayEnd: proposedStayEnd,
      nights: proposedNightKeys.map((key) => parseDateOnly(key)),
      perNightCents: composeProposedNightPrices({
        pastNightKeys: proposedNightKeys.filter(
          (key) => key < newFutureStartKey
        ),
        futureNightKeys,
        futurePerNightCents: newFuture.perNightCents,
        storedNightPriceByKey,
        totalCents: priceCents,
      }),
      futureNights: futureNightKeys.map((key) => parseDateOnly(key)),
      priceCents,
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
  const proposedAddedGuests = addGuests.map((guest) => {
    // No stored night prices to honour: every night is being bought now, so each
    // one is its own current season rate and the per-night amounts are simply
    // what pricing returned — no average, and the sum is the total by
    // construction (#2744).
    const priced = priceGuestNights(addedGuestNightKeys, guest, input.seasons);
    return {
      guest,
      stayStart: editableFrom,
      stayEnd: newCheckOut,
      nights: addedGuestNightKeys.map((key) => parseDateOnly(key)),
      perNightCents: priced.perNightCents,
      priceCents: priced.totalCents,
    };
  });

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
    // Unreachable for a contiguous stay. A contiguous guest who keeps any
    // proposed night always holds one from futureStart on (their nights are a
    // run that starts at or before it), so this branch cannot change the wording
    // of any refusal the pre-#2736 arithmetic also made — which is what the
    // 480-case matrix in `booking-edit-guest-ranges-sparse.test.ts` compares.
    // Removing every guest still lands on the original sentence.
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
