import { DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS } from "@/config/club-settings-defaults";
import { prisma } from "@/lib/prisma";

// Admin-configurable settings for the booking lockout that blocks members with
// an unpaid annual subscription. Single-row table (id = "default"), same
// pattern as membership-nomination-settings.ts.
export const MEMBERSHIP_LOCKOUT_SETTINGS_ID = "default";

/**
 * The three answers a club can give about a member whose season subscription is
 * required but unpaid (#2543). Mirrors the Prisma `SubscriptionLockoutMode`
 * enum without importing it, so the pure policy modules and the settings layer
 * can name one type.
 */
export type SubscriptionLockoutMode =
  | "NO_BLOCK"
  | "HARD_BLOCK"
  | "NON_MEMBER_PRICING";

export const SUBSCRIPTION_LOCKOUT_MODES = [
  "NO_BLOCK",
  "HARD_BLOCK",
  "NON_MEMBER_PRICING",
] as const satisfies readonly SubscriptionLockoutMode[];

export function isSubscriptionLockoutMode(
  value: unknown,
): value is SubscriptionLockoutMode {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_LOCKOUT_MODES as readonly string[]).includes(value)
  );
}

/**
 * The value to write to the LEGACY `enabled` column for a given mode (#2543).
 *
 * `enabled` is not dropped in the release that adds `mode` — a draining old
 * colour is still reading it — so every save writes both, and this is the one
 * definition of how they correspond. See `MembershipLockoutSettings.enabled` in
 * `prisma/schema.prisma`.
 *
 * `NON_MEMBER_PRICING` maps to `true`, i.e. to the old hard block, and that is
 * the deliberate direction. Old code cannot reprice anybody; if a club is rolled
 * back onto it, refusing an unpaid member is the honest fallback, whereas `false`
 * would let them book at full member rates — the one outcome the club has
 * explicitly decided against.
 */
export function legacyEnabledForLockoutMode(
  mode: SubscriptionLockoutMode,
): boolean {
  return mode !== "NO_BLOCK";
}

export interface MembershipLockoutSettings {
  /**
   * How an unpaid member is treated at booking time (#2543):
   *  - `NO_BLOCK` — no subscription gate at all;
   *  - `HARD_BLOCK` — refuse the booking (the pre-#2543 `enabled: true`);
   *  - `NON_MEMBER_PRICING` — allow it, price the unpaid member at non-member
   *    rates, and require a paid-up adult member on the booking.
   */
  mode: SubscriptionLockoutMode;
  /**
   * Membership financial year-end month (1-12), or null to follow the connected
   * Xero organisation's accounting financial year.
   */
  financialYearEndMonthOverride: number | null;
  /**
   * When true, an invoice whose reference/description text reads like a
   * membership subscription also counts during detection, in addition to the
   * configured account/item code.
   */
  textFallbackEnabled: boolean;
  /**
   * When true (#2109), paid detection matches ANY item code stamped on the fee
   * schedule (distinct `MembershipAnnualFeeComponent.xeroItemCode`) in addition
   * to the single configured subscription item code. Default false reproduces
   * the single-code behaviour byte-for-byte.
   */
  useFeeScheduleItemCodes: boolean;
}

export interface PersistedMembershipLockoutSettings {
  /**
   * Null for any club that has not saved the panel since #2543 — the migration
   * adds the column without a backfill. `normalizeMembershipLockoutSettings`
   * resolves the null from `enabled`.
   */
  mode?: SubscriptionLockoutMode | string | null;
  /**
   * LEGACY, superseded by `mode` (#2543), and still a live column for the
   * duration of the expand/contract window. Two readers depend on it:
   * an un-backfilled row (every club, until an admin next saves) and a
   * config-transfer bundle exported before #2543. Both are mapped in
   * `coerceLockoutMode`.
   */
  enabled?: boolean | null;
  financialYearEndMonthOverride: number | null;
  textFallbackEnabled: boolean | null;
  useFeeScheduleItemCodes: boolean | null;
  updatedByMemberId?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

function getDefaultMembershipLockoutSettings(): MembershipLockoutSettings {
  // Field-by-field rather than a spread: the defaults constant also carries the
  // legacy `enabled` value for config-transfer's benefit, and that column is not
  // part of the resolved settings any application code should see.
  return {
    mode: DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS.mode,
    financialYearEndMonthOverride:
      DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS.financialYearEndMonthOverride,
    textFallbackEnabled: DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS.textFallbackEnabled,
    useFeeScheduleItemCodes:
      DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS.useFeeScheduleItemCodes,
  };
}

function coerceYearEndOverride(
  value: number | null | undefined,
): number | null {
  if (value == null || typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded >= 1 && rounded <= 12 ? rounded : null;
}

/**
 * Resolve the stored three-way mode (#2543).
 *
 * Three inputs, in priority order, and the order is the whole point:
 *
 *  1. a recognised `mode` — set once an admin has saved the panel, or once a
 *     post-#2543 config bundle has been imported;
 *  2. otherwise the legacy `enabled` boolean, mapped `true -> HARD_BLOCK`,
 *     `false -> NO_BLOCK`. THIS IS THE PATH EVERY EXISTING CLUB TAKES on the
 *     release that ships #2543: the migration adds `mode` without a backfill, so
 *     `mode` is null until somebody chooses one. Defaulting a null to HARD_BLOCK
 *     instead would turn the lockout back ON for every club that had
 *     deliberately switched it off — a money-affecting behaviour change nobody
 *     asked for. It is also the path an old config-transfer bundle takes;
 *  3. otherwise (no row at all) the default, HARD_BLOCK.
 *
 * An unrecognised `mode` string falls through to the same ladder rather than
 * being trusted, so a hand-edited bundle cannot invent a fourth policy.
 */
function coerceLockoutMode(
  persisted: Partial<PersistedMembershipLockoutSettings> | null | undefined,
  fallback: SubscriptionLockoutMode,
): SubscriptionLockoutMode {
  if (isSubscriptionLockoutMode(persisted?.mode)) {
    return persisted.mode;
  }
  if (typeof persisted?.enabled === "boolean") {
    return persisted.enabled ? "HARD_BLOCK" : "NO_BLOCK";
  }
  return fallback;
}

export function normalizeMembershipLockoutSettings(
  persisted?: Partial<PersistedMembershipLockoutSettings> | null,
): MembershipLockoutSettings {
  const defaults = getDefaultMembershipLockoutSettings();
  return {
    mode: coerceLockoutMode(persisted, defaults.mode),
    financialYearEndMonthOverride: coerceYearEndOverride(
      persisted?.financialYearEndMonthOverride,
    ),
    textFallbackEnabled:
      persisted?.textFallbackEnabled ?? defaults.textFallbackEnabled,
    useFeeScheduleItemCodes:
      persisted?.useFeeScheduleItemCodes ?? defaults.useFeeScheduleItemCodes,
  };
}

export async function loadPersistedMembershipLockoutSettings(): Promise<PersistedMembershipLockoutSettings | null> {
  try {
    return await prisma.membershipLockoutSettings.findUnique({
      where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    });
  } catch {
    // Table may not exist yet (migration not applied); fall back to defaults.
    return null;
  }
}

export async function loadMembershipLockoutSettings(): Promise<MembershipLockoutSettings> {
  return normalizeMembershipLockoutSettings(
    await loadPersistedMembershipLockoutSettings(),
  );
}
