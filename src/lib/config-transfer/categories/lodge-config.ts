import { strToU8, strFromU8 } from "fflate";

import type { BundleEntry } from "../bundle";
import { serialiseCsv, parseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  hashRow,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
  type ReadDb,
  type TxDb,
} from "../import-types";

// lodge-config category (part 1): lodges + their rooms + beds — the structural
// "multi-lodge" core. Foreign keys travel as natural keys (lodge slug, room
// name); import resolves them in dependency order. Per-lodge capacity/settings
// are deliberately out of scope (their id="default"-vs-lodgeId storage duality
// makes cross-instance round-tripping unsafe; set them on the lodge page).
// See ADR-001/002.

const LODGE_FILE = "lodge-config/lodges.csv";
const ROOM_FILE = "lodge-config/rooms.csv";
const BED_FILE = "lodge-config/beds.csv";

const LODGE_FIELDS = ["slug", "name", "active", "travelNote", "doorCode"] as const;
const ROOM_FIELDS = ["lodgeSlug", "name", "sortOrder", "active", "notes"] as const;
const BED_FIELDS = ["lodgeSlug", "roomName", "name", "sortOrder", "active"] as const;

registerEntity({
  entity: "lodge",
  category: "lodge-config",
  tier: "key-strong",
  format: "csv",
  file: LODGE_FILE,
  naturalKey: ["slug"],
  singleton: false,
  fields: [...LODGE_FIELDS],
  optInFields: ["doorCode"],
});
registerEntity({
  entity: "lodge-room",
  category: "lodge-config",
  tier: "key-strong",
  format: "csv",
  file: ROOM_FILE,
  naturalKey: ["lodgeSlug", "name"],
  singleton: false,
  fields: [...ROOM_FIELDS],
});
registerEntity({
  entity: "lodge-bed",
  category: "lodge-config",
  tier: "key-strong",
  format: "csv",
  file: BED_FILE,
  naturalKey: ["lodgeSlug", "roomName", "name"],
  singleton: false,
  fields: [...BED_FIELDS],
});

function coerceInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}
function coerceBool(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}
function readCsv(files: Map<string, Uint8Array>, path: string) {
  const bytes = files.get(path);
  return bytes ? parseCsv(strFromU8(bytes)).rows : [];
}

async function lodgeSlugToId(db: ReadDb | TxDb): Promise<Map<string, string>> {
  const lodges = await db.lodge.findMany({ select: { id: true, slug: true } });
  return new Map(lodges.map((l) => [l.slug, l.id]));
}

// ---- Export ----------------------------------------------------------------

export const lodgeConfigExporter: CategoryExporter = {
  category: "lodge-config",
  descriptors: [],
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const lodges = await ctx.db.lodge.findMany({
      orderBy: { slug: "asc" },
      select: {
        slug: true,
        name: true,
        active: true,
        travelNote: true,
        doorCode: true,
      },
    });
    const rooms = await ctx.db.lodgeRoom.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        name: true,
        sortOrder: true,
        active: true,
        notes: true,
        lodge: { select: { slug: true } },
      },
    });
    const beds = await ctx.db.lodgeBed.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        name: true,
        sortOrder: true,
        active: true,
        room: { select: { name: true, lodge: { select: { slug: true } } } },
      },
    });

    const lodgeRows = lodges.map((l) => ({
      slug: l.slug,
      name: l.name,
      active: l.active,
      travelNote: l.travelNote,
      doorCode: ctx.includeDoorCodes ? l.doorCode : undefined,
    }));
    const roomRows = rooms.map((r) => ({
      lodgeSlug: r.lodge.slug,
      name: r.name,
      sortOrder: r.sortOrder,
      active: r.active,
      notes: r.notes,
    }));
    const bedRows = beds.map((b) => ({
      lodgeSlug: b.room.lodge.slug,
      roomName: b.room.name,
      name: b.name,
      sortOrder: b.sortOrder,
      active: b.active,
    }));

    const lodgeFields = ctx.includeDoorCodes
      ? [...LODGE_FIELDS]
      : LODGE_FIELDS.filter((f) => f !== "doorCode");

    return [
      {
        path: LODGE_FILE,
        category: "lodge-config",
        rowCount: lodgeRows.length,
        bytes: strToU8(serialiseCsv(lodgeFields, lodgeRows)),
      },
      {
        path: ROOM_FILE,
        category: "lodge-config",
        rowCount: roomRows.length,
        bytes: strToU8(serialiseCsv([...ROOM_FIELDS], roomRows)),
      },
      {
        path: BED_FILE,
        category: "lodge-config",
        rowCount: bedRows.length,
        bytes: strToU8(serialiseCsv([...BED_FIELDS], bedRows)),
      },
    ];
  },
};

// ---- Plan ------------------------------------------------------------------

