import { describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { lodgeConfigImporter } from "@/lib/config-transfer/categories/lodge-config";
import type { TxDb } from "@/lib/config-transfer/import-types";

// #2338: the per-season flat whole-lodge night rate rides in seasons.csv, so a
// config-transfer restore must carry it through export AND import — a club that
// sets it must not silently lose it on a restore. The export half is asserted in
// config-transfer-lodge-config.test.ts; these tests pin the IMPORT/apply half:
// the rate is written on create, updated when it differs, and (crucially for
// backward compatibility) left untouched by an old bundle that omits the column.

const MEMBERSHIP_TYPES = [
  { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
];

interface Captures {
  seasonCreates: Record<string, unknown>[];
  seasonUpdates: Record<string, unknown>[];
}

/**
 * Permissive in-memory tx. The `existingSeason` argument seeds the target's
 * current Winter season (or none, for a create test); season creates/updates
 * are captured. Every other delegate is a no-op so the apply's unrelated passes
 * do not throw.
 */
function makeTx(
  captures: Captures,
  existingSeason: { flatWholeLodgeNightCents: number | null } | null,
): TxDb {
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
      findMany: async () =>
        existingSeason
          ? [
              {
                id: "season-1", lodgeId: "lodge-1", name: "Winter", type: "WINTER",
                startDate: new Date("2026-06-01T00:00:00.000Z"),
                endDate: new Date("2026-09-01T00:00:00.000Z"), active: true,
                flatWholeLodgeNightCents: existingSeason.flatWholeLodgeNightCents,
              },
            ]
          : [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        captures.seasonCreates.push(data);
        return { id: "season-new" };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        captures.seasonUpdates.push(data);
        return {};
      },
    },
    membershipType: { ...noopDelegate, findMany: async () => MEMBERSHIP_TYPES },
  };
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => specific[prop as string] ?? noopDelegate,
  }) as unknown as TxDb;
}

function applyCtx(
  files: Map<string, Uint8Array>,
  tx: TxDb,
  mode: "merge" | "overwrite" = "merge",
) {
  return {
    tx,
    files,
    manifest: {} as never,
    mode,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
  };
}

function bundle(seasonsCsv: string): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["lodge-config/lodges/main/lodge.json", strToU8(JSON.stringify({ slug: "main", name: "Main Lodge" }))],
    ["lodge-config/lodges/main/seasons.csv", strToU8(seasonsCsv)],
  ]);
}

const emptyCaptures = (): Captures => ({ seasonCreates: [], seasonUpdates: [] });

describe("config-transfer season flat whole-lodge rate (#2338)", () => {
  it("writes the flat rate on create from the seasons.csv column", async () => {
    const captures = emptyCaptures();
    const files = bundle(
      "name,type,startDate,endDate,active,flatWholeLodgeNightCents\n" +
        "Winter,WINTER,2026-06-01,2026-09-01,true,60000\n",
    );
    await lodgeConfigImporter.apply(applyCtx(files, makeTx(captures, null)) as never);

    expect(captures.seasonCreates).toHaveLength(1);
    expect(captures.seasonCreates[0]).toMatchObject({
      name: "Winter",
      flatWholeLodgeNightCents: 60000,
    });
  });

  it("updates an existing season's flat rate when the bundle differs", async () => {
    const captures = emptyCaptures();
    const files = bundle(
      "name,type,startDate,endDate,active,flatWholeLodgeNightCents\n" +
        "Winter,WINTER,2026-06-01,2026-09-01,true,60000\n",
    );
    // Target currently has a DIFFERENT flat rate; the restore must rewrite it.
    await lodgeConfigImporter.apply(
      applyCtx(files, makeTx(captures, { flatWholeLodgeNightCents: 40000 })) as never,
    );

    expect(captures.seasonUpdates).toHaveLength(1);
    expect(captures.seasonUpdates[0]).toMatchObject({ flatWholeLodgeNightCents: 60000 });
  });

  it("leaves an existing flat rate untouched when an OLD bundle omits the column (merge)", async () => {
    const captures = emptyCaptures();
    // A pre-#2338 bundle: no flatWholeLodgeNightCents column at all.
    const files = bundle(
      "name,type,startDate,endDate,active\n" +
        "Winter,WINTER,2026-06-01,2026-09-01,true\n",
    );
    await lodgeConfigImporter.apply(
      applyCtx(files, makeTx(captures, { flatWholeLodgeNightCents: 40000 })) as never,
    );

    // No fields changed (a blank/absent column is dropped in merge mode), so the
    // season is unchanged and its existing flat rate is never overwritten.
    for (const update of captures.seasonUpdates) {
      expect(update).not.toHaveProperty("flatWholeLodgeNightCents");
    }
  });

  it("clears the flat rate in overwrite mode when the column is blank", async () => {
    const captures = emptyCaptures();
    // Overwrite mode: a blank flat-rate cell fully defines the row => clear to null.
    const files = bundle(
      "name,type,startDate,endDate,active,flatWholeLodgeNightCents\n" +
        "Winter,WINTER,2026-06-01,2026-09-01,true,\n",
    );
    await lodgeConfigImporter.apply(
      applyCtx(files, makeTx(captures, { flatWholeLodgeNightCents: 40000 }), "overwrite") as never,
    );

    expect(captures.seasonUpdates).toHaveLength(1);
    expect(captures.seasonUpdates[0]).toMatchObject({ flatWholeLodgeNightCents: null });
  });

  it("rejects a non-numeric flat rate as a blocking plan error", async () => {
    const files = bundle(
      "name,type,startDate,endDate,active,flatWholeLodgeNightCents\n" +
        "Winter,WINTER,2026-06-01,2026-09-01,true,not-a-number\n",
    );
    const plan = await lodgeConfigImporter.plan({
      db: makeTx(emptyCaptures(), null),
      files,
      manifest: {} as never,
      mode: "merge" as const,
      resolutions: new Map<string, string>(),
    } as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("flatWholeLodgeNightCents"),
      ]),
    );
  });
});
