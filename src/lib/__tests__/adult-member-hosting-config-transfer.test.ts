import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  bookingPoliciesExporter,
  bookingPoliciesImporter,
  MINIMUM_STAY_POLICIES_FILE,
} from "@/lib/config-transfer/categories/booking-policies";
import { ADULT_MEMBER_HOSTING_FILE } from "@/lib/config-transfer/categories/adult-member-hosting";
import { parseCsv } from "@/lib/config-transfer/csv";
import type { ExportContext } from "@/lib/config-transfer/export-types";
import type {
  ApplyContext,
  PlanContext,
  ReadDb,
  TxDb,
} from "@/lib/config-transfer/import-types";

const lodge = { id: "lodge-tlr", slug: "tukino" };

const clubPolicy = {
  id: "hosting-club",
  scopeKey: "club-wide",
  lodgeId: null,
  mode: "ADMIN_REVIEW_REQUIRED",
  capacityMode: "HOLD",
  version: 2,
};
const lodgePolicy = {
  id: "hosting-lodge",
  scopeKey: lodge.id,
  lodgeId: lodge.id,
  mode: "INHERIT",
  capacityMode: "NO_HOLD",
  version: 1,
};

const EMPTY_MIN_STAY =
  "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active\n";
const HEADER = "scope,mode,capacityMode\n";

function db(hosting: unknown[] = [clubPolicy, lodgePolicy]): ReadDb {
  return {
    lodge: { findMany: vi.fn().mockResolvedValue([lodge]) },
    minimumStayPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue(hosting) },
  } as unknown as ReadDb;
}

function planContext(hostingCsv: string, target = db()): PlanContext {
  return {
    db: target,
    files: new Map([
      [MINIMUM_STAY_POLICIES_FILE, strToU8(EMPTY_MIN_STAY)],
      [ADULT_MEMBER_HOSTING_FILE, strToU8(hostingCsv)],
    ]),
    manifest: {} as never,
    mode: "merge",
    resolutions: new Map(),
    selectedCategories: ["booking-policies"],
  };
}

function applyContext(
  hostingCsv: string,
  tx: TxDb,
): ApplyContext {
  return {
    tx,
    files: new Map([
      [MINIMUM_STAY_POLICIES_FILE, strToU8(EMPTY_MIN_STAY)],
      [ADULT_MEMBER_HOSTING_FILE, strToU8(hostingCsv)],
    ]),
    manifest: {} as never,
    mode: "merge",
    resolutions: new Map(),
    actorMemberId: "admin-1",
    imageRemap: new Map(),
    notes: { doorCodesWritten: [] },
  } as ApplyContext;
}

function txDouble(hosting: unknown[] = [clubPolicy, lodgePolicy]) {
  const create = vi.fn().mockResolvedValue({ id: "created" });
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  return {
    create,
    updateMany,
    deleteMany,
    tx: {
      lodge: { findMany: vi.fn().mockResolvedValue([lodge]) },
      minimumStayPolicy: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      adultMemberHostingPolicy: {
        findMany: vi.fn().mockResolvedValue(hosting),
        create,
        updateMany,
        deleteMany,
      },
    } as unknown as TxDb,
  };
}

