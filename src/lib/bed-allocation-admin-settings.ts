/**
 * Reading and writing the bed-allocation settings row as an admin (#2688).
 *
 * The vocabulary, the defaults and the resolution rule live in
 * `bed-allocation-settings.ts`, which is client-safe and stays that way; this
 * module is the server half that binds them to `prisma` and to the lodge-scoped
 * write target.
 */
import { prisma } from "@/lib/prisma";
import {
  parseBedAllocationPriorityOrder,
  resolveEffectiveBedAllocationSettings,
  type BedAllocationPriority,
  type EffectiveBedAllocationSettings,
} from "@/lib/bed-allocation-settings";
import type { BedAllocationDb } from "@/lib/bed-allocation-admin-contract";

const BED_ALLOCATION_SETTINGS_ID = "default";

export type BedAllocationSettingsPayload = EffectiveBedAllocationSettings;

export async function getEffectiveBedAllocationSettings(
  db: BedAllocationDb = prisma,
  // Lodge scope (lodge-scoping contract): the lodge's own row (id =
  // lodgeId) wins; else the legacy "default" row applies when unlinked or
  // soft-linked to this lodge; else code defaults.
  lodgeId?: string | null,
): Promise<BedAllocationSettingsPayload> {
  return resolveEffectiveBedAllocationSettings(db, lodgeId);
}

export async function updateBedAllocationSettings(input: {
  autoAllocationEnabled: boolean;
  allocationPriorityOrder: BedAllocationPriority[];
  updatedByMemberId: string;
  db?: BedAllocationDb;
  // Scoped admin writes require a lodge. An existing lodge-id row always wins;
  // only when it is absent may a legacy default row linked to this lodge remain
  // the write target. This keeps migration-forward/imported rows authoritative.
  lodgeId: string;
}): Promise<BedAllocationSettingsPayload> {
  const db = input.db ?? prisma;
  const allocationPriorityOrder = parseBedAllocationPriorityOrder(
    input.allocationPriorityOrder,
    "allocationPriorityOrder",
    400,
  );
  const [own, legacy] = await Promise.all([
    db.bedAllocationSettings.findUnique({ where: { id: input.lodgeId } }),
    db.bedAllocationSettings.findUnique({
      where: { id: BED_ALLOCATION_SETTINGS_ID },
    }),
  ]);
  const targetsLegacyRow = !own && legacy?.lodgeId === input.lodgeId;
  const targetId = targetsLegacyRow
    ? BED_ALLOCATION_SETTINGS_ID
    : input.lodgeId;

  await db.bedAllocationSettings.upsert({
    where: { id: targetId },
    create: {
      id: targetId,
      autoAllocationEnabled: input.autoAllocationEnabled,
      allocationPriorityOrder,
      updatedByMemberId: input.updatedByMemberId,
      lodgeId: input.lodgeId,
    },
    update: {
      autoAllocationEnabled: input.autoAllocationEnabled,
      allocationPriorityOrder,
      updatedByMemberId: input.updatedByMemberId,
    },
  });

  return resolveEffectiveBedAllocationSettings(db, input.lodgeId);
}
