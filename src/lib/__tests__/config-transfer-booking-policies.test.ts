import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  bookingPoliciesExporter,
  bookingPoliciesImporter,
  MINIMUM_STAY_POLICIES_FILE,
} from "@/lib/config-transfer/categories/booking-policies";
import { readBundle } from "@/lib/config-transfer/bundle";
import { parseCsv } from "@/lib/config-transfer/csv";
import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import type { ExportContext } from "@/lib/config-transfer/export-types";
import type {
  ApplyContext,
  PlanContext,
  ReadDb,
  TxDb,
} from "@/lib/config-transfer/import-types";

const lodge = { id: "lodge-tlr", slug: "tukino" };
const policy = {
  id: "policy-1",
  name: "Winter weekends",
  startDate: new Date("2026-06-01T00:00:00.000Z"),
  endDate: new Date("2026-09-30T00:00:00.000Z"),
  triggerDays: [6, 5],
  minimumNights: 2,
  capacityMode: "HOLD",
  active: true,
  lodgeId: lodge.id,
  version: 4,
};

function db(policies: unknown[] = [policy], lodges: unknown[] = [lodge]): ReadDb {
  return {
    lodge: { findMany: vi.fn().mockResolvedValue(lodges) },
    minimumStayPolicy: { findMany: vi.fn().mockResolvedValue(policies) },
  } as unknown as ReadDb;
}

function files(csv: string): Map<string, Uint8Array> {
  return new Map([[MINIMUM_STAY_POLICIES_FILE, strToU8(csv)]]);
}

function planContext(
  csv: string,
  target = db(),
  extraFiles: Array<[string, Uint8Array]> = [],
): PlanContext {
  return {
    db: target,
    files: new Map([[MINIMUM_STAY_POLICIES_FILE, strToU8(csv)], ...extraFiles]),
    manifest: {} as never,
    mode: "merge",
    resolutions: new Map(),
    selectedCategories: ["lodge-config", "booking-policies"],
  };
}

function csvRow(overrides: Record<string, string> = {}): string {
  const row = {
    scope: "tukino",
    name: "Winter weekends",
    startDate: "2026-06-01",
    endDate: "2026-09-30",
    triggerDays: "5|6",
    minimumNights: "2",
    capacityMode: "HOLD",
    active: "true",
    ...overrides,
  };
  return [
    "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active",
    Object.values(row).join(","),
  ].join("\n") + "\n";
}

