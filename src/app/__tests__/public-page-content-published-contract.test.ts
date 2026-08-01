import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract for #2440: every public render path reads PageContent through
 * `getPublishedPageContentByPath()`, which hides unpublished (draft) rows. A
 * route that called the unfiltered `getSanitizedPageContentByPath()` directly
 * would serve an admin's draft to anonymous visitors — that is exactly how
 * /contact and /join regressed. This test bans the unfiltered read from
 * `src/app` outright, so a new route cannot reintroduce the gap; admin/API
 * surfaces that legitimately need drafts use `listEditablePageContent()` or
 * their own queries, not the by-path read.
 */

const APP_ROOT = path.join(__dirname, "..");

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...(await collectSourceFiles(full)));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name)
    ) {
      files.push(full);
    }
  }

  return files;
}

describe("public PageContent published contract (#2440)", () => {
  it("no route module under src/app uses the unfiltered by-path read", async () => {
    const files = await collectSourceFiles(APP_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      if (source.includes("getSanitizedPageContentByPath")) {
        offenders.push(path.relative(APP_ROOT, file));
      }
    }

    expect(offenders, [
      "These src/app modules read PageContent without the published filter.",
      "Use getPublishedPageContentByPath() from @/lib/page-content-html so",
      "draft pages are never served to the public (#2440):",
      ...offenders,
    ].join("\n")).toEqual([]);
  });
});
