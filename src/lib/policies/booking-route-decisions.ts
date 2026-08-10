import { BookingStatus, type AgeTier, type SeasonType } from "@prisma/client";
import {
  calculateBookingPrice,
  getStayNights,
  isGroupDiscountApplicable,
  type GroupDiscountConfig,
  type GuestInput,
  type PriceBreakdown,
  type SeasonRateData,
  type UnratedGuestInput,
} from "@/lib/pricing";
import {
  countActiveGuestsForNight,
  type GuestNightInput,
} from "@/lib/booking-guest-stay-ranges";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import {
  calculateAppliedCreditRestore,
  calculateDualRefundAmounts,
  daysUntilDate,
  type CancellationRule,
} from "./cancellation";

export type { CancellationRule };

export interface GroupDiscountSettingLike {
  enabled: boolean;
  minGroupSize: number;
  summerOnly: boolean;
  // Rate membership type substituted for NON_MEMBER_DEFAULT guests in a
  // qualifying group (#1930, E4). Seeded to the built-in FULL type.
  rateMembershipTypeId?: string | null;
}

/**
 * The same setting, read by an EDIT path, where `applyToEdits` is load-bearing
 * (#2770, INV-MOD-026).
 *
 * It is REQUIRED here rather than optional-with-a-default, and that is the
 * point. `GroupDiscountSetting` is read with a narrow `select` in at least one
 * place already (the public fee-page tokens select `enabled`/`minGroupSize`/
 * `summerOnly` only), so an optional field would let a future narrow select
 * disarm the club's switch silently — the switch would read as ON because the
 * column was never fetched, which is exactly the failure mode a money setting
 * cannot have. Requiring it makes that a typecheck failure instead.
 */
export interface EditTimeGroupDiscountSettingLike
  extends GroupDiscountSettingLike {
  applyToEdits: boolean;
}

export interface SeasonRateSource {
  id: string;
  startDate: Date;
  endDate: Date;
  type?: SeasonType;
  // Membership-type-keyed rate rows (#1930, E4) — the ONLY nightly-rate source.
  // Load from Season.membershipTypeRates. The legacy member/non-member
  // boolean-keyed SeasonRate table and its `rates` relation no longer exist:
  // the #2129 step 2 contract migration
  // 20260721120000_contract_drop_season_rate (Release B) dropped them. Do not
  // reintroduce a boolean member/non-member rate key.
  membershipTypeRates: Array<{
    membershipTypeId: string;
    ageTier: AgeTier | null;
    pricePerNightCents: number;
  }>;
}

export interface GuestPricingSource {
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // Explicit included nights (issue #713). Passed through to pricing so a
  // guest with a non-contiguous stay is priced for exactly those nights.
  nights?: ReadonlyArray<GuestNightInput> | null;
}

/**
 * The group-discount config for a FIRST purchase: booking creation, the public
 * quote, a group booking, a school/booking-request approval, and the waitlist
 * offer reprice that re-bases a booking at current rates before the member
 * confirms. None of those is a later edit to nights somebody already holds, so
 * none of them consults the #2770 switch.
 *
 * An EDIT path must call {@link toEditTimeGroupDiscountConfig} instead, and
 * `group-discount-edit-switch-census.test.ts` fails the build if it does not:
 * the two mappers differ only by one boolean, so nothing in the type system can
 * tell a mistake here from a deliberate choice.
 */
export function toGroupDiscountConfig(
  setting: GroupDiscountSettingLike | null | undefined
): GroupDiscountConfig | undefined {
  if (!setting?.enabled) {
    return undefined;
  }

  return {
    minGroupSize: setting.minGroupSize,
    summerOnly: setting.summerOnly,
    enabled: true,
    rateMembershipTypeId: setting.rateMembershipTypeId ?? null,
  };
}

/**
 * The group-discount config for an EDIT to an existing booking — the ONE place
 * the club's `applyToEdits` switch is applied (#2770, INV-MOD-026).
 *
 * Every edit path resolves its config here: the ordinary planner
 * (`calculateModifiedPricing`), the date-modification service, the guest-add
 * route, the single-guest-removal service, and the modify-quote preview. There
 * is deliberately no second gate anywhere else. The rule the switch exists to
 * protect is that no edit path can price a night differently from another
 * (#2756 was one planner reading a different config from the rest), and one
 * chokepoint is the only shape that keeps that true as paths are added.
 *
 * Returning `undefined` when the switch is off is what makes an off club price
 * byte-identically to a club with the discount disabled: it is the same absent
 * config, down the same code path, not a second discount rule with a zero rate.
 * Nights a guest already bought are untouched in both states — they carry their
 * stored `BookingGuestNight.priceCents` as locked prices (INV-MOD-005), which
 * pricing honours regardless of any config passed here.
 */
