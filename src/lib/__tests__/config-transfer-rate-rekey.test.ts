import { describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { lodgeConfigImporter } from "@/lib/config-transfer/categories/lodge-config";
import { xeroConfigImporter } from "@/lib/config-transfer/categories/xero-config";
import type { TxDb } from "@/lib/config-transfer/import-types";

// Config-transfer season-rate + Xero HUT_FEE re-key (#1930, E4): apply writes the
// membership-type-keyed rows, and OLD bundles carrying `isMember` still import
// (true -> FULL, false -> NON_MEMBER, documented lossy compat).

const MEMBERSHIP_TYPES = [
  { id: "mt-full", key: "FULL" },
  { id: "mt-nonmember", key: "NON_MEMBER" },
];

/**
 * A permissive in-memory tx: named delegates model the reads the apply needs;
 * any other delegate/method is a no-op so the apply's unrelated passes (rooms,
 * beds, instructions, default-lodge marker, …) don't throw. Captures the
 * membership-type-keyed creates we assert on.
 */
function makeTx(captures: {
  rateCreates: Record<string, unknown>[];
  itemCreates: Record<string, unknown>[];
}): TxDb {
  const noopDelegate = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({ id: "x" }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({ id: "x" }),
  };
  const specific: Record<string, unknown> = {
    lodge: {
      ...noopDelegate,
      findMany: async () => [
        {
          id: "lodge-1", slug: "main", name: "Main Lodge", active: true, travelNote: null,
          doorCode: null, isDefault: true, displayConfig: null,
          displayNameGranularity: null, displayNotice: null, showGuestPhonesOnScreens: false,
        },
      ],
      findFirst: async () => ({ slug: "main" }),
      findUnique: async () => ({ isDefault: true }),
    },
    season: {
      ...noopDelegate,
      findMany: async () => [
        {
          id: "season-1", lodgeId: "lodge-1", name: "Winter", type: "WINTER",
          startDate: new Date("2026-06-01T00:00:00.000Z"),
          endDate: new Date("2026-09-01T00:00:00.000Z"), active: true,
        },
      ],
    },
    membershipTypeSeasonRate: {
      ...noopDelegate,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        captures.rateCreates.push(data);
        return { id: "r-new" };
      },
    },
    xeroItemCodeMapping: {
      ...noopDelegate,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        captures.itemCreates.push(data);
        return { id: "i-new" };
      },
    },
    membershipType: { ...noopDelegate, findMany: async () => MEMBERSHIP_TYPES },
  };
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => specific[prop as string] ?? noopDelegate,
  }) as unknown as TxDb;
}

function applyCtx(files: Map<string, Uint8Array>, tx: TxDb) {
  return {
    tx,
    files,
    manifest: {} as never,
    mode: "merge" as const,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
  };
}

function lodgeFiles(ratesCsv: string): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["lodge-config/lodges/main/lodge.json", strToU8(JSON.stringify({ slug: "main", name: "Main Lodge" }))],
    ["lodge-config/lodges/main/seasons.csv", strToU8("name,type,startDate,endDate,active\nWinter,WINTER,2026-06-01,2026-09-01,true\n")],
    ["lodge-config/lodges/main/season-rates.csv", strToU8(ratesCsv)],
  ]);
}

describe("config-transfer season-rate re-key apply (#1930, E4)", () => {
  it("writes membership-type-keyed rows from the NEW-shape bundle", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = lodgeFiles(
      "seasonName,membershipTypeKey,ageTier,pricePerNightCents\n" +
      "Winter,FULL,ADULT,5000\n" +
      "Winter,NON_MEMBER,ADULT,7000\n",
    );
    await lodgeConfigImporter.apply(applyCtx(files, makeTx(captures)) as never);

    expect(captures.rateCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seasonId: "season-1", membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 5000 }),
        expect.objectContaining({ seasonId: "season-1", membershipTypeId: "mt-nonmember", ageTier: "ADULT", pricePerNightCents: 7000 }),
      ]),
    );
  });

  it("imports an OLD bundle: isMember true -> FULL, false -> NON_MEMBER", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = lodgeFiles(
      "seasonName,ageTier,isMember,pricePerNightCents\n" +
      "Winter,ADULT,true,5000\n" +
      "Winter,ADULT,false,7000\n",
    );
    await lodgeConfigImporter.apply(applyCtx(files, makeTx(captures)) as never);

    expect(captures.rateCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 5000 }),
        expect.objectContaining({ membershipTypeId: "mt-nonmember", ageTier: "ADULT", pricePerNightCents: 7000 }),
      ]),
    );
  });
});

describe("config-transfer Xero HUT_FEE re-key apply (#1930, E4)", () => {
  it("imports an OLD HUT_FEE bundle: isMember maps to FULL / NON_MEMBER membershipTypeId", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = new Map<string, Uint8Array>([
      ["xero-config/item-code-mappings.csv", strToU8(
        "category,ageTier,seasonType,isMember,entranceFeeCategory,itemCode,amountCents\n" +
        "HUT_FEE,ADULT,WINTER,true,,HUT-MEM,\n" +
        "HUT_FEE,ADULT,WINTER,false,,HUT-NON,\n",
      )],
    ]);
    await xeroConfigImporter.apply(applyCtx(files, makeTx(captures)) as never);

    expect(captures.itemCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "HUT_FEE", membershipTypeId: "mt-full", ageTier: "ADULT", seasonType: "WINTER", itemCode: "HUT-MEM" }),
        expect.objectContaining({ category: "HUT_FEE", membershipTypeId: "mt-nonmember", ageTier: "ADULT", seasonType: "WINTER", itemCode: "HUT-NON" }),
      ]),
    );
    // Legacy isMember column is not carried onto the new-key row.
    for (const created of captures.itemCreates) {
      expect(created.isMember ?? null).toBeNull();
    }
  });
});
