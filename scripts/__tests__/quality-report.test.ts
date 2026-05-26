import { describe, expect, it } from "vitest";
import {
  findNewlyOversizedFiles,
  KNOWN_OVERSIZED_PRODUCTION_FILES,
  PRODUCTION_LIMIT,
  type FileStat,
} from "../quality-report";

describe("quality report accepted hotspot allow-list", () => {
  it("flags oversized production files unless they are allow-listed", () => {
    const stats: FileStat[] = [
      { file: "src/lib/xero-inbound-reconciliation.ts", lines: 3000 },
      { file: "src/lib/new-domain-module.ts", lines: PRODUCTION_LIMIT + 1 },
      { file: "src/app/api/example/route.ts", lines: 251 },
      { file: "src/app/(admin)/admin/example/page.tsx", lines: 501 },
      { file: "src/lib/small-module.ts", lines: PRODUCTION_LIMIT },
    ];

    const newlyOversized = findNewlyOversizedFiles(stats);

    expect(KNOWN_OVERSIZED_PRODUCTION_FILES.has("src/lib/xero-inbound-reconciliation.ts")).toBe(
      true,
    );
    const newlyOversizedFiles = newlyOversized.map((stat) => stat.file);
    expect(newlyOversizedFiles).toHaveLength(3);
    expect(newlyOversizedFiles).toEqual(
      expect.arrayContaining([
        "src/app/api/example/route.ts",
        "src/app/(admin)/admin/example/page.tsx",
        "src/lib/new-domain-module.ts",
      ]),
    );
    expect(newlyOversizedFiles).not.toContain("src/lib/xero-inbound-reconciliation.ts");
    expect(newlyOversizedFiles).not.toContain("src/lib/small-module.ts");
  });
});
