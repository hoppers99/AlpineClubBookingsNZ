import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// #2283: every outbound Xero link must be built by the `src/lib/xero-links.ts`
// builders. A hand-rolled `https://go.xero.com/...` string cannot carry the
// organisation SHORT CODE, so on a Xero login with more than one organisation
// it lands the admin in whichever organisation their session last used —
// verified against live Xero by the owner (issue #2283). Twenty-one such links
// across ten admin components were migrated; this guard stops the drift from
// re-accumulating one "quick link" at a time.
//
// Scope (deliberate):
// - `src/` only. E2E specs, scripts and docs may mention Xero URLs freely.
// - `src/lib/xero-links.ts` is the ONE place allowed to spell the host out —
//   that is its job.
// - Test files (`__tests__` directories, `*.test.*` / `*.spec.*`) are
//   excluded: they assert the exact URLs the builders produce and stub
//   builder outputs in mocks, and a literal inside a test cannot mislink an
//   admin. Production fixtures do not get this pass — only test files do.
//
// The pattern is the full `https://go.xero.com` prefix rather than the bare
// host so prose comments that merely mention "the generic go.xero.com link"
// stay legal; an actual URL in a comment still fails, which errs on the loud
// side.

const FORBIDDEN = "https://go.xero.com";
const ALLOWED_FILES = new Set(["src/lib/xero-links.ts"]);
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mts|cts)$/;
const TEST_FILE = /\.(?:test|spec)\.[^./]+$/;

function collectSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      collectSourceFiles(full, out);
    } else if (
      SOURCE_EXTENSIONS.test(entry.name) &&
      !TEST_FILE.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("xero-links guard (#2283)", () => {
  it("keeps every go.xero.com URL inside src/lib/xero-links.ts", () => {
    const root = process.cwd();
    const offenders: string[] = [];

    for (const file of collectSourceFiles(join(root, "src"), [])) {
      const relPath = relative(root, file).replace(/\\/g, "/");
      if (ALLOWED_FILES.has(relPath)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (line.includes(FORBIDDEN)) {
          offenders.push(`${relPath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `Inline go.xero.com URL(s) found. Build Xero links with the builders in ` +
        `src/lib/xero-links.ts (buildXeroContactUrl / buildXeroInvoiceUrl / ` +
        `buildXeroCreditNoteUrl / buildXeroReportsUrl / buildXeroDashboardUrl), ` +
        `passing the organisation short code from useXeroOrgShortCode where the ` +
        `surface has one — a hand-rolled URL cannot target the club's ` +
        `organisation on a multi-org Xero login (#2283).\n\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // The guard is only as good as its file walk: if the walker silently
  // stopped finding the migrated components, the assertion above would pass
  // on an empty set forever. Pin one known consumer as a canary.
  it("actually walks the migrated components (walker canary)", () => {
    const root = process.cwd();
    const files = collectSourceFiles(join(root, "src"), []).map((file) =>
      relative(root, file).replace(/\\/g, "/"),
    );
    expect(files).toContain(
      "src/app/(admin)/admin/xero/_components/sync-results-panel.tsx",
    );
    expect(files).toContain("src/lib/xero-links.ts");
    // And the exclusions hold: no test files in the walked set.
    expect(files.some((file) => TEST_FILE.test(file))).toBe(false);
    expect(files.some((file) => file.includes("__tests__"))).toBe(false);
  });
});
