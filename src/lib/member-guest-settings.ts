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
 * WHO READS THIS. `approvalRequired` and `pendingHoldExpiryDays` drive MG2's
 * consent plumbing through `loadMemberGuestAddPolicy`. As of MG3 (#2308) the two
 * open-search values have readers too:
 * `loadMemberGuestFindGate` (`member-guest-find-service.ts`) gates the name
 * type-ahead route's existence on `openMemberSearchEnabled`, and its age-tier
 * filter on `openMemberSearchIncludesMinors`.
 *
 * THE PROMISE THIS FILE MADE, AND MG3 KEPT. While the two values were saved but
 * read by nothing, the admin card that writes them
 * (`src/components/admin/member-guest-settings-card.tsx`) carried a paragraph
 * saying so in as many words — "Not in use yet … starts working on its own when
 * that update arrives" — because a stored privacy decision that quietly comes to
 * life on a later deploy, with nobody asked again, is the failure this pair was
 * one step away from. The note here said that annotation would come off in the
 * SAME change that gave the values a reader. MG3 is that change and it did,
 * exactly as MG1's "not available yet" module state came off in MG2.
 *
 * Both still ship OFF, and both still refuse to travel in club config transfer
 * (D-18): importing another club's configuration must never quietly make your
 * own membership list browsable.
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

// The admin-payload shape (settings + updatedAt + updatedByMemberId + the
// view/manage capability signal) is deliberately NOT built here: it belongs with
// the admin GET that returns it, which is now
// src/app/api/admin/member-guest-settings/route.ts (MG2 #2307, D-17). That route
// reads the row itself — it needs the audit columns, which this loader's value
// type does not carry — and fills any miss through normalizeMemberGuestSettings
// below, so the defaults reach an admin and a booking path by the same code.
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
