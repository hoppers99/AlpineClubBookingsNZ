/**
 * Effective defaults for the club-wide settings singletons whose read paths
 * SYNTHESISE a value when the `id = "default"` row has never been saved.
 *
 * These are the values the APP reads on a miss. They are not necessarily what a
 * freshly INSERTed Prisma row would default to, so keep them in step with the
 * read sites that consume them rather than with `prisma/schema.prisma`.
 *
 * Kept here — a pure leaf with no imports — for two reasons:
 *
 * 1. One source of truth. Each value below used to be an inline `?? x` at its
 *    own read site, or a constant inside a prisma-importing module. The
 *    config-transfer exporter now has to emit the same effective value for a
 *    club that never saved the row (#2171), and a second hand-written copy is
 *    exactly how the two would drift apart.
 * 2. Import graph. `src/lib/config-transfer/**` deliberately imports no prisma
 *    (the database is injected through the export/import context). Reading
 *    these from the getters' own modules would have pulled `@/lib/prisma` into
 *    that graph.
 *
 * Two singletons are deliberately absent, and that absence is load-bearing:
 * `ClubIdentitySettings` and `EmailMessageSetting` are made entirely of
 * NULLABLE OVERRIDE columns resolved through the deployment's own
 * `config/club.json` / environment fallback chain. "Never saved" there means
 * "no override" — which is exactly what their admin GETs synthesise — and the
 * fallback values themselves belong to the install, not to the club's
 * configuration, so they are not portable in a bundle.
 *
 * Module flags and member-field visibility keep their own long-standing homes:
 * `DEFAULT_MODULE_SETTINGS` (`src/config/modules.ts`) and
 * `DEFAULT_MEMBER_FIELDS_SETTINGS` (`src/config/member-fields.ts`).
 */

/** `BookingDefaults` — read by `getNonMemberHoldPolicy` and `getWaitlistCrossLodgeOrder`. */
export const DEFAULT_BOOKING_DEFAULTS = {
  nonMemberHoldEnabled: true,
  nonMemberHoldDays: 7,
  waitlistCrossLodgeOrder: "OWN_LODGE_FIRST",
} as const;

/** `BedAllocationSettings` — read by `resolveAutoAllocationEnabled` and the admin surface. */
export const DEFAULT_BED_ALLOCATION_SETTINGS = {
  autoAllocationEnabled: true,
} as const;

/** `BookingRequestSettings` — read by `getBookingRequestSettings`. */
export const DEFAULT_BOOKING_REQUEST_SETTINGS = {
  showPricingToNonMembers: false,
  quoteResponseTtlDays: 14,
  quoteReminderLeadDays: 3,
  attendeeConfirmationLeadDays: 14,
  attendeeConfirmationReminderDays: 3,
} as const;

/** `InternetBankingPaymentSettings` — read by `loadInternetBankingPaymentSettings`. */
export const DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS = {
  holdBedSlots: false,
  holdDays: 3,
  minimumDaysBeforeCheckIn: 0,
} as const;

/** `GroupDiscountSetting` — synthesised by the group-discount admin GET (#2142). */
export const DEFAULT_GROUP_DISCOUNT_SETTING = {
  minGroupSize: 5,
  summerOnly: true,
  enabled: false,
} as const;

/** `MembershipNominationSettings` — read by `normalizeMembershipNominationSettings`. */
export const DEFAULT_MEMBERSHIP_NOMINATION_SETTINGS = {
  gateEnabled: false,
  minimumMembershipMonths: 12,
  minimumNights: 6,
  requiredSignOffs: 2,
  /** No grandfather cutoff: everyone is subject to the gate once it is enabled. */
  gateEffectiveFrom: null,
} as const;

/** `MembershipLockoutSettings` — read by `normalizeMembershipLockoutSettings`. */
export const DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS = {
  enabled: true,
  /** Null = follow the connected Xero organisation's accounting financial year. */
  financialYearEndMonthOverride: null,
  textFallbackEnabled: true,
  useFeeScheduleItemCodes: false,
} as const;

/** `MembershipCancellationSetting` — read by `normalizeMembershipCancellationSettings`. */
export const DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS = {
  warningText:
    "Cancelling membership removes member booking access once approved. Existing bookings, credits, refunds, and unpaid invoices still need separate committee review.",
  rejoinProcessText:
    "Former members can reapply through the normal membership process. The committee will confirm any outstanding balances and restore access only after the rejoin process is approved.",
  xeroArchiveContactsOnCancellation: false,
} as const;