export function toEditTimeGroupDiscountConfig(
  setting: EditTimeGroupDiscountSettingLike | null | undefined
): GroupDiscountConfig | undefined {
  if (!setting?.applyToEdits) {
    return undefined;
  }

  return toGroupDiscountConfig(setting);
}

/**
 * What a member or officer is told when the club runs a group discount but has
 * switched it off for later edits (#2770 D2, INV-MOD-026).
 *
 * Derived FROM the mapper rather than from a second reading of the column, on
 * purpose: the quote can then never say "these nights are not discounted" while
 * the same request discounts them, or stay silent while it does not. One
 * condition, one answer, quote and charge in lockstep (#1095).
 *
 * `null` in both of the other states, because neither has anything to explain: a
 * club with no group discount is not withholding one, and a club whose switch is
 * on is giving it.
 */
export const GROUP_DISCOUNT_EDIT_OFF_NOTICE =
  "Group discount does not apply to nights added after booking. Nights already booked keep the price they were booked at.";

export function groupDiscountEditNotice(
  setting: EditTimeGroupDiscountSettingLike | null | undefined
): string | null {
  if (!setting?.enabled) {
    return null;
  }
  return toEditTimeGroupDiscountConfig(setting)
    ? null
    : GROUP_DISCOUNT_EDIT_OFF_NOTICE;
}

export function toSeasonRateData(seasons: SeasonRateSource[]): SeasonRateData[] {
  return seasons.map((season) => ({
    seasonId: season.id,
    startDate: season.startDate,
    endDate: season.endDate,
    type: season.type,
    rates: season.membershipTypeRates.map((rate) => ({
      membershipTypeId: rate.membershipTypeId,
      ageTier: rate.ageTier,
      pricePerNightCents: rate.pricePerNightCents,
    })),
  }));
}

export function toGuestPricingInputs(
  guests: GuestPricingSource[],
): UnratedGuestInput[] {
  return guests.map((guest) => ({
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? undefined,
    stayStart: guest.stayStart ?? undefined,
    stayEnd: guest.stayEnd ?? undefined,
    nights: guest.nights ?? undefined,
  }));
}

export function priceBookingGuests(input: {
  checkIn: Date;
  checkOut: Date;
  guests: GuestInput[];
  seasons: SeasonRateData[];
  groupDiscount?: GroupDiscountConfig;
}): PriceBreakdown {
  return calculateBookingPrice(
    input.checkIn,
    input.checkOut,
    input.guests,
    input.seasons,
    input.groupDiscount
  );
}

/**
 * Price the deferred non-member "guest portion" (#2003) — the SINGLE server
 * function both the booking quote and booking-create use for the split child.
 *
 * A split party (#738) charges the member places up front and defers the
 * non-member guests to a provisional linked child; that child's
 * `finalPriceCents` is booking-create pricing the NON-MEMBER SUBSET ALONE. This
 * function reproduces exactly that: filter to the non-members, then price them
 * with `priceBookingGuestsWithMembershipTypePolicy` in the same call shape
 * booking-create uses (no `ownerMemberId`; the same `groupDiscount`).
 *
 * Why the subset — not the whole party — is the source of truth: the group
 * discount only substitutes a cheaper rate when ENOUGH ACTIVE GUESTS share a
 * night (`isGroupDiscountApplicable` / `countActiveGuestsForNight`). The
 * non-member subset can fall UNDER `minGroupSize` even when the whole party
 * meets it, so the whole party's non-member rows can be group-discounted while
 * the subset the child is actually charged is not. Summing the whole-party
 * non-member rows for the review banner therefore UNDER-QUOTES the deferred
 * charge under group discounts (the surprise direction). Pricing the subset
 * here — the same input booking-create charges — is what makes the review
 * banner equal the real charge.
 *
 * Returns null when the party has no non-member guests (nothing is deferred);
 * otherwise the subset's server `PriceBreakdown` (money in integer cents). This
 * is a pure pricing read — it performs no writes.
 */
export async function priceDeferredNonMemberPortion(
  db: unknown,
  input: {
    checkIn: Date;
    checkOut: Date;
    guests: readonly GuestPricingSource[];
    seasons: SeasonRateData[];
    groupDiscount?: GroupDiscountConfig;
  }
): Promise<PriceBreakdown | null> {
  const nonMemberGuests = input.guests.filter((guest) => !guest.isMember);
  if (nonMemberGuests.length === 0) {
    return null;
  }
  return priceBookingGuestsWithMembershipTypePolicy(db, {
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guests: toGuestPricingInputs(nonMemberGuests),
    seasons: input.seasons,
    groupDiscount: input.groupDiscount,
  });
}

