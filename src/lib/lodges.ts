import type { Lodge, Prisma, PrismaClient } from "@prisma/client";

// Callers pass their own Prisma client/transaction so this module stays free
// of the app prisma singleton and safe to import from prisma/seed.ts.
type LodgeDb = Pick<PrismaClient, "lodge">;

// Lodge management helpers for the multiLodge Admin Module (phase 1 of
// docs/multi-lodge/implementation-plan.md). The Lodge table is core and every
// deployment has at least one row; these helpers manage lodge identity only.
// Capacity, pricing, and booking scoping arrive in later phases.

export const lodgeSelect = {
  id: true,
  name: true,
  slug: true,
  active: true,
  doorCode: true,
  travelNote: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LodgeSelect;

export type LodgeRecord = Pick<Lodge, keyof typeof lodgeSelect>;

export interface SerializedLodge {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  doorCode: string | null;
  travelNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeLodge(lodge: LodgeRecord): SerializedLodge {
  return {
    id: lodge.id,
    name: lodge.name,
    slug: lodge.slug,
    active: lodge.active,
    doorCode: lodge.doorCode,
    travelNote: lodge.travelNote,
    createdAt: lodge.createdAt.toISOString(),
    updatedAt: lodge.updatedAt.toISOString(),
  };
}

export function lodgeOrderBy() {
  return [{ createdAt: "asc" }, { id: "asc" }] satisfies
    Prisma.LodgeOrderByWithRelationInput[];
}

export function normalizeLodgeText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function slugifyLodgeName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "lodge";
}

export async function buildUniqueLodgeSlug(
  db: LodgeDb,
  name: string,
  excludeLodgeId?: string,
): Promise<string> {
  const base = slugifyLodgeName(name);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const clash = await db.lodge.findFirst({
      where: {
        slug: candidate,
        ...(excludeLodgeId ? { id: { not: excludeLodgeId } } : {}),
      },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new Error(`Could not derive a unique lodge slug from "${name}"`);
}

export async function countActiveLodges(db: LodgeDb): Promise<number> {
  return db.lodge.count({ where: { active: true } });
}

// Compatibility path (implementation-plan.md phase 1): email rendering still
// reads lodge identity from the EmailMessageSetting singleton until phase 8
// switches templates to per-booking lodge context. While the club has exactly
// one active lodge, keep that singleton in sync so lodge edits show up in
// emails immediately. With more than one active lodge the singleton is
// ambiguous by design and is left untouched.
export async function syncSoleActiveLodgeIdentity(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const activeLodges = await tx.lodge.findMany({
    where: { active: true },
    select: { name: true, doorCode: true, travelNote: true },
    take: 2,
  });
  if (activeLodges.length !== 1) return;

  const [lodge] = activeLodges;
  const identity = {
    lodgeName: lodge.name,
    doorCode: lodge.doorCode,
    lodgeTravelNote: lodge.travelNote,
  };

  await tx.emailMessageSetting.upsert({
    where: { id: "default" },
    create: { id: "default", ...identity },
    update: identity,
  });
}
