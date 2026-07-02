import { prisma } from "@/lib/prisma";

export const LODGE_SETTINGS_ID = "default";

type LodgeCapacityReader = {
  lodgeSettings?: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<{ capacity: number | null; lodgeId?: string | null } | null>;
  };
};

/**
 * Admin-set lodge capacity override, or null to fall back. Reads are
 * resilient: a missing delegate or a query failure resolves to null so
 * capacity always falls back rather than throwing.
 *
 * The settings row is still the "default" singleton (phase-7 of
 * docs/multi-lodge/implementation-plan.md converts it to per-lodge rows), but
 * it was soft-linked to the club's lodge in the phase-2 backfill. When a
 * lodgeId is supplied, the override only applies to that lodge: a row linked
 * to a different lodge resolves null. An unlinked row (null lodgeId — old
 * data written before the backfill or by a draining old colour) keeps legacy
 * behaviour and applies.
 */
export async function loadLodgeCapacityOverride(
  db: LodgeCapacityReader = prisma,
  lodgeId?: string,
): Promise<number | null> {
  if (!db.lodgeSettings?.findUnique) return null;

  try {
    const record = await db.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
    });
    if (!record) return null;
    if (
      lodgeId &&
      record.lodgeId !== undefined &&
      record.lodgeId !== null &&
      record.lodgeId !== lodgeId
    ) {
      return null;
    }
    return record.capacity ?? null;
  } catch {
    return null;
  }
}

export async function updateLodgeCapacity(input: {
  capacity: number | null;
  updatedByMemberId: string;
}): Promise<{ capacity: number | null; updatedAt: Date }> {
  return prisma.lodgeSettings.upsert({
    where: { id: LODGE_SETTINGS_ID },
    create: {
      id: LODGE_SETTINGS_ID,
      capacity: input.capacity,
      updatedByMemberId: input.updatedByMemberId,
    },
    update: {
      capacity: input.capacity,
      updatedByMemberId: input.updatedByMemberId,
    },
    select: { capacity: true, updatedAt: true },
  });
}
