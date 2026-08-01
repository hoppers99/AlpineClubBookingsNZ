import type { CategoryApplyResult, PlanAction } from "./import-types";

export function formatConfigImportTotals(
  totals: Pick<
    CategoryApplyResult,
    "created" | "updated" | "deleted" | "unchanged"
  >,
): string {
  return `${totals.created} created, ${totals.updated} updated, ${totals.deleted} deleted, ${totals.unchanged} unchanged`;
}

/**
 * Cap only unchanged preview noise. Every create/update/delete remains visible,
 * even when mutations alone exceed the nominal row limit.
 */
export function visibleImportPlanItems<
  T extends { action: PlanAction },
>(items: T[], nominalLimit = 50): {
  shown: T[];
  hiddenUnchanged: number;
} {
  const changed = items.filter((item) => item.action !== "unchanged");
  const unchanged = items.filter((item) => item.action === "unchanged");
  const visibleUnchanged = unchanged.slice(
    0,
    Math.max(0, nominalLimit - changed.length),
  );
  return {
    shown: [...changed, ...visibleUnchanged],
    hiddenUnchanged: unchanged.length - visibleUnchanged.length,
  };
}
