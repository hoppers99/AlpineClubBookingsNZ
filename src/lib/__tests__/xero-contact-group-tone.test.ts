import { describe, expect, it } from "vitest";
import { getXeroContactGroupTone } from "@/lib/xero-contact-group-tone";

describe("getXeroContactGroupTone", () => {
  const catalog = Array.from({ length: 8 }, (_, index) => ({
    id: `group-${index + 1}`,
  }));

  it("uses complete catalog order and wraps intentionally after cat6", () => {
    expect(catalog.map((group) => getXeroContactGroupTone(group.id, catalog))).toEqual([
      "cat1",
      "cat2",
      "cat3",
      "cat4",
      "cat5",
      "cat6",
      "cat1",
      "cat2",
    ]);
  });

  it("does not change a tone when a row subset or row order changes", () => {
    const rowSubset = [catalog[5], catalog[1]].reverse();
    expect(getXeroContactGroupTone(rowSubset[0].id, catalog)).toBe("cat2");
    expect(getXeroContactGroupTone(rowSubset[1].id, catalog)).toBe("cat6");
  });

  it("falls back deterministically to stable group identity without a catalog", () => {
    const first = getXeroContactGroupTone("retired-xero-group-id");
    expect(getXeroContactGroupTone("retired-xero-group-id", [])).toBe(first);
    expect(first).toMatch(/^cat[1-6]$/);
  });
});
