import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../quality-report";
import {
  BASELINE_PATH,
  evaluateRatchet,
  scanRepository,
} from "../lib/file-size-budget";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function captureReport(): string {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  try {
    main();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("quality report", () => {
  it("reports the same over-budget population the blocking gate enforces", () => {
    const report = captureReport();
    const committed = readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const scan = scanRepository(REPO_ROOT);
    const expected = evaluateRatchet(scan.productionStats, committed, scan.unclassified);

    // The report and `npm run quality:budget` share one classifier and one
    // baseline reader on purpose (#2687): an advisory report that disagreed
    // with the gate is how the old nine-entry allow-list came to understate the
    // real population by a factor of thirty.
    expect(report).toMatch(
      new RegExp(`\\| Files over budget \\(all categories\\)\\s*\\| ${expected.oversizedFiles}\\s*\\|`),
    );
    expect(report).toMatch(
      new RegExp(`\\| Ratchet findings\\s*\\| ${expected.findings.length}\\s*\\|`),
    );
    expect(report).toContain("## File-size budget ratchet");
    expect(report).toContain(BASELINE_PATH);
  });

  it("no longer offers an accepted-hotspot allow-list as the thing that decides", () => {
    const source = readFileSync(path.join(REPO_ROOT, "scripts", "quality-report.ts"), "utf8");
    expect(source).not.toMatch(/KNOWN_OVERSIZED_PRODUCTION_FILES|allow-?list/i);
  });
});
