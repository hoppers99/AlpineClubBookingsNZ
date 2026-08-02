import type { AgeTier } from "@prisma/client";
import {
  getAgeTierSettings,
  type AgeTierSettingData,
} from "@/lib/age-tier";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import {
  loadMembershipLockoutSettings,
  type SubscriptionLockoutMode,
} from "@/lib/membership-lockout-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { requiresPaidSubscriptionForAgeTier as requiresPaidSubscriptionForAgeTierRule } from "@/lib/policies/subscription";

export function requiresPaidSubscriptionForAgeTier(
  ageTier: AgeTier | null | undefined,
  settings: AgeTierSettingData[]
): boolean {
  return requiresPaidSubscriptionForAgeTierRule(ageTier, settings);
}

export async function requiresPaidSubscriptionForAgeTierFromSettings(
  ageTier: AgeTier | null | undefined
): Promise<boolean> {
  const settings = await getAgeTierSettings();
  return requiresPaidSubscriptionForAgeTier(ageTier, settings);
}

/**
 * The club's effective subscription-lockout policy for booking (#2543).
 *
 * Membership subscriptions are invoiced and reconciled through Xero, so the
 * policy resolves to `NO_BLOCK` whenever the Xero module is effectively off —
 * members could never reach PAID, and neither refusing them nor repricing them
 * would be honest. Otherwise it is exactly the admin's stored three-way mode.
 *
 * This call also reseeds the financial-year cache for the current instance, so
 * the synchronous season helpers stay correct on every gated booking request.
 *
 * SINGLE SOURCE. Every consumer — the booking gates, the pricing reprice, the
 * paid-up-adult requirement and the hosting bridge — reads the mode through
 * this function, so no path can decide the club is in a different regime than
 * its neighbour and produce the "priced as a member here, refused there"
 * inconsistency #2543 exists to remove.
 */
export async function resolveSubscriptionLockoutMode(): Promise<SubscriptionLockoutMode> {
  const mode = await peekSubscriptionLockoutMode();
  if (mode !== "NO_BLOCK") {
    // Reseed the in-process financial-year cache (cheap; uses cached Xero value).
    // Reached on exactly the same condition as before #2543 — the Xero module is
    // on — because `NO_BLOCK` is returned unconditionally when it is off.
    await refreshFinancialYearConfig();
  }
  return mode;
}

/**
 * The same answer WITHOUT reseeding the financial-year cache.
 *
 * For callers that already hold the season year they are asking about — above
 * all the pricing gate in `membership-type-policy.ts`, which is handed
 * `seasonYear` by whoever called it. The distinction is not micro-optimisation:
 * `refreshFinancialYearConfig` can reach Xero for the organisation's accounting
 * year when no admin override is set, and the pricing gate runs INSIDE booking
 * transactions that hold the per-lodge capacity lock. A provider call in there
 * is the one thing the booking rules forbid outright, so the in-transaction
 * reader must not be able to make one.
 */
export async function peekSubscriptionLockoutMode(): Promise<SubscriptionLockoutMode> {
  const flags = await loadEffectiveModuleFlags();
  if (!flags.xeroIntegration) return "NO_BLOCK";
  return (await loadMembershipLockoutSettings()).mode;
}

/**
 * Whether the season subscription gate applies at all.
 *
 * TRUE for both enforcing modes — HARD_BLOCK and NON_MEMBER_PRICING — because
 * both need the same underlying fact ("this member owes a paid subscription for
 * the season"); they differ only in what they DO with it. Keeping this predicate
 * mode-blind is what lets `requiresPaidSubscriptionForMemberForBooking` stay the
 * one gate both regimes are computed from.
 */
export async function isSubscriptionEnforcementActive(): Promise<boolean> {
  return (await resolveSubscriptionLockoutMode()) !== "NO_BLOCK";
}

/**
 * Booking-time subscription gate: the age-tier rule applies only while the
 * Xero module is effectively enabled. Booking-time policy check sites use
 * this instead of the raw age-tier rule so the Xero-off bypass is consistent.
 */
export async function requiresPaidSubscriptionForBooking(
  ageTier: AgeTier | null | undefined
): Promise<boolean> {
  if (!(await isSubscriptionEnforcementActive())) {
    return false;
  }
  return requiresPaidSubscriptionForAgeTierFromSettings(ageTier);
}
