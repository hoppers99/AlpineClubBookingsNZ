import { DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS } from "@/config/club-settings-defaults";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

export const MEMBERSHIP_CANCELLATION_SETTINGS_ID = "default";

// test seam
export const DEFAULT_MEMBERSHIP_CANCELLATION_WARNING_TEXT =
  DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS.warningText;

// test seam
export const DEFAULT_MEMBERSHIP_REJOIN_PROCESS_TEXT =
  DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS.rejoinProcessText;

export interface MembershipCancellationXeroContactGroupSetting {
  groupId: string;
  groupName: string | null;
}

export interface MembershipCancellationSettings {
  warningText: string;
  rejoinProcessText: string;
  xeroArchiveContactsOnCancellation: boolean;
  xeroContactGroups: MembershipCancellationXeroContactGroupSetting[];
}

export interface PersistedMembershipCancellationSettings {
  warningText: string | null;
  rejoinProcessText: string | null;
  xeroArchiveContactsOnCancellation: boolean;
  updatedAt?: Date | string | null;
  updatedByMemberId?: string | null;
  xeroContactGroups?:
    | readonly Partial<MembershipCancellationXeroContactGroupSetting>[]
    | null;
}

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// test seam
export function normalizeMembershipCancellationXeroGroups(
  groups?: readonly Partial<MembershipCancellationXeroContactGroupSetting>[] | null,
): MembershipCancellationXeroContactGroupSetting[] {
  const seen = new Set<string>();
  const normalized: MembershipCancellationXeroContactGroupSetting[] = [];

  for (const group of groups ?? []) {
    const groupId = trimOptional(group.groupId);
    if (!groupId || seen.has(groupId)) {
      continue;
    }

    seen.add(groupId);
    normalized.push({
      groupId,
      groupName: trimOptional(group.groupName) ?? null,
    });
  }

  return normalized;
}

function getDefaultMembershipCancellationSettings(): MembershipCancellationSettings {
  return {
    warningText: DEFAULT_MEMBERSHIP_CANCELLATION_WARNING_TEXT,
    rejoinProcessText: DEFAULT_MEMBERSHIP_REJOIN_PROCESS_TEXT,
    xeroArchiveContactsOnCancellation:
      DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS.xeroArchiveContactsOnCancellation,
    xeroContactGroups: [],
  };
}

export function normalizeMembershipCancellationSettings(
  persisted?: Partial<PersistedMembershipCancellationSettings> | null,
): MembershipCancellationSettings {
  const defaults = getDefaultMembershipCancellationSettings();
  return {
    warningText: trimOptional(persisted?.warningText) ?? defaults.warningText,
    rejoinProcessText:
      trimOptional(persisted?.rejoinProcessText) ?? defaults.rejoinProcessText,
    xeroArchiveContactsOnCancellation: Boolean(
      persisted?.xeroArchiveContactsOnCancellation,
    ),
    xeroContactGroups: normalizeMembershipCancellationXeroGroups(
      persisted?.xeroContactGroups,
    ),
  };
}

async function loadPersistedMembershipCancellationSettings(options?: {
  rethrow?: boolean;
}): Promise<PersistedMembershipCancellationSettings | null> {
  // Some unit tests stub @/lib/prisma with a partial client that omits
  // this delegate. Keep an existence check so those tests still run, but
  // do not use it as a catch-all for generic database errors.
  const delegate = prisma.membershipCancellationSetting;
  if (!delegate) return null;

  try {
    return await delegate.findUnique({
      where: { id: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
      include: {
        xeroContactGroups: {
          orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
        },
      },
    });
  } catch (err) {
    logger.warn(
      { err },
      "membership cancellation settings load failed",
    );
    if (options?.rethrow) throw err;
    return null;
  }
}

export async function loadMembershipCancellationSettings(): Promise<MembershipCancellationSettings> {
  return normalizeMembershipCancellationSettings(
    await loadPersistedMembershipCancellationSettings(),
  );
}

/**
 * The same settings, but a failed read THROWS instead of quietly degrading to
 * the defaults.
 *
 * Degrading is right almost everywhere — a page that cannot read its copy shows
 * the standard copy. It is wrong in exactly one place: the unpaid-invoice
 * approval gate (#2392), whose whole doctrine is that an unknown answer blocks.
 * The defaults have `xeroArchiveContactsOnCancellation: false`, so a database
 * blip during the read would tell that gate "nothing will be archived, skip the
 * check" — while the archive itself is an outbox operation drained minutes
 * later, off a read that succeeds. "Archiving is off" and "we could not find out
 * whether archiving is on" are opposite answers and only one of them is safe to
 * skip the check on.
 */
export async function loadMembershipCancellationSettingsStrict(): Promise<MembershipCancellationSettings> {
  return normalizeMembershipCancellationSettings(
    await loadPersistedMembershipCancellationSettings({ rethrow: true }),
  );
}
