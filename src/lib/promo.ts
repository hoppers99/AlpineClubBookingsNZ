import { Prisma, PromoCodeType, type FixedNightlyMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  calculatePromoDiscount,
  selectPromoDiscountGuests,
  type PromoCodeInput,
  type PromoDiscountAllocation,
  type PromoDiscountGuest,
  type PromoDiscountResult,
} from "@/lib/pricing";
import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";
import {
  getWorkPartyNightWindowForPromo,
  restrictPerNightRatesToWindow,
} from "@/lib/work-party";
import { ApiError } from "@/lib/api-error";

export const PROMO_LODGE_RESTRICTION_MESSAGE =
  "This promo code cannot be used at this lodge.";

type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type PromoUsageClient = typeof prisma | Prisma.TransactionClient;

export interface PromoValidationResult {
  valid: boolean;
  error?: string;
  requiresGuestSelection?: boolean;
  selectableGuestIndexes?: number[];
  selectedGuestIndexes?: number[];
  promoCode?: {
    id: string;
    code: string;
    description: string | null;
    type: PromoCodeType;
    valueCents: number | null;
    percentOff: number | null;
    freeNightsPerIndividual: number | null;
    lifetimeFreeNightsCap: number | null;
    fixedNightlyPriceCents: number | null;
    fixedNightlyMode: FixedNightlyMode | null;
    maxGuestsPerBooking: number | null;
    maxNightlyValueCents: number | null;
    memberGuestsOnly: boolean;
    assignedMembersOnlyOwnNights: boolean;
  };
  discountCents?: number;
  promoAdjustmentCents?: number;
  freeNightsUsed?: number;
  eligibleGuestCount?: number;
  remainingFreeNights?: number;
  allocations?: PromoBeneficiaryAllocation[];
}

export interface PromoBeneficiaryAllocation {
  memberId: string;
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number;
}

export interface AvailablePromoCode {
  code: string;
  description: string | null;
  type: PromoCodeType;
  percentOff: number | null;
  valueCents: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: FixedNightlyMode | null;
}

export interface AssignedPromoCodeSummary extends AvailablePromoCode {
  id: string;
  assignedAt: Date | null;
  // lifetimeFreeNightsCap is inherited from AvailablePromoCode and represents
  // the maximum free nights this member can ever claim from this code.
  active: boolean;
  archivedAt: Date | null;
  validFrom: Date | null;
  validUntil: Date | null;
  bookingStartFrom: Date | null;
  bookingStartUntil: Date | null;
  maxRedemptionsTotal: number | null;
  currentRedemptions: number;
  maxUsesPerMember: number | null;
  redemptionCount: number;
  freeNightsUsed: number;
  visibleToMember: boolean;
  statusReason: string;
}

/**
 * PromoDiscountGuest plus the date of perNightRates[0] (the guest's
 * effective stay start when the rates were priced). Required to apply an
 * internal work party promo's night window; without it those guests'
 * nights are excluded from the discount (fail safe, never over-discount).
 */
interface PromoDiscountGuestWithNights extends PromoDiscountGuest {
  firstNight?: Date | null;
  // Actual dates of each entry in perNightRates (issue #713), parallel to that
  // array. Used to restrict an internal work-party promo to its night window
  // correctly when the guest stays non-contiguous nights. Falls back to
  // positional dates from firstNight when omitted.
  nightDates?: Date[] | null;
}

export interface BookingDetailsForPromo {
  totalPriceCents: number;
  memberId: string;
  guests: PromoDiscountGuestWithNights[];
  bookingCheckIn?: Date;
}

export interface PromoApplicationSubject extends PromoRuleSubject {
  type: PromoCodeType;
  // Optional per-lodge restriction (see PromoRuleSubject.lodges).
  lodges?: { lodgeId: string }[];
  valueCents: number | null;
  percentOff: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: FixedNightlyMode | null;
  maxGuestsPerBooking: number | null;
  maxNightlyValueCents: number | null;
  memberGuestsOnly: boolean;
  assignedMembersOnlyOwnNights?: boolean | null;
  // System-applied promo (work party events). Discount is restricted to the
  // linked event's night window; the code is rejected at manual entry.
  internal?: boolean | null;
}

export interface PromoApplicationResult {
  error?: string;
  requiresGuestSelection?: boolean;
  selectableGuestIndexes?: number[];
  discount?: PromoDiscountResult;
  beneficiaryMemberIds: string[];
  remainingFreeNights?: number;
  remainingFreeNightsByMemberId?: Record<string, number>;
  selectedGuestIndexes?: number[];
}

function hasAssignedMembers(assignedMemberIds: string[] | null | undefined) {
  return Boolean(assignedMemberIds && assignedMemberIds.length > 0);
}

function assignedMembersOnlyOwnNights(
  promoCode: { assignedMembersOnlyOwnNights?: boolean | null }
) {
  return promoCode.assignedMembersOnlyOwnNights ?? true;
}

/**
 * A fixed-nightly "group" promo prices the whole booking at the configured
 * nightly rate. When assigned to members it stays group-scoped: every eligible
 * guest-night is repriced (members and non-members), the booker is the
 * beneficiary of record, and the booker must be one of the assigned members.
 * It does not scope the discount to the assigned members' own nights, nor ask
 * the booker to pick guests.
 *
 * Gated on assignedMembersOnlyOwnNights === false so an admin can still choose
 * own-night scoping for a fixed-nightly code. member-guests-only fixed-nightly
 * codes are excluded (they always scope to assigned member guests).
 */
function isFixedNightlyGroupPromo(promoCode: {
  type?: PromoCodeType | string | null;
  memberGuestsOnly?: boolean | null;
  assignedMembersOnlyOwnNights?: boolean | null;
}) {
  return (
    promoCode.type === "FIXED_NIGHTLY_PRICE" &&
    !promoCode.memberGuestsOnly &&
    !assignedMembersOnlyOwnNights(promoCode)
  );
}

function scopedAssignmentMemberIds(
  promoCode: { assignedMembersOnlyOwnNights?: boolean | null },
  assignedMemberIds: string[] | null | undefined
) {
  return assignedMembersOnlyOwnNights(promoCode) ? assignedMemberIds : null;
}

function assignmentRequiresGuestSelection(
  promoCode: {
    type?: PromoCodeType | string | null;
    memberGuestsOnly?: boolean | null;
    assignedMembersOnlyOwnNights?: boolean | null;
  },
  assignedMemberIds: string[] | null | undefined
) {
  // Group fixed-nightly codes price every eligible guest automatically, so the
  // booker never picks guests even though own-night scoping is off.
  if (isFixedNightlyGroupPromo(promoCode)) return false;
  return hasAssignedMembers(assignedMemberIds) && !assignedMembersOnlyOwnNights(promoCode);
}

