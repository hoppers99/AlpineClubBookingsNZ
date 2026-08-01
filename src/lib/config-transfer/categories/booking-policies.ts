import { strFromU8, strToU8 } from "fflate";
import type { PolicyExceptionCapacityMode } from "@prisma/client";

import type { BundleEntry } from "../bundle";
import { parseCsv, serialiseCsv } from "../csv";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  changedFields,
  hashRow,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
  type ReadDb,
} from "../import-types";
import { registerEntity } from "../registry";
import {
  folderLodgeSlug,
  lodgeFolderSegments,
} from "./lodge-config";
import { asStr, RowValidator, type Valid } from "../values";

// Unlike the other upsert-only config-transfer entities, minimum-stay policy is
// a complete replace-set. A header-only file intentionally clears the set, and
// every target row omitted from the file is shown as DELETE in the dry-run.
// This dedicated exception is protected by the pre-apply backup, the global
// minimum-stay-policy-set advisory lock, the in-lock re-plan/fingerprint, and
// version-guarded mutations.

export const MINIMUM_STAY_POLICIES_FILE =
  "booking-policies/minimum-stay.csv";

const FIELDS = [
  "scope",
  "name",
  "startDate",
  "endDate",
  "triggerDays",
  "minimumNights",
  "capacityMode",
  "active",
] as const;

const DATA_FIELDS = [
  "startDate",
  "endDate",
  "triggerDays",
  "minimumNights",
  "capacityMode",
  "active",
] as const;

registerEntity({
  entity: "minimum-stay-policy",
  category: "booking-policies",
  // The database intentionally has no unique(scope, name) constraint. The
  // planner rejects bundle and destination ambiguity instead of guessing.
  tier: "key-weak",
  format: "csv",
  file: MINIMUM_STAY_POLICIES_FILE,
  naturalKey: ["scope", "name"],
  singleton: false,
  fields: [...FIELDS],
});

type PolicyData = {
  startDate: Date;
  endDate: Date;
  triggerDays: number[];
  minimumNights: number;
  capacityMode: PolicyExceptionCapacityMode;
  active: boolean;
};

type CurrentPolicy = PolicyData & {
  id: string;
  name: string;
  lodgeId: string | null;
  scope: "club-wide" | `lodge:${string}`;
  version: number;
};

type ParsedPolicy = {
  key: string;
  displayKey: string;
  scope: "club-wide" | `lodge:${string}`;
  lodgeSlug: string | null;
  name: string;
  data: PolicyData;
};

function naturalKey(scope: string, name: string): string {
  return `${scope}\u0000${name}`;
}

