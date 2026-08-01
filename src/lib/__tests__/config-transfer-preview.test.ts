import { describe, expect, it } from "vitest";

import {
  formatConfigImportTotals,
  visibleImportPlanItems,
} from "@/lib/config-transfer/preview";

describe("config-transfer destructive preview disclosure (#2363)", () => {
  it("includes deleted totals in interactive and bootstrap-ready summaries", () => {
    expect(formatConfigImportTotals({
      created: 1,
      updated: 2,
      deleted: 3,
      unchanged: 4,
    })).toBe("1 created, 2 updated, 3 deleted, 4 unchanged");
  });
  it("shows every delete even when changed rows exceed the nominal cap", () => {
    const deletes = Array.from({ length: 80 }, (_, index) => ({
      action: "delete" as const,
      key: `delete-${index}`,
    }));
    const unchanged = Array.from({ length: 12 }, (_, index) => ({
      action: "unchanged" as const,
      key: `same-${index}`,
    }));
    const preview = visibleImportPlanItems([...unchanged, ...deletes]);

    expect(preview.shown.filter((item) => item.action === "delete")).toEqual(
      deletes,
    );
    expect(preview.shown).toHaveLength(80);
    expect(preview.hiddenUnchanged).toBe(12);
  });

  it("uses remaining capacity only for unchanged rows", () => {
    const updates = Array.from({ length: 10 }, (_, index) => ({
      action: "update" as const,
      key: `update-${index}`,
    }));
    const unchanged = Array.from({ length: 100 }, (_, index) => ({
      action: "unchanged" as const,
      key: `same-${index}`,
    }));
    const preview = visibleImportPlanItems([...unchanged, ...updates]);

    expect(preview.shown.slice(0, 10)).toEqual(updates);
    expect(preview.shown).toHaveLength(50);
    expect(preview.hiddenUnchanged).toBe(60);
  });
});