/**
 * Whether the booker must be one of the assigned members. True for the two
 * non-own-night assignment modes: "booker picks guests" (per-guest selection)
 * and "group" fixed-nightly pricing. Own-night scoping leaves this false so any
 * booker can use the code as long as an assigned member is staying.
 */
function assignmentRequiresAssignedBooker(
  promoCode: {
    type?: PromoCodeType | string | null;
    memberGuestsOnly?: boolean | null;
    assignedMembersOnlyOwnNights?: boolean | null;
  },
  assignedMemberIds: string[] | null | undefined
) {
  if (!hasAssignedMembers(assignedMemberIds)) return false;
  return (
    assignmentRequiresGuestSelection(promoCode, assignedMemberIds) ||
    isFixedNightlyGroupPromo(promoCode)
  );
}

function storedPromoDateKey(value: Date | null | undefined) {
  return value ? formatDateOnly(value) : null;
}

function nzDateKey(value: Date) {
  return formatDateOnlyForTimeZone(value);
}

function scopeGuestsForAssignedMembers(
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null | undefined
) {
  if (!hasAssignedMembers(assignedMemberIds)) return guests;

  const assigned = new Set(assignedMemberIds);
  return guests.filter((guest) => Boolean(guest.memberId && assigned.has(guest.memberId)));
}

function selectablePromoGuestIndexes(
  promo: { memberGuestsOnly?: boolean | null },
  guests: PromoDiscountGuest[]
) {
  return guests
    .map((guest, index) => ({ guest, index }))
    .filter(({ guest }) => guest.perNightRates.length > 0)
    .filter(({ guest }) => !promo.memberGuestsOnly || guest.isMember)
    .map(({ index }) => index);
}

function normalizeSelectedGuestIndexes(
  selectedGuestIndexes: number[] | undefined,
  guestCount: number
): { indexes: number[]; error?: string } {
  if (!selectedGuestIndexes) {
    return { indexes: [] };
  }

  const indexes: number[] = [];
  const seen = new Set<number>();
  for (const index of selectedGuestIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= guestCount) {
      return { indexes: [], error: "Selected promo guest is not on this booking" };
    }
    if (!seen.has(index)) {
      seen.add(index);
      indexes.push(index);
    }
  }
  indexes.sort((a, b) => a - b);
  return { indexes };
}

function filterGuestsByIndexes(guests: PromoDiscountGuest[], indexes: number[]) {
  return indexes.map((index) => guests[index]).filter(Boolean);
}

/**
 * Did this allocation actually give the member something? (#2299, owner
 * decision 1: "any price effect".) A money-off discount, a price change in
 * either direction, or a subsidised night all count as a benefit; an
 * application that moved none of the three delivered nothing.
 *
 * A price-RAISING fixed-nightly application counts as a use, because the
 * member's price genuinely changed — the rejected alternative was to count
 * price reductions only.
 */
export function isBeneficialPromoAllocation(allocation: {
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number;
}): boolean {
  return (
    allocation.discountCents > 0 ||
    allocation.priceAdjustmentCents !== 0 ||
    allocation.freeNightsUsed > 0
  );
}

/**
 * The same "did the member actually get something" test, expressed as a Prisma
 * filter over stored allocation rows. Applied defensively to every cap count so
 * a historical all-zero row written before #2299 (or by an old colour during a
 * blue/green drain) stops consuming a member's slot immediately, without
 * waiting for the repair migration to run.
 */
export const BENEFICIAL_PROMO_ALLOCATION_FILTER = {
  OR: [
    { discountCents: { gt: 0 } },
    { priceAdjustmentCents: { not: 0 } },
    { freeNightsUsed: { gt: 0 } },
  ],
} satisfies Prisma.PromoRedemptionAllocationWhereInput;

/**
 * Build the allocation rows to persist for a redemption.
 *
 * An allocation row means "this member benefited", which is what every usage
 * cap counts (#2299). Non-beneficial entries are dropped here — the single
 * write-time choke point both `redeemPromoCode` and
 * `replacePromoRedemptionAllocations` go through — so a zero-benefit
 * application can never occupy a per-member, total-redemptions or
 * unique-members slot. The `PromoRedemption` row itself is still written by the
 * caller; it remains the audit and reporting trail.
 */
function normalizeAllocations(
  allocations: PromoDiscountAllocation[] | undefined,
  fallbackMemberId: string,
  discountCents: number,
  priceAdjustmentCents: number,
  freeNightsUsed: number
): PromoBeneficiaryAllocation[] {
  const suppliedAllocations = allocations ?? [];

  if (suppliedAllocations.length > 0) {
    // Pricing can emit a deliberately zero entry (a SET_PRICE fixed-nightly
    // guest whose rate already equals the fixed price), so filter here too.
    return suppliedAllocations
      .map((allocation) => ({
        memberId: allocation.memberId,
        discountCents: allocation.discountCents,
        priceAdjustmentCents: allocation.priceAdjustmentCents,
        freeNightsUsed: allocation.freeNightsUsed,
      }))
      .filter(isBeneficialPromoAllocation);
  }

  const fallback = {
    memberId: fallbackMemberId,
    discountCents,
    priceAdjustmentCents,
    freeNightsUsed,
  };
  return isBeneficialPromoAllocation(fallback) ? [fallback] : [];
}

// test seam
/**
 * Calculate the promo discount for a booking using the per-guest model.
 * When the promo has member assignments, the benefit is restricted to linked
 * guest rows whose memberId is assigned. Unassigned promos keep the existing
 * booking-member beneficiary semantics for usage caps.
 */
export function calculatePromoDiscountForGuestRates(
  promo: PromoCodeInput,
  totalPriceCents: number,
  bookingMemberId: string,
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null = null,
  remainingFreeNights?: number,
  remainingFreeNightsByMemberId?: Record<string, number>
): PromoDiscountResult {
  const assignedScoped = hasAssignedMembers(assignedMemberIds);
  const scopedGuests = scopeGuestsForAssignedMembers(guests, assignedMemberIds);

  const result = calculatePromoDiscount(promo, {
    totalPriceCents,
    guests: scopedGuests,
    remainingFreeNights: assignedScoped && remainingFreeNightsByMemberId
      ? undefined
      : remainingFreeNights,
    remainingFreeNightsByMemberId: assignedScoped
      ? remainingFreeNightsByMemberId
      : undefined,
  });

  if (assignedScoped) {
    return result;
  }

  // Unassigned promos attribute the whole benefit to the booker. Before #2299
  // this fallback row was FORCED whenever any guest was eligible, so a promo
  // that produced no discount at all (a fixed-nightly cap that never bit, a
  // percentage off $0 guest-nights) still manufactured an allocation row and
  // burned the member's single permitted use. It is now written only when there
  // is something to attribute.
  return {
    ...result,
    allocations: normalizeAllocations(
      [],
      bookingMemberId,
      result.discountCents,
      result.priceAdjustmentCents,
      result.freeNightsUsed
    ),
  };
}

