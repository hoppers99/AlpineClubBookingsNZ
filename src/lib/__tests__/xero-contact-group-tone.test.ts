import { describe, expect, it } from "vitest";
import { getXeroContactGroupTone } from "@/lib/xero-contact-group-tone";

describe("getXeroContactGroupTone", () => {
  const catalog = Array.from({ length: 8 }, (_, index) => ({
    id: `group-${index + 1}`,
  }));

  it("derives every tone from stable group identity", () => {
    expect(catalog.map((group) => getXeroContactGroupTone(group.id))).toEqual([
      "cat5",
      "cat6",
      "cat1",
      "cat6",
      "cat1",
      "cat2",
      "cat3",
      "cat2",
    ]);
    expect(getXeroContactGroupTone("retired-xero-group-id")).toBe("cat4");
  });

  it("ignores catalog presence and order at the JavaScript call boundary", () => {
    // Extra arguments model the old Members/Subscriptions callers. The shared
    // helper deliberately has no catalog parameter, so even legacy-shaped
    // calls cannot reintroduce catalog-versus-fallback drift.
    const legacyShapedCall = getXeroContactGroupTone as unknown as (
      groupId: string,
      catalog: readonly { id: string }[],
    ) => ReturnType<typeof getXeroContactGroupTone>;
    const groupId = "group-1";

    expect(legacyShapedCall(groupId, catalog)).toBe(
      getXeroContactGroupTone(groupId),
    );
    expect(legacyShapedCall(groupId, [...catalog].reverse())).toBe(
      getXeroContactGroupTone(groupId),
    );
    expect(
      legacyShapedCall(groupId, catalog.filter((group) => group.id === groupId)),
    ).toBe(getXeroContactGroupTone(groupId));
  });
});