export function isGroupDiscountAppliedToBooking(input: {
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  // Only stay ranges are read (via countActiveGuestsForNight), so unrated
  // guests are accepted — the rate membership type is irrelevant here.
  guests?: UnratedGuestInput[];
  seasons: SeasonRateData[];
  groupDiscount?: GroupDiscountConfig;
}): boolean {
  const { checkIn, checkOut, guestCount, guests, seasons, groupDiscount } = input;
  if (!groupDiscount?.enabled) {
    return false;
  }

  if (guests) {
    return getStayNights(checkIn, checkOut).some((night) =>
      isGroupDiscountApplicable(
        countActiveGuestsForNight(guests, night, { checkIn, checkOut }),
        night,
        seasons,
        groupDiscount
      )
    );
  }

  if (guestCount < groupDiscount.minGroupSize) return false;
  if (!groupDiscount.summerOnly) {
    return true;
  }

  return seasons.some(
    (season) =>
      season.type === "SUMMER" &&
      season.startDate < checkOut &&
      season.endDate >= checkIn
  );
}

function calculateHoldDaysUntilCheckIn(
  checkIn: Date,
  now: Date = new Date()
): number {
  // Math.ceil keeps any fractional day over the threshold pending; cancellation
  // refund tier lookups deliberately use floor semantics instead.
  return Math.ceil(
    (checkIn.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );
}

export function calculateBookingHoldDecision(input: {
  hasNonMembers: boolean;
  checkIn: Date;
  holdDays: number;
  holdEnabled?: boolean;
  now?: Date;
}): {
  daysUntilCheckIn: number;
  holdEnabled: boolean;
  shouldBePending: boolean;
  status: BookingStatus;
} {
  const daysUntilCheckIn = calculateHoldDaysUntilCheckIn(input.checkIn, input.now);
  const holdEnabled = input.holdEnabled ?? true;
  const shouldBePending =
    holdEnabled && input.hasNonMembers && daysUntilCheckIn > input.holdDays;

  return {
    daysUntilCheckIn,
    holdEnabled,
    shouldBePending,
    status: shouldBePending ? BookingStatus.PENDING : BookingStatus.PAYMENT_PENDING,
  };
}

export function calculateBookingCreditApplication(input: {
  requestedCreditCents: number;
  creditBalanceCents: number;
  finalPriceCents: number;
  status: BookingStatus;
}): {
  creditAppliedCents: number;
  effectivePriceCents: number;
} {
  const { requestedCreditCents, creditBalanceCents, finalPriceCents, status } = input;
  if (requestedCreditCents <= 0 || status !== BookingStatus.PAYMENT_PENDING) {
    return {
      creditAppliedCents: 0,
      effectivePriceCents: finalPriceCents,
    };
  }

  if (requestedCreditCents > creditBalanceCents) {
    throw new Error(
      `Insufficient credit: ${creditBalanceCents} cents available, ${requestedCreditCents} requested`
    );
  }
  if (requestedCreditCents > finalPriceCents) {
    throw new Error(
      `Credit amount (${requestedCreditCents}) exceeds booking price (${finalPriceCents})`
    );
  }

  return {
    creditAppliedCents: requestedCreditCents,
    effectivePriceCents: finalPriceCents - requestedCreditCents,
  };
}

export function calculateCancellationPreview(input: {
  payment: {
    amountCents: number;
    refundedAmountCents: number;
    changeFeeCents: number;
    creditAppliedCents?: number | null;
  };
  finalPriceCents: number;
  checkIn: Date;
  policyRules: CancellationRule[];
  now?: Date;
}): {
  refundAmountCents: number;
  keptAmountCents: number;
  changeFeeCents: number;
  refundPercentage: number;
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
  creditRestoredCents: number;
  totalPaidCents: number;
} {
  const paidAmountCents =
    input.payment.amountCents - input.payment.refundedAmountCents;
  const changeFeeCents = input.payment.changeFeeCents;
  // Same refundable-base cap as cancelBooking (#1031): the preview must not
  // promise a refund the stale Payment mirror can no longer back.
  const refundableBaseCents =
    Math.min(paidAmountCents, input.finalPriceCents + changeFeeCents) -
    changeFeeCents;
  const days = daysUntilDate(input.checkIn, input.now);
  const {
    cardRefundAmountCents,
    cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
  } = calculateDualRefundAmounts(refundableBaseCents, days, input.policyRules);

  return {
    refundAmountCents: cardRefundAmountCents,
    keptAmountCents: paidAmountCents - cardRefundAmountCents,
    changeFeeCents,
    refundPercentage: cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
    // Applied-credit slice is tiered by the SAME card tier as the card slice
    // (#1164 / D7), no longer restored at 100%. Fed the same refundableBaseCents
    // and days so preview == actual cancel.
    creditRestoredCents: calculateAppliedCreditRestore(
      input.payment.creditAppliedCents ?? 0,
      refundableBaseCents,
      days,
      input.policyRules,
    ).creditRestoredCents,
    totalPaidCents: paidAmountCents,
  };
}