function selectPromoBeneficiaryGuests(
  promo: PromoCodeInput,
  guests: PromoDiscountGuest[]
) {
  const selectedGuests = selectPromoDiscountGuests(promo, guests);
  if (promo.type !== "FIXED_NIGHTLY_PRICE") {
    return selectedGuests;
  }

  const fixedNightlyPriceCents = promo.fixedNightlyPriceCents ?? 0;
  if (fixedNightlyPriceCents <= 0) return [];

  if ((promo.fixedNightlyMode ?? "CAP_ONLY") === "CAP_ONLY") {
    return selectedGuests.filter(({ guest }) =>
      guest.perNightRates.some((rate) => rate > fixedNightlyPriceCents)
    );
  }

  return selectedGuests.filter(({ guest }) => guest.perNightRates.length > 0);
}

function getPromoBeneficiaryMemberIds(
  promo: PromoCodeInput,
  bookingMemberId: string,
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null = null
): string[] {
  const scopedGuests = scopeGuestsForAssignedMembers(guests, assignedMemberIds);
  const selectedGuests = selectPromoBeneficiaryGuests(promo, scopedGuests);
  if (selectedGuests.length === 0) return [];

  if (!hasAssignedMembers(assignedMemberIds)) {
    return [bookingMemberId];
  }

  return [...new Set(
    selectedGuests
      .map(({ guest }) => guest.memberId)
      .filter((memberId): memberId is string => Boolean(memberId))
  )];
}

/**
 * Whether to write a `PromoRedemption` row for this application.
 *
 * Deliberately WIDER than the benefit test above: a promo that had eligible
 * guests but delivered nothing still records its redemption, because that row
 * is the audit and reporting trail an operator needs to see that a code is
 * misconfigured (#2299, owner decision 3). What changed is that such a
 * redemption now carries no allocation rows, so it counts toward no cap.
 */
export function shouldPersistPromoRedemption(result: PromoDiscountResult | null | undefined) {
  return Boolean(
    result &&
      (result.allocations.length > 0 ||
        result.discountCents > 0 ||
        result.priceAdjustmentCents !== 0 ||
        result.freeNightsUsed > 0 ||
        result.eligibleGuestCount > 0)
  );
}

/**
 * Get the total number of free nights a member has already consumed
 * from a specific promo code across all their redemptions.
 *
 * Deliberately NOT benefit-filtered: this sum is already benefit-proportional
 * (a zero-benefit row contributes zero nights), and summing every row is the
 * fail-safe direction — it can never miss a night a member really claimed.
 */
async function getMemberFreeNightsUsed(
  promoCodeId: string,
  memberId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: {
    promoCodeId: string;
    memberId: string;
    bookingId?: { not: string };
  } = { promoCodeId, memberId };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  const result = await db.promoRedemptionAllocation.aggregate({
    where,
    _sum: { freeNightsUsed: true },
  });

  return result._sum.freeNightsUsed ?? 0;
}

/**
 * Count distinct members who have BENEFITED from this promo code.
 * Excludes a specific booking id when updating an existing booking.
 */
async function getUniqueMemberRedemptionCount(
  promoCodeId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: Prisma.PromoRedemptionAllocationWhereInput = {
    promoCodeId,
    ...BENEFICIAL_PROMO_ALLOCATION_FILTER,
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }
  const rows = await db.promoRedemptionAllocation.findMany({
    where,
    select: { memberId: true },
    distinct: ["memberId"],
  });
  return rows.length;
}

/**
 * How many times this member has already BENEFITED from this promo code — the
 * denominator of the uses-per-member cap. A zero-benefit application never
 * counts (#2299), so a member who applied a code that did nothing for them can
 * still use it later.
 */