function lodgeScope(slug: string): `lodge:${string}` {
  return `lodge:${slug}`;
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function triggerDaysValue(value: unknown): Valid<number[]> {
  const source = String(value ?? "").trim();
  if (!/^\d(?:\|\d)*$/.test(source)) {
    return {
      ok: false,
      message: 'must contain unique weekdays 0 to 6 separated by "|" (for example 5|6)',
    };
  }
  const days = source.split("|").map(Number);
  if (days.some((day) => day < 0 || day > 6)) {
    return { ok: false, message: "must contain weekdays from 0 to 6 only" };
  }
  if (new Set(days).size !== days.length) {
    return { ok: false, message: "must not contain duplicate weekdays" };
  }
  return { ok: true, value: [...days].sort((a, b) => a - b) };
}

function bundledLodgeSlugs(ctx: PlanContext): Set<string> {
  if (!ctx.selectedCategories?.includes("lodge-config")) return new Set();
  return new Set(
    lodgeFolderSegments(ctx.files)
      .map((segment) => folderLodgeSlug(ctx.files, segment))
      .filter((slug): slug is string => slug !== null),
  );
}

async function loadCurrent(db: ReadDb): Promise<{
  byKey: Map<string, CurrentPolicy>;
  lodgeIdBySlug: Map<string, string>;
  lodgeSlugById: Map<string, string>;
  errors: string[];
}> {
  const [lodges, policies] = await Promise.all([
    db.lodge.findMany({ select: { id: true, slug: true } }),
    db.minimumStayPolicy.findMany({
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        triggerDays: true,
        minimumNights: true,
        capacityMode: true,
        active: true,
        lodgeId: true,
        version: true,
      },
    }),
  ]);
  const lodgeIdBySlug = new Map(lodges.map((lodge) => [lodge.slug, lodge.id]));
  const lodgeSlugById = new Map(lodges.map((lodge) => [lodge.id, lodge.slug]));
  const byKey = new Map<string, CurrentPolicy>();
  const errors: string[] = [];
  for (const policy of policies) {
    const slug = policy.lodgeId
      ? lodgeSlugById.get(policy.lodgeId)
      : null;
    if (policy.lodgeId && !slug) {
      errors.push(
        `Target minimum-stay policy "${policy.name}" references missing lodge id ${policy.lodgeId}; repair the data before transfer.`,
      );
      continue;
    }
    const scope = slug ? lodgeScope(slug) : "club-wide";
    const key = naturalKey(scope, policy.name);
    if (byKey.has(key)) {
      errors.push(
        `Target has duplicate minimum-stay policies for ${scope} / ${policy.name}; resolve the ambiguity before transfer.`,
      );
      continue;
    }
    byKey.set(key, {
      ...policy,
      triggerDays: [...policy.triggerDays].sort((a, b) => a - b),
      scope,
    });
  }
  return { byKey, lodgeIdBySlug, lodgeSlugById, errors };
}

function parsePolicies(
  ctx: PlanContext | ApplyContext,
  knownLodgeSlugs: Set<string>,
  errors: string[],
): ParsedPolicy[] {
  const parsed: ParsedPolicy[] = [];
  const bytes = ctx.files.get(MINIMUM_STAY_POLICIES_FILE);
  if (!bytes) {
    errors.push(`${MINIMUM_STAY_POLICIES_FILE} is missing`);
    return parsed;
  }
  let rows: Record<string, string>[];
  try {
    const csv = parseCsv(strFromU8(bytes), { strictColumnCount: true });
    const exactHeader =
      csv.headers.length === FIELDS.length &&
      csv.headers.every((header, index) => header === FIELDS[index]);
    if (!exactHeader) {
      errors.push(
        `${MINIMUM_STAY_POLICIES_FILE}: header must be exactly ${FIELDS.join(",")}`,
      );
      return parsed;
    }
    rows = csv.rows;
  } catch (error) {
    errors.push(
      `${MINIMUM_STAY_POLICIES_FILE}: ${error instanceof Error ? error.message : "invalid CSV"}`,
    );
    return parsed;
  }

  const seen = new Set<string>();
  rows.forEach((raw, index) => {
    const v = new RowValidator(MINIMUM_STAY_POLICIES_FILE, index, errors);
    const scopeCell = v.required("scope", raw.scope);
    const name = asStr(raw.name);
    const startDate = v.date("startDate", raw.startDate);
    const endDate = v.date("endDate", raw.endDate);
    const triggerDays = v.custom(
      "triggerDays",
      triggerDaysValue(raw.triggerDays),
      [],
    );
    const minimumNights = v.int("minimumNights", raw.minimumNights);
    const capacityMode = v.enum(
      "capacityMode",
      "PolicyExceptionCapacityMode",
      raw.capacityMode,
    );
    const active = v.bool("active", raw.active);
    let rowValid = v.ok;
    if (name.trim().length === 0) {
      errors.push(
        `${MINIMUM_STAY_POLICIES_FILE} row ${index + 2}: name — must not be blank`,
      );
      rowValid = false;
    }
    if (name.length > 200) {
      errors.push(
        `${MINIMUM_STAY_POLICIES_FILE} row ${index + 2}: name — must be at most 200 characters`,
      );
      rowValid = false;
    }
    let scope: ParsedPolicy["scope"] = "club-wide";
    let lodgeSlug: string | null = null;
    if (scopeCell === "club-wide") {
      scope = "club-wide";
    } else if (scopeCell.startsWith("lodge:") && scopeCell.length > 6) {
      lodgeSlug = scopeCell.slice(6);
      scope = lodgeScope(lodgeSlug);
    } else {
      errors.push(
        `${MINIMUM_STAY_POLICIES_FILE} row ${index + 2}: scope — expected "club-wide" or "lodge:<slug>"`,
      );
      rowValid = false;
    }
    if (lodgeSlug !== null && !knownLodgeSlugs.has(lodgeSlug)) {
      errors.push(
        `${MINIMUM_STAY_POLICIES_FILE} row ${index + 2}: scope — lodge slug "${lodgeSlug}" does not exist in the target or selected lodge-config bundle`,
      );
      rowValid = false;
    }
    if (endDate.getTime() <= startDate.getTime()) {
      errors.push(
        `${MINIMUM_STAY_POLICIES_FILE} row ${index + 2}: endDate — must be after startDate`,
      );
      rowValid = false;
    }
    if (minimumNights < 2) {
      errors.push(
        `${MINIMUM_STAY_POLICIES_FILE} row ${index + 2}: minimumNights — must be at least 2`,
      );
      rowValid = false;
    }
    const key = naturalKey(scope, name);
    if (seen.has(key)) {
      errors.push(
        `${MINIMUM_STAY_POLICIES_FILE}: duplicate policy for ${scope} / ${name}`,
      );
      rowValid = false;
    }
    seen.add(key);
    if (!rowValid) return;
    parsed.push({
      key,
      displayKey: `${scope} / ${name}`,
      scope,
      lodgeSlug,
      name,
      data: {
        startDate,
        endDate,
        triggerDays,
        minimumNights,
        capacityMode: capacityMode as PolicyExceptionCapacityMode,
        active,
      },
    });
  });
  return parsed.sort((a, b) => a.key.localeCompare(b.key));
}