describe("config-transfer booking policies (#2363)", () => {
  it("exports a deterministic, id-free policy file and always emits an empty header", async () => {
    const context = {
      db: db(),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext;
    const [entry] = await bookingPoliciesExporter.export(context);
    const parsed = parseCsv(strFromU8(entry.bytes));
    expect(entry.path).toBe(MINIMUM_STAY_POLICIES_FILE);
    expect(parsed.headers).toEqual([
      "scope", "name", "startDate", "endDate", "triggerDays",
      "minimumNights", "capacityMode", "active",
    ]);
    expect(parsed.headers).not.toContain("id");
    expect(parsed.headers).not.toContain("version");
    expect(parsed.rows).toEqual([
      expect.objectContaining({
        scope: "tukino",
        triggerDays: "5|6",
        capacityMode: "HOLD",
      }),
    ]);

    const [empty] = await bookingPoliciesExporter.export({
      ...context,
      db: db([]),
    });
    expect(empty.rowCount).toBe(0);
    expect(strFromU8(empty.bytes)).toBe(
      "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active\n",
    );
  });

  it("is wired through the bundle export and plan orchestrators", async () => {
    const exported = await buildConfigExport({
      db: db(),
      categories: ["booking-policies"],
      includeDoorCodes: false,
      appVersion: "0.13.2",
      prismaMigration: null,
      generatedAt: "2026-08-01T00:00:00.000Z",
    });
    const parsed = readBundle(exported.zip);
    expect(exported.categories).toEqual(["booking-policies"]);
    expect(parsed.manifest.includedCategories).toEqual(["booking-policies"]);
    expect(parsed.files.has(MINIMUM_STAY_POLICIES_FILE)).toBe(true);

    const plan = await buildImportPlan(db(), exported.zip, { mode: "merge" });
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toEqual({
      create: 0,
      update: 0,
      delete: 0,
      unchanged: 1,
    });
  });

  it("previews replace-set creates, updates, deletes, and unchanged rows truthfully", async () => {
    const target = [
      policy,
      { ...policy, id: "delete-me", name: "Omitted policy", version: 2 },
      {
        ...policy,
        id: "unchanged",
        name: "Club rule",
        lodgeId: null,
        version: 1,
        capacityMode: "NO_HOLD",
      },
    ];
    const csv = csvRow({ minimumNights: "3" }) +
      "club-wide,Club rule,2026-06-01,2026-09-30,5|6,2,NO_HOLD,true\n" +
      "tukino,New rule,2027-01-01,2027-02-01,0,2,NO_HOLD,false\n";
    const plan = await bookingPoliciesImporter.plan(planContext(csv, db(target)));
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/complete replace-set.*deleted/i);
    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "tukino / Winter weekends", action: "update" }),
      expect.objectContaining({ key: "club-wide / Club rule", action: "unchanged" }),
      expect.objectContaining({ key: "tukino / New rule", action: "create" }),
      expect.objectContaining({ key: "tukino / Omitted policy", action: "delete" }),
    ]));
  });

  it("treats a header-only file as an intentional clear in both write modes", async () => {
    const header =
      "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active\n";
    for (const mode of ["merge", "overwrite"] as const) {
      const ctx = planContext(header);
      ctx.mode = mode;
      const plan = await bookingPoliciesImporter.plan(ctx);
      expect(plan.errors).toEqual([]);
      expect(plan.items).toEqual([
        expect.objectContaining({ action: "delete", key: "tukino / Winter weekends" }),
      ]);
    }
  });

  it("blocks ambiguous natural keys and malformed policy values", async () => {
    const duplicateTarget = db([
      policy,
      { ...policy, id: "policy-2", version: 1 },
    ]);
    const duplicatePlan = await bookingPoliciesImporter.plan(
      planContext(csvRow(), duplicateTarget),
    );
    expect(duplicatePlan.errors.join(" ")).toMatch(/target has duplicate/i);

    const malformed = csvRow({
      endDate: "2026-05-01",
      triggerDays: "6|6",
      minimumNights: "1",
      capacityMode: "MAYBE",
    });
    const malformedPlan = await bookingPoliciesImporter.plan(
      planContext(malformed),
    );
    expect(malformedPlan.errors.join(" ")).toMatch(/endDate.*after startDate/i);
    expect(malformedPlan.errors.join(" ")).toMatch(/duplicate weekdays/i);
    expect(malformedPlan.errors.join(" ")).toMatch(/minimumNights.*at least 2/i);
    expect(malformedPlan.errors.join(" ")).toMatch(/PolicyExceptionCapacityMode/i);
  });

  it("accepts a lodge created by the selected lodge-config category", async () => {
    const newLodge = strToU8(JSON.stringify({ slug: "new-lodge", name: "New" }));
    const plan = await bookingPoliciesImporter.plan(
      planContext(
        csvRow({ scope: "new-lodge" }),
        db([], []),
        [["lodge-config/lodges/new-lodge/lodge.json", newLodge]],
      ),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.items[0]).toMatchObject({
      key: "new-lodge / Winter weekends",
      action: "create",
    });
  });

  it("applies the replacement with version-guarded updates and deletes", async () => {
    const omitted = { ...policy, id: "delete-me", name: "Omitted", version: 8 };
    const findMany = vi.fn().mockResolvedValue([policy, omitted]);
    const create = vi.fn().mockResolvedValue({ id: "created" });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      lodge: { findMany: vi.fn().mockResolvedValue([lodge]) },
      minimumStayPolicy: { findMany, create, updateMany, deleteMany },
    } as unknown as TxDb;
    const csv = csvRow({ capacityMode: "NO_HOLD" }) +
      "club-wide,New club rule,2027-01-01,2027-02-01,0,2,HOLD,true\n";
    const result = await bookingPoliciesImporter.apply({
      tx,
      files: files(csv),
      manifest: {} as never,
      mode: "merge",
      resolutions: new Map(),
      actorMemberId: "admin-1",
      imageRemap: new Map(),
      notes: { doorCodesWritten: [] },
    } as ApplyContext);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: policy.id, version: 4 },
      data: expect.objectContaining({ capacityMode: "NO_HOLD", version: 5 }),
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "delete-me", version: 8 },
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: "New club rule",
        lodgeId: null,
        version: 1,
        capacityMode: "HOLD",
      }),
    }));
    expect(result).toEqual({
      created: 1,
      updated: 1,
      deleted: 1,
      unchanged: 0,
      skipped: 0,
    });
  });

  it("pins config singleton -> policy set -> in-lock re-plan ordering", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/config-transfer/apply.ts"),
      "utf8",
    );
    const configLock = source.indexOf("await acquireConfigImportLock(tx)");
    const policyLock = source.indexOf("await lockMinimumStayPolicySet(tx)");
    const replan = source.indexOf("const replan = await buildImportPlanFromParsed");
    expect(configLock).toBeGreaterThan(-1);
    expect(policyLock).toBeGreaterThan(configLock);
    expect(replan).toBeGreaterThan(policyLock);
  });
});