async function planLodgeConfig(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const fingerprintParts: string[] = [];
  const slugToId = await lodgeSlugToId(ctx.db);

  // Lodges.
  for (const raw of readCsv(ctx.files, LODGE_FILE)) {
    const current = await ctx.db.lodge.findUnique({
      where: { slug: raw.slug ?? "" },
      select: { slug: true, name: true, active: true, travelNote: true, doorCode: true },
    });
    fingerprintParts.push(
      `lodge:${raw.slug}:${current ? hashRow([...LODGE_FIELDS], current) : "absent"}`,
    );
    items.push({
      entity: "lodge",
      key: raw.slug ?? "",
      action: current ? "update" : "create",
    });
  }

  // Rooms.
  for (const raw of readCsv(ctx.files, ROOM_FILE)) {
    const lodgeId = slugToId.get(raw.lodgeSlug ?? "");
    const key = `${raw.lodgeSlug}/${raw.name}`;
    if (!lodgeId) {
      warnings.push(`Room "${key}" references an unknown lodge; will create the lodge first or skip.`);
      items.push({ entity: "lodge-room", key, action: "create" });
      fingerprintParts.push(`lodge-room:${key}:absent`);
      continue;
    }
    const current = await ctx.db.lodgeRoom.findUnique({
      where: { lodgeId_name: { lodgeId, name: raw.name ?? "" } },
      select: { name: true, sortOrder: true, active: true, notes: true },
    });
    fingerprintParts.push(`lodge-room:${key}:${current ? hashRow(["name", "sortOrder", "active", "notes"], current) : "absent"}`);
    items.push({ entity: "lodge-room", key, action: current ? "update" : "create" });
  }

  // Beds.
  for (const raw of readCsv(ctx.files, BED_FILE)) {
    const key = `${raw.lodgeSlug}/${raw.roomName}/${raw.name}`;
    const lodgeId = slugToId.get(raw.lodgeSlug ?? "");
    const room = lodgeId
      ? await ctx.db.lodgeRoom.findUnique({
          where: { lodgeId_name: { lodgeId, name: raw.roomName ?? "" } },
          select: { id: true },
        })
      : null;
    const current = room
      ? await ctx.db.lodgeBed.findUnique({
          where: { roomId_name: { roomId: room.id, name: raw.name ?? "" } },
          select: { name: true, sortOrder: true, active: true },
        })
      : null;
    fingerprintParts.push(`lodge-bed:${key}:${current ? hashRow(["name", "sortOrder", "active"], current) : "absent"}`);
    items.push({ entity: "lodge-bed", key, action: current ? "update" : "create" });
  }

  return { items, warnings, fingerprintParts };
}

// ---- Apply -----------------------------------------------------------------

async function applyLodgeConfig(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

  // 1) Lodges (by slug).
  for (const raw of readCsv(ctx.files, LODGE_FILE)) {
    const slug = raw.slug ?? "";
    if (!slug) { result.skipped += 1; continue; }
    const data: Record<string, unknown> = {
      name: raw.name ?? slug,
      active: coerceBool(raw.active),
      travelNote: raw.travelNote ?? null,
    };
    if ("doorCode" in raw) data.doorCode = raw.doorCode || null;
    const existing = await ctx.tx.lodge.findUnique({ where: { slug }, select: { id: true } });
    await ctx.tx.lodge.upsert({
      where: { slug },
      create: { slug, ...(data as { name: string }) },
      update: data,
    });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  const slugToId = await lodgeSlugToId(ctx.tx);

  // 2) Rooms (by lodgeId + name).
  for (const raw of readCsv(ctx.files, ROOM_FILE)) {
    const lodgeId = slugToId.get(raw.lodgeSlug ?? "");
    if (!lodgeId) { result.skipped += 1; continue; }
    const name = raw.name ?? "";
    const data = {
      sortOrder: coerceInt(raw.sortOrder, 0),
      active: coerceBool(raw.active),
      notes: raw.notes || null,
    };
    const existing = await ctx.tx.lodgeRoom.findUnique({
      where: { lodgeId_name: { lodgeId, name } },
      select: { id: true },
    });
    await ctx.tx.lodgeRoom.upsert({
      where: { lodgeId_name: { lodgeId, name } },
      create: { lodgeId, name, ...data },
      update: data,
    });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  // 3) Beds (by roomId + name).
  for (const raw of readCsv(ctx.files, BED_FILE)) {
    const lodgeId = slugToId.get(raw.lodgeSlug ?? "");
    if (!lodgeId) { result.skipped += 1; continue; }
    const room = await ctx.tx.lodgeRoom.findUnique({
      where: { lodgeId_name: { lodgeId, name: raw.roomName ?? "" } },
      select: { id: true },
    });
    if (!room) { result.skipped += 1; continue; }
    const name = raw.name ?? "";
    const data = { sortOrder: coerceInt(raw.sortOrder, 0), active: coerceBool(raw.active) };
    const existing = await ctx.tx.lodgeBed.findUnique({
      where: { roomId_name: { roomId: room.id, name } },
      select: { id: true },
    });
    await ctx.tx.lodgeBed.upsert({
      where: { roomId_name: { roomId: room.id, name } },
      create: { roomId: room.id, name, ...data },
      update: data,
    });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  return result;
}

export const lodgeConfigImporter: CategoryImporter = {
  category: "lodge-config",
  plan: planLodgeConfig,
  apply: applyLodgeConfig,
};
