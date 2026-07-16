import { describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { xeroConfigImporter } from "@/lib/config-transfer/categories/xero-config";
import type { TxDb } from "@/lib/config-transfer/import-types";
import { getEffectiveJoiningFee } from "@/lib/authoritative-fees";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";

// Config-transfer joining-fee materialisation (#1931, E5 — HIGH-1): old
// (pre-#1931) bundles carry joining-fee AMOUNTS only in item-code-mappings.csv
// amountCents, a column the runtime no longer reads. Importing such a bundle
// into a fresh install must materialise JoiningFee windows via the same D-R1
// fan-out the migration uses — otherwise every member joins with no joining
// fee, silently.

const MEMBERSHIP_TYPES = [
  { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-associate", key: "ASSOCIATE", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-family", key: "FAMILY", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-school", key: "SCHOOL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: false },
];

type JoiningFeeRow = {
  membershipTypeId: string;
  ageTier: string | null;
  amountCents: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

function makeTx(captures: {
  joiningFeeCreates: JoiningFeeRow[];
  existingWindows?: JoiningFeeRow[];
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
    membershipType: { ...noopDelegate, findMany: async () => MEMBERSHIP_TYPES },
    joiningFee: {
      ...noopDelegate,
      findMany: async () => [
        ...(captures.existingWindows ?? []),
        ...captures.joiningFeeCreates,
      ],
      create: async ({ data }: { data: JoiningFeeRow }) => {
        captures.joiningFeeCreates.push(data);
        return { id: `jf-${captures.joiningFeeCreates.length}` };
      },
    },
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

function planCtx(files: Map<string, Uint8Array>, db: TxDb) {
  return {
    db,
    files,
    manifest: {} as never,
    mode: "merge" as const,
    resolutions: new Map<string, string>(),
  };
}

/** Old-bundle CSV: pre-#1931 ENTRANCE_FEE label, amounts in amountCents. */
function oldBundle(rows: string[]): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["xero-config/item-code-mappings.csv", strToU8(
      "category,ageTier,seasonType,isMember,entranceFeeCategory,itemCode,amountCents\n" +
      rows.join("\n") + "\n",
    )],
  ]);
}

const FULL_OLD_BUNDLE = oldBundle([
  "ENTRANCE_FEE,,,,ADULT,ENT-AD,10000",
  "ENTRANCE_FEE,,,,YOUTH,ENT-YO,5000",
  "ENTRANCE_FEE,,,,CHILD,ENT-CH,2500",
  "ENTRANCE_FEE,,,,FAMILY,ENT-FA,20000",
]);

describe("config-transfer joining-fee materialisation (#1931, E5)", () => {
  it("materialises D-R1 fan-out windows from an old bundle on a fresh install, and a member then resolves the fee", async () => {
    const captures = { joiningFeeCreates: [] as JoiningFeeRow[] };
    await xeroConfigImporter.apply(applyCtx(FULL_OLD_BUNDLE, makeTx(captures)) as never);

    const today = getTodayDateOnly();
    // Per-tier fan-out to every liable type (FULL, ASSOCIATE) — never to
    // NON_MEMBER, SCHOOL, or the Family type — plus the flat family row:
    // ADULT x2 + YOUTH x2 + CHILD/INFANT x4 + FAMILY flat x1 = 9 open windows.
    expect(captures.joiningFeeCreates).toHaveLength(9);
    for (const liable of ["mt-full", "mt-associate"]) {
      expect(captures.joiningFeeCreates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ membershipTypeId: liable, ageTier: "ADULT", amountCents: 10000, effectiveFrom: today, effectiveTo: null }),
          expect.objectContaining({ membershipTypeId: liable, ageTier: "YOUTH", amountCents: 5000, effectiveTo: null }),
          expect.objectContaining({ membershipTypeId: liable, ageTier: "CHILD", amountCents: 2500, effectiveTo: null }),
          expect.objectContaining({ membershipTypeId: liable, ageTier: "INFANT", amountCents: 2500, effectiveTo: null }),
        ]),
      );
    }
    expect(captures.joiningFeeCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ membershipTypeId: "mt-family", ageTier: null, amountCents: 20000, effectiveTo: null }),
      ]),
    );
    const targetedTypes = new Set(captures.joiningFeeCreates.map((r) => r.membershipTypeId));
    expect(targetedTypes.has("mt-nonmember")).toBe(false);
    expect(targetedTypes.has("mt-school")).toBe(false);

    // End-to-end: the shared resolver finds the materialised windows, so a
    // member joining after the import resolves a real fee (no silent zero).
    const store = {
      joiningFee: {
        findFirst: async ({ where }: { where: { membershipTypeId: string; ageTier: string | null } }) => {
          const match = captures.joiningFeeCreates.find(
            (row) =>
              row.membershipTypeId === where.membershipTypeId &&
              row.ageTier === (where.ageTier ?? null),
          );
          return match
            ? { amountCents: match.amountCents, effectiveFrom: match.effectiveFrom }
            : null;
        },
      },
    };
    const adultFee = await getEffectiveJoiningFee(
      { membershipTypeId: "mt-full", ageTier: "ADULT" }, today, store as never,
    );
    expect(adultFee).toMatchObject({ amountCents: 10000, source: "SCHEDULE" });
    const familyFee = await getEffectiveJoiningFee(
      { membershipTypeId: "mt-family", ageTier: "ADULT" }, today, store as never,
    );
    expect(familyFee).toMatchObject({ amountCents: 20000, source: "SCHEDULE" });
  });

  it("leaves a category alone when the target already has a covering window (deliberate config wins)", async () => {
    const today = getTodayDateOnly();
    const captures = {
      joiningFeeCreates: [] as JoiningFeeRow[],
      existingWindows: [
        // A covering adult-tier window on ANY liable type marks ADULT covered.
        { membershipTypeId: "mt-full", ageTier: "ADULT", amountCents: 7700, effectiveFrom: addDaysDateOnly(today, -30), effectiveTo: null },
      ],
    };
    await xeroConfigImporter.apply(
      applyCtx(oldBundle(["ENTRANCE_FEE,,,,ADULT,ENT-AD,10000"]), makeTx(captures)) as never,
    );
    expect(captures.joiningFeeCreates).toHaveLength(0);
  });

  it("bounds a materialised window to the day before a cell's future window (no overlap)", async () => {
    const today = getTodayDateOnly();
    const futureStart = addDaysDateOnly(today, 10);
    const captures = {
      joiningFeeCreates: [] as JoiningFeeRow[],
      existingWindows: [
        // Future-only window: does NOT cover today, so ADULT still materialises,
        // but the mt-full/ADULT cell must be bounded to the day before it.
        { membershipTypeId: "mt-full", ageTier: "ADULT", amountCents: 9900, effectiveFrom: futureStart, effectiveTo: null },
      ],
    };
    await xeroConfigImporter.apply(
      applyCtx(oldBundle(["ENTRANCE_FEE,,,,ADULT,ENT-AD,10000"]), makeTx(captures)) as never,
    );

    const fullAdult = captures.joiningFeeCreates.find(
      (row) => row.membershipTypeId === "mt-full" && row.ageTier === "ADULT",
    );
    const associateAdult = captures.joiningFeeCreates.find(
      (row) => row.membershipTypeId === "mt-associate" && row.ageTier === "ADULT",
    );
    expect(fullAdult?.effectiveTo).toEqual(addDaysDateOnly(futureStart, -1));
    expect(associateAdult?.effectiveTo).toBeNull();
  });

  it("ignores zero/absent amounts (no windows materialised from item-code-only rows)", async () => {
    const captures = { joiningFeeCreates: [] as JoiningFeeRow[] };
    await xeroConfigImporter.apply(
      applyCtx(oldBundle(["ENTRANCE_FEE,,,,ADULT,ENT-AD,", "ENTRANCE_FEE,,,,YOUTH,ENT-YO,0"]), makeTx(captures)) as never,
    );
    expect(captures.joiningFeeCreates).toHaveLength(0);
  });

  it("plan previews the materialisation and binds coverage into the fingerprint", async () => {
    const captures = { joiningFeeCreates: [] as JoiningFeeRow[] };
    const plan = await xeroConfigImporter.plan(planCtx(FULL_OLD_BUNDLE, makeTx(captures)) as never);

    expect(plan.errors).toEqual([]);
    expect(plan.items).toEqual(
      expect.arrayContaining([
        { entity: "joining-fee-window", key: "ADULT", action: "create" },
        { entity: "joining-fee-window", key: "FAMILY", action: "create" },
      ]),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Joining-fee windows will be created")]),
    );
    expect(plan.fingerprintParts).toEqual(
      expect.arrayContaining([
        "joining-fee-coverage:ADULT:absent",
        "joining-fee-coverage:CHILD:absent",
        "joining-fee-coverage:FAMILY:absent",
        "joining-fee-coverage:YOUTH:absent",
      ]),
    );
    // Plan is a dry run: nothing was written.
    expect(captures.joiningFeeCreates).toHaveLength(0);
  });
});