describe("adult-member hosting configuration transfer (#2364)", () => {
  it("exports an id-free, version-free file keyed on scope", async () => {
    const entries = await bookingPoliciesExporter.export({
      db: db(),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext);
    const entry = entries.find((e) => e.path === ADULT_MEMBER_HOSTING_FILE)!;
    const parsed = parseCsv(strFromU8(entry.bytes));
    expect(parsed.headers).toEqual(["scope", "mode", "capacityMode"]);
    expect(parsed.headers).not.toContain("id");
    expect(parsed.headers).not.toContain("version");
    expect(parsed.rows).toEqual([
      { scope: "club-wide", mode: "ADMIN_REVIEW_REQUIRED", capacityMode: "HOLD" },
      { scope: "lodge:tukino", mode: "INHERIT", capacityMode: "NO_HOLD" },
    ]);
  });

  it("emits the header for an empty set, so absence still means 'not carried'", async () => {
    const entries = await bookingPoliciesExporter.export({
      db: db([]),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext);
    const entry = entries.find((e) => e.path === ADULT_MEMBER_HOSTING_FILE)!;
    expect(entry.rowCount).toBe(0);
    expect(strFromU8(entry.bytes)).toBe(HEADER);
  });

  it("round-trips export -> plan as entirely unchanged", async () => {
    const entries = await bookingPoliciesExporter.export({
      db: db(),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext);
    const entry = entries.find((e) => e.path === ADULT_MEMBER_HOSTING_FILE)!;
    const plan = await bookingPoliciesImporter.plan(
      planContext(strFromU8(entry.bytes)),
    );
    expect(plan.errors).toEqual([]);
    const hosting = plan.items.filter(
      (item) => item.entity === "adult-member-hosting-policy",
    );
    expect(hosting).toHaveLength(2);
    expect(hosting.every((item) => item.action === "unchanged")).toBe(true);
  });

  it("plans a create, an update and a delete against a divergent target", async () => {
    const plan = await bookingPoliciesImporter.plan(
      planContext(
        `${HEADER}club-wide,DISABLED,NO_HOLD\n`,
        db([clubPolicy, lodgePolicy]),
      ),
    );
    expect(plan.errors).toEqual([]);
    const hosting = plan.items.filter(
      (item) => item.entity === "adult-member-hosting-policy",
    );
    expect(hosting).toEqual([
      {
        entity: "adult-member-hosting-policy",
        key: "club-wide",
        action: "update",
        changedFields: expect.arrayContaining(["mode", "capacityMode"]),
      },
      {
        entity: "adult-member-hosting-policy",
        key: "lodge:tukino",
        action: "delete",
      },
    ]);
  });

  it("shows a header-only file as a complete clear, never as a silent no-op", async () => {
    const plan = await bookingPoliciesImporter.plan(planContext(HEADER));
    const hosting = plan.items.filter(
      (item) => item.entity === "adult-member-hosting-policy",
    );
    expect(hosting.map((item) => item.action)).toEqual(["delete", "delete"]);
  });

  it("refuses the whole category when the hosting file is missing", async () => {
    const ctx = planContext(HEADER);
    ctx.files.delete(ADULT_MEMBER_HOSTING_FILE);
    const plan = await bookingPoliciesImporter.plan(ctx);
    expect(plan.errors.join(" ")).toMatch(/adult-member-hosting\.csv is required/);
    expect(plan.items).toEqual([]);
  });

  it("refuses an unknown lodge slug, a club-wide INHERIT and a duplicate scope", async () => {
    for (const [csv, pattern] of [
      [`${HEADER}lodge:nowhere,DISABLED,HOLD\n`, /does not exist/],
      [`${HEADER}club-wide,INHERIT,HOLD\n`, /cannot inherit/],
      [`${HEADER}club-wide,DISABLED,HOLD\nclub-wide,DISABLED,NO_HOLD\n`, /duplicate row/],
      [`${HEADER}club-wide,SOMETHING,HOLD\n`, /mode/],
      [`${HEADER}club-wide,DISABLED,MAYBE\n`, /capacityMode/],
    ] as Array<[string, RegExp]>) {
      const plan = await bookingPoliciesImporter.plan(planContext(csv));
      expect(plan.errors.join(" ")).toMatch(pattern);
      // A replace-set may only classify deletions once the whole incoming set
      // is valid, or a malformed file reads as an intentional clear.
      expect(
        plan.items.filter((i) => i.entity === "adult-member-hosting-policy"),
      ).toEqual([]);
    }
  });

  it("applies with version-guarded updates, creates and deletes", async () => {
    const { tx, create, updateMany, deleteMany } = txDouble();
    const result = await bookingPoliciesImporter.apply(
      applyContext(
        `${HEADER}club-wide,DISABLED,NO_HOLD\nlodge:tukino,ADMIN_REVIEW_REQUIRED,HOLD\n`,
        tx,
      ),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "hosting-club", version: 2 },
      data: { mode: "DISABLED", capacityMode: "NO_HOLD", version: 3 },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "hosting-lodge", version: 1 },
      data: { mode: "ADMIN_REVIEW_REQUIRED", capacityMode: "HOLD", version: 2 },
    });
    expect(create).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(result.updated).toBe(2);
  });

  it("creates a row with the scope key the CHECK constraint demands", async () => {
    const { tx, create } = txDouble([]);
    await bookingPoliciesImporter.apply(
      applyContext(`${HEADER}lodge:tukino,DISABLED,HOLD\n`, tx),
    );
    expect(create).toHaveBeenCalledWith({
      data: {
        scopeKey: lodge.id,
        lodgeId: lodge.id,
        version: 1,
        mode: "DISABLED",
        capacityMode: "HOLD",
      },
      select: { id: true },
    });
  });

  it("aborts the whole import when a row moved under the apply", async () => {
    const { tx } = txDouble();
    (
      tx.adultMemberHostingPolicy.updateMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ count: 0 });
    await expect(
      bookingPoliciesImporter.apply(
        applyContext(`${HEADER}club-wide,DISABLED,NO_HOLD\n`, tx),
      ),
    ).rejects.toThrow(/changed during import/);
  });
});
