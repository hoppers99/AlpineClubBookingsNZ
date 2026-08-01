import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  isCodeBearing,
  validateChangelogFragment,
} from "./check-pr-changelog-fragment.mjs";
import { parseNameStatus } from "./pr-body.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Shorthand: turn `"A src/lib/x.ts"` pairs into diff records. */
function changes(...pairs) {
  return pairs.map((pair) => {
    const [status, path] = pair.split(" ");
    return { status, path };
  });
}

const SOURCE_CHANGE = changes("M src/lib/booking-cancel.ts");
const EMPTY_BODY = "## Summary\n\n- something\n";

describe("PR changelog fragment gate", () => {
  it("passes a docs-only PR with no fragment and no marker", () => {
    expect(
      validateChangelogFragment(EMPTY_BODY, changes("M docs/ARCHITECTURE.md", "M README.md"))
        .outcome,
    ).toBe("not-code-bearing");
  });

  it("passes a test-only PR even though the paths sit under src/", () => {
    expect(
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M src/lib/__tests__/booking-cancel.test.ts", "A src/lib/x.spec.ts"),
      ).outcome,
    ).toBe("not-code-bearing");
  });

  it("passes a workflow-only PR", () => {
    expect(
      validateChangelogFragment(EMPTY_BODY, changes("M .github/workflows/ci.yml")).outcome,
    ).toBe("not-code-bearing");
  });

  it("passes a code-bearing PR that adds a fragment", () => {
    expect(
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M src/lib/booking-cancel.ts", "A changelog.d/2448-tolerant-reads.md"),
      ).outcome,
    ).toBe("fragment-added");
  });

  it("passes a code-bearing PR whose body carries the no-entry marker", () => {
    for (const marker of [
      "changelog: none",
      "- changelog: none — pure internal refactor.",
      "**Changelog: none** (no user-visible behaviour).",
      "> changelog:none",
    ]) {
      expect(
        validateChangelogFragment(`## Summary\n\n${marker}\n`, SOURCE_CHANGE).outcome,
      ).toBe("none-marker");
    }
  });

  it("does not accept the marker words buried in ordinary prose", () => {
    expect(() =>
      validateChangelogFragment(
        "We talked about the changelog: none of the reviewers wanted one.\n",
        SOURCE_CHANGE,
      ),
    ).toThrow(/needs a changelog entry/);
  });

  // TRANSITION GRACE (#2452). Delete this test together with the
  // `legacy-changelog-edit` branch when the grace is tightened.
  it("accepts a direct CHANGELOG.md edit during the transition", () => {
    expect(
      validateChangelogFragment(EMPTY_BODY, changes("M src/lib/booking-cancel.ts", "M CHANGELOG.md"))
        .outcome,
    ).toBe("legacy-changelog-edit");
  });

  it("fails a code-bearing PR with no fragment, no marker and no CHANGELOG edit", () => {
    expect(() => validateChangelogFragment(EMPTY_BODY, SOURCE_CHANGE)).toThrow(
      /needs a changelog entry/,
    );
  });

  it("fails a schema or migration PR with no entry", () => {
    expect(() =>
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M prisma/schema.prisma", "A prisma/migrations/20260801_x/migration.sql"),
      ),
    ).toThrow(/needs a changelog entry/);
  });

  it("does not credit a PR that only deletes fragments", () => {
    expect(() =>
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M src/lib/booking-cancel.ts", "D changelog.d/2448-tolerant-reads.md"),
      ),
    ).toThrow(/needs a changelog entry/);
  });

  it("does not accept the convention README as a fragment", () => {
    expect(() =>
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M src/lib/booking-cancel.ts", "A changelog.d/README.md"),
      ),
    ).toThrow(/needs a changelog entry/);
  });

  it("treats a rename out of src/ as a source change", () => {
    const renamed = parseNameStatus("R100\tsrc/lib/old.ts\tsrc/lib/new.ts\n");
    expect(renamed).toEqual([
      { status: "D", path: "src/lib/old.ts" },
      { status: "A", path: "src/lib/new.ts" },
    ]);
    expect(() => validateChangelogFragment(EMPTY_BODY, renamed)).toThrow(
      /needs a changelog entry/,
    );
  });

  it("parses name-status output, ignoring blank lines", () => {
    expect(parseNameStatus("M\tsrc/a.ts\nA\tchangelog.d/1-x.md\n\nD\tsrc/b.ts\n")).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "A", path: "changelog.d/1-x.md" },
      { status: "D", path: "src/b.ts" },
    ]);
  });

  it("classifies code-bearing paths", () => {
    expect(isCodeBearing(["src/app/page.tsx"])).toBe(true);
    expect(isCodeBearing(["prisma/schema.prisma"])).toBe(true);
    expect(isCodeBearing(["docs/x.md", "scripts/ci/y.mjs", "e2e/z.spec.ts"])).toBe(false);
    expect(isCodeBearing(["src/lib/__tests__/a.test.ts"])).toBe(false);
  });

  // The marker must never be pre-filled into the template: a body that always
  // contains it would silently disable the gate for every PR.
  it("keeps the no-entry marker out of the pull request template", () => {
    const template = readFileSync(resolve(repoRoot, ".github/pull_request_template.md"), "utf8");
    expect(() => validateChangelogFragment(template, SOURCE_CHANGE)).toThrow(
      /needs a changelog entry/,
    );
  });
});
