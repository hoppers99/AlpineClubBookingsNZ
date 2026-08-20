import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #2926 — `HutLeaderAssignment.source` must be written once and never updated.
 *
 * The whole point of the column is that a membership edit cannot flip it. That
 * property is what lets the overlap carve-out key on the ROW's provenance rather
 * than on `Member.role`, which is derived from admin-writable access roles and
 * moves whenever somebody edits a member.
 *
 * But immutability was true by CONVENTION only: three writers stamp it at insert
 * and nothing updates it, and nothing said so. A fourth writer, or an `update`
 * that included `source`, would silently reopen exactly the hole the column was
 * added to close, and no other test in the tree would notice.
 *
 * This scans the source tree from disk, so it has no import edge to the files it
 * reads and `vitest related` cannot reach it — that is deliberate and matches the
 * other census tests here. It is CI-caught by design.
 */

const SRC = path.resolve(__dirname, "..", "..");

/** Every tracked .ts/.tsx file under src/, excluding tests. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

const FILES = sourceFiles(SRC);

/** Repo-relative, forward-slashed, so failure messages are copy-pasteable. */
function rel(file: string): string {
  return path.relative(path.resolve(SRC, ".."), file).split(path.sep).join("/");
}

describe("#2926 — HutLeaderAssignment.source is write-once", () => {
  it("is stamped by exactly the three known writers, and no others", () => {
    const EXPECTED = [
      // An officer deliberately assigning a leader.
      "src/app/api/admin/hut-leaders/route.ts",
      // The nightly sole-adult rule.
      "src/lib/cron-hut-leader-auto-assign.ts",
      // One row per teacher when a school request is approved.
      "src/lib/school-booking-request.ts",
    ].sort();

    const found = FILES.filter((file) =>
      readFileSync(file, "utf8").includes("source: HutLeaderAssignmentSource."),
    )
      .map(rel)
      .sort();

    expect(
      found,
      "a writer of HutLeaderAssignment.source was added or removed. If it is a " +
        "new legitimate insert, add it here with a comment saying what creates " +
        "the row. If it is an UPDATE, do not add it: the column is write-once, " +
        "and the overlap carve-out in findHutLeaderOverlapRefusal depends on it.",
    ).toEqual(EXPECTED);
  });

  it("is never included in a hutLeaderAssignment update", () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      let index = text.indexOf("hutLeaderAssignment.update");
      while (index !== -1) {
        // Read the call's argument object: from the call to the first balanced
        // close. A window is enough here and avoids a parser for one pattern.
        const window = text.slice(index, index + 600);
        if (/\bsource\s*:/.test(window)) offenders.push(`${rel(file)} :: update`);
        index = text.indexOf("hutLeaderAssignment.update", index + 1);
      }
    }

    expect(
      offenders,
      "an update writes HutLeaderAssignment.source. The column is write-once " +
        "BECAUSE the teacher carve-out keys on it: if an update can change it, " +
        "a row can be moved in or out of the overlap check after the fact, " +
        "which is the Member.role hole #2926 exists to avoid.",
    ).toEqual([]);
  });

  it("is not settable through updateMany either", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      let index = text.indexOf("hutLeaderAssignment.updateMany");
      while (index !== -1) {
        const window = text.slice(index, index + 600);
        if (/\bsource\s*:/.test(window)) offenders.push(`${rel(file)} :: updateMany`);
        index = text.indexOf("hutLeaderAssignment.updateMany", index + 1);
      }
    }
    expect(offenders).toEqual([]);
  });
});