export const bookingPoliciesExporter: CategoryExporter = {
  category: "booking-policies",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const current = await loadCurrent(ctx.db);
    if (current.errors.length > 0) throw new Error(current.errors[0]);
    const rows = [...current.byKey.values()]
      .sort((a, b) => naturalKey(a.scope, a.name).localeCompare(naturalKey(b.scope, b.name)))
      .map((policy) => ({
        scope: policy.scope,
        name: policy.name,
        startDate: toDateOnly(policy.startDate),
        endDate: toDateOnly(policy.endDate),
        triggerDays: [...policy.triggerDays].sort((a, b) => a - b).join("|"),
        minimumNights: policy.minimumNights,
        capacityMode: policy.capacityMode,
        active: policy.active,
      }));
    // Always emit the header, even for an empty set. Absence means "category
    // not carried"; a header-only file is the intentional destructive clear.
    return [{
      path: MINIMUM_STAY_POLICIES_FILE,
      category: "booking-policies",
      rowCount: rows.length,
      bytes: strToU8(serialiseCsv([...FIELDS], rows)),
    }];
  },
};

async function planBookingPolicies(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings = [
    "Booking policies are a complete replace-set: target policies omitted from this file will be deleted in both Merge and Overwrite modes.",
  ];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  if (!ctx.files.has(MINIMUM_STAY_POLICIES_FILE)) {
    errors.push(
      `${MINIMUM_STAY_POLICIES_FILE} is required when booking-policies is selected; use a header-only file to intentionally clear every policy.`,
    );
    return { items, warnings, errors, fingerprintParts };
  }

  const current = await loadCurrent(ctx.db);
  errors.push(...current.errors);
  const knownLodgeSlugs = new Set(current.lodgeIdBySlug.keys());
  for (const slug of bundledLodgeSlugs(ctx)) knownLodgeSlugs.add(slug);
  const parsed = parsePolicies(ctx, knownLodgeSlugs, errors);
  // A replace-set may classify deletions only after the ENTIRE incoming set is
  // structurally and semantically valid. Otherwise an empty/malformed file
  // could look like an intentional clear in the preview.
  if (errors.length > 0) {
    return { items, warnings, errors, fingerprintParts };
  }
  const parsedKeys = new Set(parsed.map((policy) => policy.key));

  for (const policy of [...current.byKey.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    fingerprintParts.push(
      `minimum-stay-policy:${policy.id}:${policy.version}:${hashRow([...DATA_FIELDS, "name", "lodgeId"], policy)}`,
    );
  }
  for (const policy of parsed) {
    const lodgeId = policy.lodgeSlug === null
      ? null
      : current.lodgeIdBySlug.get(policy.lodgeSlug) ?? null;
    fingerprintParts.push(
      `minimum-stay-policy-lodge:${policy.scope}:${lodgeId ?? "pending"}`,
    );
    const existing = current.byKey.get(policy.key) ?? null;
    const changed = changedFields(policy.data, existing);
    items.push({
      entity: "minimum-stay-policy",
      key: policy.displayKey,
      action: existing ? (changed.length ? "update" : "unchanged") : "create",
      changedFields: changed.length ? changed : undefined,
    });
  }
  for (const [key, existing] of current.byKey) {
    if (parsedKeys.has(key)) continue;
    items.push({
      entity: "minimum-stay-policy",
      key: `${existing.scope} / ${existing.name}`,
      action: "delete",
    });
  }
  items.sort((a, b) => a.key.localeCompare(b.key));
  return { items, warnings, errors, fingerprintParts };
}

async function applyBookingPolicies(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    skipped: 0,
  };
  if (!ctx.files.has(MINIMUM_STAY_POLICIES_FILE)) {
    throw new Error(`${MINIMUM_STAY_POLICIES_FILE} is required`);
  }
  const current = await loadCurrent(ctx.tx);
  if (current.errors.length > 0) throw new Error(current.errors[0]);
  const errors: string[] = [];
  const parsed = parsePolicies(ctx, new Set(current.lodgeIdBySlug.keys()), errors);
  if (errors.length > 0) throw new Error(errors[0]);
  const parsedKeys = new Set(parsed.map((policy) => policy.key));

  for (const policy of parsed) {
    const existing = current.byKey.get(policy.key) ?? null;
    const lodgeId = policy.lodgeSlug === null
      ? null
      : current.lodgeIdBySlug.get(policy.lodgeSlug);
    if (policy.lodgeSlug !== null && !lodgeId) {
      throw new Error(`Lodge ${policy.scope} was not created before booking policies`);
    }
    if (!existing) {
      await ctx.tx.minimumStayPolicy.create({
        data: { name: policy.name, lodgeId: lodgeId ?? null, version: 1, ...policy.data },
        select: { id: true },
      });
      result.created += 1;
      continue;
    }
    const changed = changedFields(policy.data, existing);
    if (changed.length === 0) {
      result.unchanged += 1;
      continue;
    }
    const updated = await ctx.tx.minimumStayPolicy.updateMany({
      where: { id: existing.id, version: existing.version },
      data: { ...policy.data, version: existing.version + 1 },
    });
    if (updated.count !== 1) {
      throw new Error(`Minimum-stay policy ${policy.displayKey} changed during import`);
    }
    result.updated += 1;
  }

  for (const [key, existing] of current.byKey) {
    if (parsedKeys.has(key)) continue;
    const deleted = await ctx.tx.minimumStayPolicy.deleteMany({
      where: { id: existing.id, version: existing.version },
    });
    if (deleted.count !== 1) {
      throw new Error(
        `Minimum-stay policy ${existing.scope} / ${existing.name} changed during import`,
      );
    }
    result.deleted += 1;
  }
  return result;
}

export const bookingPoliciesImporter: CategoryImporter = {
  category: "booking-policies",
  plan: planBookingPolicies,
  apply: applyBookingPolicies,
};
