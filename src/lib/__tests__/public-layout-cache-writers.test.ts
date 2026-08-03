import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("public layout cache writer invalidation", () => {
  it("invalidates modules and derived capacity after module writes", () => {
    const route = source("src/app/api/admin/modules/route.ts");
    expect(route).toContain("PUBLIC_LAYOUT_CACHE_TAGS.modules");
    // #2352 F3: the capacity tag now comes from revalidatePublicSite() itself,
    // which also clears the full-route ISR store — a module flag is rendered INTO
    // the public layout, so a tag-only clear left every stored page showing the
    // old switch position.
    expect(route).toContain("revalidatePublicSite(");
    expect(route.indexOf("revalidatePublicSite(")).toBeGreaterThan(
      route.indexOf("await write"),
    );
  });

  it("clears the stored public pages after lodge setting writes", () => {
    // #2352 slice-1 review: this used to assert `invalidatePublicLodgeCapacity()`,
    // a capacity-TAG clear. `{{lodge-capacity}}` is resolved from uncached reads, so
    // the stored CMS page carries no capacity tag and the tag clear expired nothing.
    const route = source("src/app/api/admin/lodge-settings/route.ts");
    expect(route).toContain("revalidatePublicSite();");
    expect(route.indexOf("revalidatePublicSite();")).toBeGreaterThan(
      route.indexOf("await updateLodgeSettings"),
    );
  });

  it("invalidates every imported public-layout config category", () => {
    const route = source("src/app/api/admin/config-transfer/apply/route.ts");
    for (const tag of ["modules", "theme", "capacity", "banners"]) {
      expect(route).toContain(`PUBLIC_LAYOUT_CACHE_TAGS.${tag}`);
    }
    expect(route.indexOf("invalidatePublicLayoutConfig(")).toBeGreaterThan(
      route.indexOf("await applyConfigImport"),
    );
    expect(route).toContain("await primeEmailPalette();");
    expect(route.indexOf("await primeEmailPalette();")).toBeGreaterThan(
      route.indexOf("await applyConfigImport"),
    );
  });
});