async function getMemberPromoRedemptionCount(
  promoCodeId: string,
  memberId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: Prisma.PromoRedemptionAllocationWhereInput = {
    promoCodeId,
    memberId,
    ...BENEFICIAL_PROMO_ALLOCATION_FILTER,
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  return db.promoRedemptionAllocation.count({ where });
}

async function getPromoBeneficiaryUsage(
  promoCodeId: string,
  memberIds: string[],
  excludeBookingId: string | undefined,
  db: PromoUsageClient
) {
  const usage: Record<string, { redemptionCount: number; freeNightsUsed: number }> = {};
  await Promise.all(
    [...new Set(memberIds)].map(async (memberId) => {
      const [redemptionCount, freeNightsUsed] = await Promise.all([
        getMemberPromoRedemptionCount(promoCodeId, memberId, excludeBookingId, db),
        getMemberFreeNightsUsed(promoCodeId, memberId, excludeBookingId, db),
      ]);
      usage[memberId] = { redemptionCount, freeNightsUsed };
    })
  );
  return usage;
}

async function getExistingBeneficiaryMemberIds(
  promoCodeId: string,
  memberIds: string[],
  excludeBookingId: string | undefined,
  db: PromoUsageClient
): Promise<Set<string>> {
  const uniqueMemberIds = [...new Set(memberIds)];
  if (uniqueMemberIds.length === 0) return new Set();

  const where: Prisma.PromoRedemptionAllocationWhereInput = {
    promoCodeId,
    memberId: { in: uniqueMemberIds },
    ...BENEFICIAL_PROMO_ALLOCATION_FILTER,
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  const rows = await db.promoRedemptionAllocation.findMany({
    where,
    select: { memberId: true },
    distinct: ["memberId"],
  });
  return new Set(rows.map((row) => row.memberId));
}

export async function getAvailablePromoCodesForMember(
  memberId: string,
  now: Date = new Date()
): Promise<AvailablePromoCode[]> {
  const assignedPromoCodes = await getAssignedPromoCodeSummariesForMember(memberId, now);

  return assignedPromoCodes
    .filter((promoCode) => promoCode.visibleToMember)
    .map((promoCode) => ({
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      percentOff: promoCode.percentOff,
      valueCents: promoCode.valueCents,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      lifetimeFreeNightsCap: promoCode.lifetimeFreeNightsCap,
      fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
      fixedNightlyMode: promoCode.fixedNightlyMode,
    }));
}

export async function getAssignedPromoCodeSummariesForMember(
  memberId: string,
  now: Date = new Date()
): Promise<AssignedPromoCodeSummary[]> {
  const assignments = await prisma.promoCodeAssignment.findMany({
    where: { memberId, promoCode: { internal: false } },
    include: {
      promoCode: {
        include: {
          // Beneficial allocations only (#2299): this list drives both the
          // uses-per-member count and the member-facing "Already used by
          // member" status, and neither may be tripped by an application that
          // gave the member nothing. The lifetime free-nights sum below is
          // unaffected by the filter — every excluded row carries
          // freeNightsUsed = 0 by definition.
          allocations: {
            where: { memberId, ...BENEFICIAL_PROMO_ALLOCATION_FILTER },
            select: { id: true, freeNightsUsed: true },
          },
        },
      },
    },
  });

  return assignments.map((assignment) => {
    const promoCode = assignment.promoCode;
    const freeNightsUsed = promoCode.allocations.reduce(
      (sum, allocation) => sum + allocation.freeNightsUsed,
      0
    );
    const statusReason = getAssignedPromoCodeStatusReason(promoCode, freeNightsUsed, now);

    return {
      id: promoCode.id,
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      percentOff: promoCode.percentOff,
      valueCents: promoCode.valueCents,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      lifetimeFreeNightsCap: promoCode.lifetimeFreeNightsCap,
      fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
      fixedNightlyMode: promoCode.fixedNightlyMode,
      assignedAt: assignment.createdAt ?? null,
      active: promoCode.active,
      archivedAt: promoCode.archivedAt,
      validFrom: promoCode.validFrom,
      validUntil: promoCode.validUntil,
      bookingStartFrom: promoCode.bookingStartFrom,
      bookingStartUntil: promoCode.bookingStartUntil,
      assignedMembersOnlyOwnNights: promoCode.assignedMembersOnlyOwnNights,
      maxRedemptionsTotal: promoCode.maxRedemptionsTotal,
      currentRedemptions: promoCode.currentRedemptions,
      maxUsesPerMember: promoCode.maxUsesPerMember,
      // Beneficial uses by this member (#2299), matching what the
      // uses-per-member cap actually enforces.
      redemptionCount: promoCode.allocations.length,
      freeNightsUsed,
      visibleToMember: statusReason === null,
      statusReason: statusReason ?? "Available to member",
    };
  });
}

function getAssignedPromoCodeStatusReason(
  promoCode: {
    active: boolean;
    archivedAt: Date | null;
    validFrom: Date | null;
    validUntil: Date | null;
    maxRedemptionsTotal: number | null;
    currentRedemptions: number;
    maxUsesPerMember: number | null;
    type: PromoCodeType;
    lifetimeFreeNightsCap: number | null;
    allocations: Array<{ id: string; freeNightsUsed: number }>;
  },
  freeNightsUsed: number,
  now: Date
) {
  if (!promoCode.active) return "Inactive";
  if (promoCode.archivedAt) return "Archived";
  const currentDateKey = nzDateKey(now);
  const validFromKey = storedPromoDateKey(promoCode.validFrom);
  const validUntilKey = storedPromoDateKey(promoCode.validUntil);
  if (validFromKey && currentDateKey < validFromKey) return "Not valid yet";
  if (validUntilKey && currentDateKey > validUntilKey) return "Expired";
  if (
    promoCode.maxRedemptionsTotal !== null &&
    promoCode.currentRedemptions >= promoCode.maxRedemptionsTotal
  ) {
    return "Maximum uses reached";
  }
  if (
    promoCode.maxUsesPerMember !== null &&
    promoCode.allocations.length >= promoCode.maxUsesPerMember
  ) {
    return promoCode.maxUsesPerMember === 1
      ? "Already used by member"
      : "Maximum uses by member reached";
  }
  if (
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.lifetimeFreeNightsCap !== null &&
    freeNightsUsed >= promoCode.lifetimeFreeNightsCap
  ) {
    return "Free nights used";
  }
  return null;
}

/**
 * Promo rule shape used by pure validation. Booking-time callers and the
 * validate API both populate this from the locked PromoCode row.
 */
export interface PromoRuleSubject {
  id: string;
  active: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  bookingStartFrom?: Date | null;
  bookingStartUntil?: Date | null;
  maxRedemptionsTotal: number | null;
  currentRedemptions: number;
  membersOnly: boolean;
  maxUsesPerMember: number | null;
  maxUniqueMembersTotal: number | null;
  type?: PromoCodeType;
  freeNightsPerIndividual?: number | null;
  lifetimeFreeNightsCap?: number | null;
  assignedMembersOnlyOwnNights?: boolean | null;
  // Optional per-lodge restriction (multi-lodge phase 6, ADR-001 resolved
  // question 4). No rows = redeemable at every lodge; rows present = only
  // the listed lodges. Omitted entirely by callers that never restrict.
  lodges?: { lodgeId: string }[];
}

export interface PromoRuleCounts {
  memberRedemptionCount?: number;
  memberFreeNightsUsed?: number;
  uniqueMembersUsed?: number;
  memberHasRedeemedBefore?: boolean;
  requestedRedemptionCount?: number;
  requestedNewUniqueMemberCount?: number;
  memberRedemptionCounts?: Record<string, number>;
  memberFreeNightsUsedByMemberId?: Record<string, number>;
  // True for assigned-member promos where every linked member guest is at
  // their per-member cap (redemptions or lifetime free nights). Signals that
  // no beneficiary survives the upstream filter.
  allBeneficiariesExhausted?: boolean;
}

// test seam
/**
 * Validate promo code rules (pure logic, separated for testing).
 * Returns error message string if invalid, null if valid.
 */
export function validatePromoCodeRules(
  promoCode: PromoRuleSubject | null,
  bookingDetails: { memberId: string; bookingCheckIn?: Date },
  now: Date = new Date(),
  counts: PromoRuleCounts = {},
  assignedMemberIds: string[] | null = null,
  lodgeId: string | null = null
): string | null {
  if (!promoCode) {
    return "Promo code not found";
  }

  if (!promoCode.active) {
    return "This promo code is no longer active";
  }

  if (
    promoCode.lodges &&
    promoCode.lodges.length > 0 &&
    (!lodgeId || !promoCode.lodges.some((row) => row.lodgeId === lodgeId))
  ) {
    return PROMO_LODGE_RESTRICTION_MESSAGE;
  }

  const currentDateKey = nzDateKey(now);
  const validFromKey = storedPromoDateKey(promoCode.validFrom);
  const validUntilKey = storedPromoDateKey(promoCode.validUntil);
  if (validFromKey && currentDateKey < validFromKey) {
    return "This promo code is not yet valid";
  }

  if (validUntilKey && currentDateKey > validUntilKey) {
    return "This promo code has expired";
  }

  if (bookingDetails.bookingCheckIn) {
    const checkInKey = nzDateKey(bookingDetails.bookingCheckIn);
    const bookingStartFromKey = storedPromoDateKey(promoCode.bookingStartFrom);
    const bookingStartUntilKey = storedPromoDateKey(promoCode.bookingStartUntil);
    if (bookingStartFromKey && checkInKey < bookingStartFromKey) {
      return "This promo code is not valid for your booking dates";
    }
    if (bookingStartUntilKey && checkInKey >= bookingStartUntilKey) {
      return "This promo code is not valid for your booking dates";
    }
  }

  if (
    promoCode.maxRedemptionsTotal !== null &&
    promoCode.currentRedemptions + (counts.requestedRedemptionCount ?? 1) >
      promoCode.maxRedemptionsTotal
  ) {
    return "This promo code has reached its maximum number of uses";
  }

  if (promoCode.membersOnly && !bookingDetails.memberId) {
    return "This promo code is only available to members";
  }

  if (assignedMemberIds !== null && assignedMemberIds.length > 0) {
    if (!bookingDetails.memberId || !assignedMemberIds.includes(bookingDetails.memberId)) {
      return "This promo code is not assigned to you";
    }
  }

  // Cap on distinct members. Allow if the booker has already redeemed at
  // least once (they're counted), otherwise reject when the cap is hit.
  if (
    promoCode.maxUniqueMembersTotal !== null &&
    promoCode.maxUniqueMembersTotal !== undefined &&
    counts.requestedNewUniqueMemberCount !== undefined &&
    (counts.uniqueMembersUsed ?? 0) + counts.requestedNewUniqueMemberCount >
      promoCode.maxUniqueMembersTotal
  ) {
    return "This promo code has reached its maximum number of unique members";
  }

  if (
    promoCode.maxUniqueMembersTotal !== null &&
    promoCode.maxUniqueMembersTotal !== undefined &&
    counts.requestedNewUniqueMemberCount === undefined &&
    !counts.memberHasRedeemedBefore &&
    (counts.uniqueMembersUsed ?? 0) >= promoCode.maxUniqueMembersTotal
  ) {
    return "This promo code has reached its maximum number of unique members";
  }

  // For assigned-member promos, exhausted beneficiaries are filtered out
  // upstream in validateAndCalculatePromoDiscount. The .some() rejection here
  // would otherwise block the whole code when one linked guest is at cap,
  // even if others still have allowance. The per-booker fallback below still
  // applies for unassigned promos.

  if (
    promoCode.maxUsesPerMember !== null &&
    promoCode.maxUsesPerMember !== undefined &&
    !counts.memberRedemptionCounts &&
    (counts.memberRedemptionCount ?? 0) >= promoCode.maxUsesPerMember
  ) {
    return promoCode.maxUsesPerMember === 1
      ? "You have already used this promo code"
      : "You have reached the maximum uses of this promo code";
  }

  if (
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.lifetimeFreeNightsCap &&
    !counts.memberFreeNightsUsedByMemberId &&
    (counts.memberFreeNightsUsed ?? 0) >= promoCode.lifetimeFreeNightsCap
  ) {
    return "You have used all your free nights for this promo code";
  }

  if (counts.allBeneficiariesExhausted) {
    return "All linked member guests have used this promo code";
  }

  return null;
}

export async function validateAndCalculatePromoDiscount(
  promoCode: PromoApplicationSubject | null,
  bookingDetails: BookingDetailsForPromo,
  assignedMemberIds: string[] | null = null,
  options: {
    excludeBookingId?: string;
    db?: PromoUsageClient;
    now?: Date;
    selectedGuestIndexes?: number[];
    // The booking's/quote's lodge. Required to enforce an optional per-lodge
    // promo restriction (PromoCodeLodge junction, ADR-001 resolved question
    // 4); omitted only by callers that cannot yet resolve a lodge (fail-open
    // to unrestricted, matching "no rows = every lodge").
    lodgeId?: string | null;
  } = {}
): Promise<PromoApplicationResult> {
  if (!promoCode) {
    return {
      error: "Promo code not found",
      beneficiaryMemberIds: [],
    };
  }

  // Optional per-lodge restriction (PromoCodeLodge junction, ADR-001 resolved
  // question 4): no rows means redeemable at every lodge; rows present
  // restrict redemption to the listed lodges. Checked up front, before any
  // usage lookups, so a lodge-restricted code fails fast.
  if (
    promoCode.lodges &&
    promoCode.lodges.length > 0 &&
    (!options.lodgeId || !promoCode.lodges.some((row) => row.lodgeId === options.lodgeId))
  ) {
    return {
      error: PROMO_LODGE_RESTRICTION_MESSAGE,
      beneficiaryMemberIds: [],
    };
  }

  const db = options.db ?? prisma;

  // Internal work party promos discount only the nights inside the linked
  // event's window. Restrict each guest's per-night rates up front so all
  // downstream eligibility and discount maths see in-window nights only.
  // Guests without a firstNight cannot be dated, so their nights are
  // excluded entirely (fail safe, never over-discount).
  let detailGuests = bookingDetails.guests;
  if (promoCode.internal) {
    const nightWindow = await getWorkPartyNightWindowForPromo(db, promoCode.id);
    if (nightWindow) {
      detailGuests = bookingDetails.guests.map((guest) => ({
        ...guest,
        perNightRates: guest.firstNight
          ? restrictPerNightRatesToWindow(
              guest.perNightRates,
              guest.firstNight,
              nightWindow,
              guest.nightDates
            )
          : [],
      }));
    }
  }

  const requiresGuestSelection = assignmentRequiresGuestSelection(promoCode, assignedMemberIds);
  const requiresAssignedBooker = assignmentRequiresAssignedBooker(promoCode, assignedMemberIds);
  const selectableGuestIndexes = requiresGuestSelection
    ? selectablePromoGuestIndexes(promoCode, detailGuests)
    : undefined;
  const selectedGuestIndexes = normalizeSelectedGuestIndexes(
    options.selectedGuestIndexes,
    detailGuests.length
  );
  if (selectedGuestIndexes.error) {
    return {
      error: selectedGuestIndexes.error,
      beneficiaryMemberIds: [],
    };
  }
  if (requiresGuestSelection) {
    if (!options.selectedGuestIndexes || selectedGuestIndexes.indexes.length === 0) {
      return {
        error: "Choose which guests should receive this promo code",
        requiresGuestSelection: true,
        selectableGuestIndexes,
        beneficiaryMemberIds: [],
      };
    }
    const selectable = new Set(selectableGuestIndexes ?? []);
    if (selectedGuestIndexes.indexes.some((index) => !selectable.has(index))) {
      return {
        error: "One or more selected guests cannot use this promo code",
        requiresGuestSelection: true,
        selectableGuestIndexes,
        beneficiaryMemberIds: [],
      };
    }
    if (
      promoCode.maxGuestsPerBooking !== null &&
      promoCode.maxGuestsPerBooking !== undefined &&
      selectedGuestIndexes.indexes.length > promoCode.maxGuestsPerBooking
    ) {
      return {
        error: `Choose no more than ${promoCode.maxGuestsPerBooking} guest${promoCode.maxGuestsPerBooking === 1 ? "" : "s"} for this promo code`,
        requiresGuestSelection: true,
        selectableGuestIndexes,
        beneficiaryMemberIds: [],
      };
    }
  }
  const guestsForPromo = requiresGuestSelection
    ? filterGuestsByIndexes(detailGuests, selectedGuestIndexes.indexes)
    : detailGuests;
  const assignedGuestScopeMemberIds = scopedAssignmentMemberIds(
    promoCode,
    assignedMemberIds
  );
  const initialBeneficiaryMemberIds = getPromoBeneficiaryMemberIds(
    {
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
      fixedNightlyMode: promoCode.fixedNightlyMode,
      maxGuestsPerBooking: promoCode.maxGuestsPerBooking,
      maxNightlyValueCents: promoCode.maxNightlyValueCents,
      memberGuestsOnly: promoCode.memberGuestsOnly,
    },
    bookingDetails.memberId,
    guestsForPromo,
    assignedGuestScopeMemberIds
  );

  if (hasAssignedMembers(assignedGuestScopeMemberIds) && initialBeneficiaryMemberIds.length === 0) {
    return {
      error: "This promo code only applies when an assigned member is staying on the booking",
      beneficiaryMemberIds: [],
    };
  }

  const beneficiaryUsage = await getPromoBeneficiaryUsage(
    promoCode.id,
    initialBeneficiaryMemberIds,
    options.excludeBookingId,
    db
  );
  const bookerUsage = beneficiaryUsage[bookingDetails.memberId] ?? {
    redemptionCount: 0,
    freeNightsUsed: 0,
  };

  // For assigned-member promos, drop beneficiaries who've already exhausted
  // their per-member caps (redemptions or lifetime free nights). The promo
  // still applies for the remaining beneficiaries; only if every beneficiary
  // is exhausted do we reject the code.
  const assignedScoped = hasAssignedMembers(assignedGuestScopeMemberIds);
  const isMemberExhausted = (memberId: string) => {
    const usage = beneficiaryUsage[memberId] ?? { redemptionCount: 0, freeNightsUsed: 0 };
    if (
      promoCode.maxUsesPerMember !== null &&
      promoCode.maxUsesPerMember !== undefined &&
      usage.redemptionCount >= promoCode.maxUsesPerMember
    ) {
      return true;
    }
    if (
      promoCode.type === "FREE_NIGHTS" &&
      promoCode.lifetimeFreeNightsCap !== null &&
      promoCode.lifetimeFreeNightsCap !== undefined &&
      usage.freeNightsUsed >= promoCode.lifetimeFreeNightsCap
    ) {
      return true;
    }
    return false;
  };

  const beneficiaryMemberIds =
    assignedScoped && initialBeneficiaryMemberIds.length > 0
      ? initialBeneficiaryMemberIds.filter((id) => !isMemberExhausted(id))
      : initialBeneficiaryMemberIds;

  const allBeneficiariesExhausted =
    assignedScoped &&
    initialBeneficiaryMemberIds.length > 0 &&
    beneficiaryMemberIds.length === 0;

  let uniqueMembersUsed = 0;
  let requestedNewUniqueMemberCount: number | undefined;
  if (promoCode.maxUniqueMembersTotal !== null && promoCode.maxUniqueMembersTotal !== undefined) {
    uniqueMembersUsed = await getUniqueMemberRedemptionCount(
      promoCode.id,
      options.excludeBookingId,
      db
    );
    const existingBeneficiaries = await getExistingBeneficiaryMemberIds(
      promoCode.id,
      beneficiaryMemberIds,
      options.excludeBookingId,
      db
    );
    requestedNewUniqueMemberCount = beneficiaryMemberIds.filter(
      (memberId) => !existingBeneficiaries.has(memberId)
    ).length;
  }

  // For assigned-member promos the booker is just another linked member guest
  // and per-member caps are enforced by the upstream filter, so we suppress
  // the booker-scoped fallback checks in the validator.
  const validationError = validatePromoCodeRules(
    promoCode,
    bookingDetails,
    options.now ?? new Date(),
    {
      memberRedemptionCount: assignedScoped ? undefined : bookerUsage.redemptionCount,
      memberFreeNightsUsed: assignedScoped ? undefined : bookerUsage.freeNightsUsed,
      uniqueMembersUsed,
      memberHasRedeemedBefore: bookerUsage.redemptionCount > 0,
      requestedRedemptionCount: beneficiaryMemberIds.length,
      requestedNewUniqueMemberCount,
      allBeneficiariesExhausted,
    },
    requiresAssignedBooker ? assignedMemberIds : null,
    options.lodgeId ?? null
  );

  if (validationError) {
    return {
      error: validationError,
      beneficiaryMemberIds: initialBeneficiaryMemberIds,
    };
  }

  const remainingFreeNightsByMemberId =
    assignedScoped &&
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.lifetimeFreeNightsCap !== null &&
    promoCode.lifetimeFreeNightsCap !== undefined
      ? Object.fromEntries(
          beneficiaryMemberIds.map((memberId) => [
            memberId,
            Math.max(
              0,
              promoCode.lifetimeFreeNightsCap! -
                (beneficiaryUsage[memberId]?.freeNightsUsed ?? 0)
            ),
          ])
        )
      : undefined;
  const remainingFreeNights =
    !assignedScoped &&
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.lifetimeFreeNightsCap !== null &&
    promoCode.lifetimeFreeNightsCap !== undefined
      ? Math.max(0, promoCode.lifetimeFreeNightsCap - bookerUsage.freeNightsUsed)
      : undefined;

  // Effective assigned-member list passed to pricing: filtered to those with
  // remaining budget so exhausted members' guest rows are excluded from the
  // discount candidates.
  const effectiveGuestScopeMemberIds = assignedScoped
    ? beneficiaryMemberIds
    : assignedGuestScopeMemberIds;

  const discount = calculatePromoDiscountForGuestRates(
    {
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
      fixedNightlyMode: promoCode.fixedNightlyMode,
      maxGuestsPerBooking: promoCode.maxGuestsPerBooking,
      maxNightlyValueCents: promoCode.maxNightlyValueCents,
      memberGuestsOnly: promoCode.memberGuestsOnly,
    },
    bookingDetails.totalPriceCents,
    bookingDetails.memberId,
    guestsForPromo,
    effectiveGuestScopeMemberIds,
    remainingFreeNights,
    remainingFreeNightsByMemberId
  );

  return {
    discount,
    beneficiaryMemberIds,
    remainingFreeNights,
    remainingFreeNightsByMemberId,
    selectedGuestIndexes: requiresGuestSelection ? selectedGuestIndexes.indexes : undefined,
  };
}

/**
 * Full validation including database lookups for caps and cumulative
 * free-night tracking. Use this in API routes where you need the full
 * validation and discount calculation.
 */
export async function validatePromoCodeFull(
  code: string,
  bookingDetails: BookingDetailsForPromo,
  excludeBookingId?: string,
  lodgeId?: string | null
): Promise<PromoValidationResult> {
  const normalizedCode = code.toUpperCase().trim();

  const promoCode = await prisma.promoCode.findUnique({
    where: { code: normalizedCode },
    include: {
      assignments: { select: { memberId: true } },
      lodges: { select: { lodgeId: true } },
    },
  });

  // Internal promos (work party events) are system-applied only; treat a
  // manually entered internal code exactly like a nonexistent one.
  if (!promoCode || promoCode.internal) {
    return { valid: false, error: "Promo code not found" };
  }

  const assignedMemberIds = promoCode.assignments.length > 0
    ? promoCode.assignments.map((a) => a.memberId)
    : null;

  const application = await validateAndCalculatePromoDiscount(
    promoCode,
    bookingDetails,
    assignedMemberIds,
    { excludeBookingId, lodgeId }
  );

  if (application.error || !application.discount) {
    return { valid: false, error: application.error ?? "Promo code could not be applied" };
  }

  const result = application.discount;

  return {
    valid: true,
    promoCode: {
      id: promoCode.id,
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      lifetimeFreeNightsCap: promoCode.lifetimeFreeNightsCap,
      fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
      fixedNightlyMode: promoCode.fixedNightlyMode,
      maxGuestsPerBooking: promoCode.maxGuestsPerBooking,
      maxNightlyValueCents: promoCode.maxNightlyValueCents,
      memberGuestsOnly: promoCode.memberGuestsOnly,
      assignedMembersOnlyOwnNights: promoCode.assignedMembersOnlyOwnNights,
    },
    discountCents: result.discountCents,
    promoAdjustmentCents: result.priceAdjustmentCents,
    freeNightsUsed: result.freeNightsUsed,
    eligibleGuestCount: result.eligibleGuestCount,
    remainingFreeNights: application.remainingFreeNights,
    allocations: result.allocations,
    selectedGuestIndexes: application.selectedGuestIndexes,
  };
}

/**
 * Take a `FOR UPDATE` row lock on every promo code this transaction is about to
 * charge or refund a use against, BEFORE any cap is read and before any
 * `currentRedemptions` write.
 *
 * Without it a cap check and the redemption that consumes it are two separate
 * statements, so two concurrent modifications of different bookings can both
 * read "one use left" and both take it. Booking creation has locked its promo
 * row this way since the per-individual redesign
 * (`booking-create-promo.ts`, docs/CONCURRENCY_AND_LOCKING.md → "Narrow
 * row-lock protocols"); this is the same protocol for the modification paths,
 * which matters more now that a reprice can RELEASE a slot as well as take one.
 *
 * Two properties keep it safe:
 *
 * 1. **No lock-order cycle.** Ids are sorted and locked one statement at a
 *    time, so every caller takes promo row locks in the same global order —
 *    including a swap that touches the outgoing code and the incoming code in
 *    the same transaction. Sorting in the application rather than relying on
 *    `ORDER BY ... FOR UPDATE` keeps the ordering independent of the query
 *    plan. Callers already hold the per-lodge capacity lock, so the order stays
 *    lodge -> promo row, as documented.
 * 2. **No dependence on the raw result shape.** Only `"id"` is selected and the
 *    result is discarded; the statement exists purely for its lock, so it
 *    cannot repeat the raw-SQL shape trap of #2289.
 *
 * A missing id simply locks nothing — the caller's own lookup reports "Promo
 * code not found".
 */
export async function lockPromoCodeRowsForUpdate(
  tx: PrismaTx,
  promoCodeIds: (string | null | undefined)[]
): Promise<void> {
  const ids = [...new Set(promoCodeIds.filter((id): id is string => Boolean(id)))].sort();
  for (const id of ids) {
    await tx.$queryRaw`SELECT "id" FROM "PromoCode" WHERE "id" = ${id} FOR UPDATE`;
  }
}

/**
 * Re-check the promo's optional per-lodge restriction against the booking's
 * lodge, inside the same transaction that creates the redemption row. Belt
 * and braces alongside the upstream validateAndCalculatePromoDiscount check:
 * quotes and redemption can race an admin edit to a promo's lodge list, so
 * this closes that window rather than trusting the earlier read.
 */
async function assertPromoRedeemableAtLodge(
  tx: PrismaTx,
  promoCodeId: string,
  lodgeId: string | null | undefined
): Promise<void> {
  const restrictionRows = await tx.promoCodeLodge.findMany({
    where: { promoCodeId },
    select: { lodgeId: true },
  });
  if (restrictionRows.length === 0) return;
  if (!lodgeId || !restrictionRows.some((row) => row.lodgeId === lodgeId)) {
    throw new ApiError(PROMO_LODGE_RESTRICTION_MESSAGE, 400);
  }
}

/**
 * Create a PromoRedemption record and increment the promo code's
 * currentRedemptions by the number of BENEFICIAL allocation rows written —
 * zero when the application delivered nothing (#2299).
 * Should be called within a Prisma transaction.
 */
export async function redeemPromoCode(
  tx: PrismaTx,
  promoCodeId: string,
  bookingId: string,
  memberId: string,
  discountCents: number,
  priceAdjustmentCents: number,
  freeNightsUsed?: number,
  eligibleGuestCount?: number,
  allocations?: PromoBeneficiaryAllocation[],
  targetBookingGuestIds?: string[],
  lodgeId?: string | null
): Promise<void> {
  await assertPromoRedeemableAtLodge(tx, promoCodeId, lodgeId);
  const redemption = await tx.promoRedemption.create({
    data: {
      promoCodeId,
      bookingId,
      memberId,
      discountCents,
      priceAdjustmentCents,
      freeNightsUsed: freeNightsUsed ?? null,
      eligibleGuestCount: eligibleGuestCount ?? null,
    },
  });

  const allocationData = normalizeAllocations(
    allocations,
    memberId,
    discountCents,
    priceAdjustmentCents,
    freeNightsUsed ?? 0
  );
  // LOAD-BEARING, not housekeeping: the `PromoRedemption_sync_allocation_insert`
  // trigger (20260527120000_add_promo_redemption_allocations) fires on the
  // create above and upserts a booker allocation row from the redemption's own
  // scalars — it exists so an old blue/green colour that writes only
  // PromoRedemption still gets an allocation. For a zero-benefit application
  // that row is all-zero, so without this delete the database would put back
  // exactly the row #2299 removes, and the member would burn their use again.
  // Must stay AFTER the redemption write.
  await tx.promoRedemptionAllocation.deleteMany({
    where: { promoRedemptionId: redemption.id },
  });
  if (allocationData.length > 0) {
    await tx.promoRedemptionAllocation.createMany({
      data: allocationData.map((allocation) => ({
        promoRedemptionId: redemption.id,
        promoCodeId,
        bookingId,
        memberId: allocation.memberId,
        discountCents: allocation.discountCents,
        priceAdjustmentCents: allocation.priceAdjustmentCents,
        freeNightsUsed: allocation.freeNightsUsed,
      })),
    });
  }
  if (targetBookingGuestIds && targetBookingGuestIds.length > 0) {
    await tx.promoRedemptionGuestTarget.createMany({
      data: [...new Set(targetBookingGuestIds)].map((bookingGuestId) => ({
        promoRedemptionId: redemption.id,
        bookingId,
        bookingGuestId,
      })),
    });
  }

  await tx.promoCode.update({
    where: { id: promoCodeId },
    data: {
      currentRedemptions: { increment: allocationData.length },
    },
  });
}

/**
 * Reprice an existing redemption in place.
 *
 * When a repriced booking loses all its promo benefit (its guests are removed,
 * its nights shrink below a fixed-nightly cap, its rates fall to zero) the new
 * allocation set is empty and the cap slot it held is released in the same
 * transaction that removes the benefit. That is deliberate and cannot
 * double-spend: at every instant the member holds exactly as many slots as they
 * hold benefits (#2299).
 */
export async function replacePromoRedemptionAllocations(
  tx: PrismaTx,
  redemption: { id: string; promoCodeId: string; bookingId: string; memberId: string },
  discountCents: number,
  priceAdjustmentCents: number,
  freeNightsUsed?: number,
  eligibleGuestCount?: number,
  allocations?: PromoBeneficiaryAllocation[],
  targetBookingGuestIds?: string[]
): Promise<void> {
  // Counted RAW (no benefit filter) on purpose: `currentRedemptions` is the
  // denormalised count of allocation ROWS, so the delta must be measured
  // against however many rows are actually there. Counting only beneficial rows
  // here would leave the counter high by one for every legacy all-zero row this
  // reprice deletes.
  //
  // Must also stay BEFORE the redemption update below: that update fires the
  // `PromoRedemption_sync_allocation_update` trigger, which upserts a booker
  // allocation row. Counting afterwards would see the trigger's transient row
  // and skew the delta.
  const existingAllocationCount = await tx.promoRedemptionAllocation.count({
    where: { promoRedemptionId: redemption.id },
  });
  await tx.promoRedemption.update({
    where: { id: redemption.id },
    data: {
      discountCents,
      priceAdjustmentCents,
      freeNightsUsed: freeNightsUsed || null,
      eligibleGuestCount: eligibleGuestCount || null,
    },
  });

  const allocationData = normalizeAllocations(
    allocations,
    redemption.memberId,
    discountCents,
    priceAdjustmentCents,
    freeNightsUsed ?? 0
  );

  // Same load-bearing delete as `redeemPromoCode`, for the same reason: the
  // update above fired `PromoRedemption_sync_allocation_update`, which upserted
  // a booker allocation row from the redemption's scalars. Must stay AFTER the
  // redemption write, or a reprice that removes all benefit would leave the
  // trigger's all-zero row holding a cap slot.
  await tx.promoRedemptionAllocation.deleteMany({
    where: { promoRedemptionId: redemption.id },
  });
  if (allocationData.length > 0) {
    await tx.promoRedemptionAllocation.createMany({
      data: allocationData.map((allocation) => ({
        promoRedemptionId: redemption.id,
        promoCodeId: redemption.promoCodeId,
        bookingId: redemption.bookingId,
        memberId: allocation.memberId,
        discountCents: allocation.discountCents,
        priceAdjustmentCents: allocation.priceAdjustmentCents,
        freeNightsUsed: allocation.freeNightsUsed,
      })),
    });
  }
  if (targetBookingGuestIds !== undefined) {
    await tx.promoRedemptionGuestTarget.deleteMany({
      where: { promoRedemptionId: redemption.id },
    });
    if (targetBookingGuestIds.length > 0) {
      await tx.promoRedemptionGuestTarget.createMany({
        data: [...new Set(targetBookingGuestIds)].map((bookingGuestId) => ({
          promoRedemptionId: redemption.id,
          bookingId: redemption.bookingId,
          bookingGuestId,
        })),
      });
    }
  }

  const delta = allocationData.length - existingAllocationCount;
  if (delta !== 0) {
    await tx.promoCode.update({
      where: { id: redemption.promoCodeId },
      data: {
        currentRedemptions: delta > 0
          ? { increment: delta }
          : { decrement: Math.abs(delta) },
      },
    });
  }
}

export async function deletePromoRedemptionAndAdjustCount(
  tx: PrismaTx,
  redemption: { id: string; promoCodeId: string }
): Promise<void> {
  // Raw row count, for the same symmetry reason as
  // `replacePromoRedemptionAllocations`: give back exactly what was taken.
  const allocationCount = await tx.promoRedemptionAllocation.count({
    where: { promoRedemptionId: redemption.id },
  });
  await tx.promoRedemption.delete({ where: { id: redemption.id } });

  if (allocationCount > 0) {
    await tx.promoCode.update({
      where: { id: redemption.promoCodeId },
      data: { currentRedemptions: { decrement: allocationCount } },
    });
  }
}
