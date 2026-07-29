import type { MemberGuestSettings } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { DEFAULT_MEMBER_GUEST_SETTINGS } from "@/config/club-settings-defaults";

/**
 * Server loader for the single-row ("default") member-guest policy singleton
 * ("+ Add Member Guest", epic #2305, MG1 #2306).
 *
 * Follows the `member-fields-settings.ts` / `booking-request.ts` shape: the row
 * is created LAZILY — reading it on a club that has never saved it returns the
 * schema defaults and writes nothing — so the migration seeds no row and a
 * fresh install needs no config step.
 *
 * WHAT READS THIS IN THIS RELEASE: nothing but its own tests and the
 * config-transfer export (which reads the delegate directly, not through here).
 * That is deliberate. Per owner decision D-17, MG1 ships the module toggle only;
 * MG2 (#2307) ships the admin settings card, the `/api/admin` route that writes
 * these values, and the behaviour that reads them. This loader lands now so the
 * singleton, its defaults, and its config-transfer classification are one
 * reviewable change instead of three.
 *
 * In particular `openMemberSearchEnabled` and `openMemberSearchIncludesMinors`
 * are read by NOTHING at runtime and must stay that way until MG3: they decide
 * whether the club's membership list becomes browsable, and both ship OFF.
 */

export const MEMBER_GUEST_SETTINGS_ID = "default";

/** The policy values, with every miss filled from the shared defaults. */
export type MemberGuestSettingsValues = {
  approvalRequired: boolean;
  pendingHoldExpiryDays: number;
  openMemberSearchEnabled: boolean;
  openMemberSearchIncludesMinors: boolean;
};

// The inclusive bounds for pendingHoldExpiryDays live with the defaults in
// src/config/club-settings-defaults.ts (MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN
// / _MAX) so the config-transfer spec and MG2's admin route can enforce the same
// two numbers without importing this Prisma-backed module.

// The admin-payload shape (settings + updatedAt + updatedByMemberId) is
// deliberately NOT built here: it belongs with the admin GET that returns it,
// which ships in MG2 (#2307) with the settings card (D-17).
type MemberGuestSettingsRecord = Pick<
  MemberGuestSettings,
  keyof MemberGuestSettingsValues | "updatedAt" | "updatedByMemberId"
>;

export function normalizeMemberGuestSettings(
  record?: Partial<MemberGuestSettingsRecord> | null,
): MemberGuestSettingsValues {
  return {
    approvalRequired:
      record?.approvalRequired ?? DEFAULT_MEMBER_GUEST_SETTINGS.approvalRequired,
    pendingHoldExpiryDays:
      record?.pendingHoldExpiryDays ??
      DEFAULT_MEMBER_GUEST_SETTINGS.pendingHoldExpiryDays,
    openMemberSearchEnabled:
      record?.openMemberSearchEnabled ??
      DEFAULT_MEMBER_GUEST_SETTINGS.openMemberSearchEnabled,
    openMemberSearchIncludesMinors:
      record?.openMemberSearchIncludesMinors ??
      DEFAULT_MEMBER_GUEST_SETTINGS.openMemberSearchIncludesMinors,
  };
}

/**
 * Read the policy. Resilient to the row — or the table, during a blue/green
 * deploy window — being absent: falls back to the defaults rather than throwing
 * into a booking flow.
 */
export async function loadMemberGuestSettings(): Promise<MemberGuestSettingsValues> {
  try {
    const record = await prisma.memberGuestSettings.findUnique({
      where: { id: MEMBER_GUEST_SETTINGS_ID },
    });
    return normalizeMemberGuestSettings(record);
  } catch (err) {
    logger.error(
      { err },
      "Failed to load member-guest settings; using defaults",
    );
    return { ...DEFAULT_MEMBER_GUEST_SETTINGS };
  }
}
