/**
 * EVERY AGE-TIER WRITER RE-RESOLVES EMAIL INHERITANCE (#2821).
 *
 * `isUsableEmailSource` requires `ageTier === "ADULT"`, so a write that moves a
 * member across that line decides whether they may still be somebody's contact
 * of record. #2716 wired that rule into ONE function,
 * `reconcileEmailInheritanceForMemberChange`, and its docblock claimed every
 * such write called it. Six did not. This file exists so the claim and the code
 * cannot drift again.
 *
 * IT IS A SOURCE CENSUS BECAUSE A BEHAVIOURAL TEST CANNOT BE ONE. A seventh
 * writer added next year with no reconcile call passes every existing test: the
 * tier is written, the response is right, the page renders. What is wrong is who
 * receives a dependant's mail afterwards, and only a test that reads the source
 * of every writer can see that a call is missing rather than a case untested.
 *
 * THE LIST IS DISCOVERED, NOT WRITTEN DOWN. #2716's review found the previous
 * hand-written enumeration wrong in six places, and #2811 found an audit census
 * that passed while its subject was deleted. A census whose membership is typed
 * out by hand tests the typist. This one reads the tree.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC_DIR = join(import.meta.dirname, "..", "..");

/** Every `.ts`/`.tsx` file under `src/`, tests and fixtures excluded. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      sourceFiles(full, found);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (statSync(full).isFile()) found.push(full);
  }
  return found;
}

/** Source with comments stripped, so a comment naming a call is not a call. */
function executableCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/**
 * A file that both DECIDES an enforced age tier and WRITES a member.
 *
 * Both halves are required, and the second is what keeps the census honest.
 * `age-tier-enforcement.ts` and `admin-members-service.ts` resolve a tier and
 * write nothing — one computes the rule, the other reads for a list — so
 * demanding a reconcile call from them would be demanding a call with nothing to
 * reconcile, and the next person would delete the assertion rather than the
 * confusion.
 */
function isAgeTierWriter(code: string): boolean {
  const resolves = code.includes("resolveEnforcedAgeTier(");
  const writes =
    /\.member\.update\(/.test(code) || /\.member\.updateMany\(/.test(code);
  return resolves && writes;
}

const RECONCILE_CALL = "reconcileEmailInheritanceForMemberChange(";

describe("every age-tier writer re-resolves email inheritance (#2821)", () => {
  const writers = sourceFiles(SRC_DIR)
    .map((path) => ({ path, code: executableCode(readFileSync(path, "utf8")) }))
    .filter((file) => isAgeTierWriter(file.code));

  it("found the writers, so the assertion below is not vacuous", () => {
    // The failure this guards is a census that quietly matches nothing — which
    // this repo has shipped before. If a rename makes `resolveEnforcedAgeTier`
    // undiscoverable, this fails loudly instead of passing silently.
    expect(writers.length).toBeGreaterThanOrEqual(5);
  });

  it("calls the reconciler in every one of them", () => {
    const missing = writers
      .filter((file) => !file.code.includes(RECONCILE_CALL))
      .map((file) => file.path.slice(SRC_DIR.length + 1).replace(/\\/g, "/"));

    expect(
      missing,
      `These files decide an enforced age tier AND write a member, but never call ` +
        `${RECONCILE_CALL}). An age tier decides whether a member may be anybody's ` +
        `contact of record (isUsableEmailSource requires ADULT), so a write that ` +
        `moves them across that line leaves their dependants pointing at somebody ` +
        `the rule no longer permits. Call it in the SAME transaction as the tier ` +
        `write — see docs/invariants/membership-lifecycle.md INV-LIFE-047.`,
    ).toEqual([]);
  });

  it("does not accept a bare import as the call", () => {
    // The exact way #2811's adoption census passed while its subject was
    // deleted: the symbol survived in the import line. Every writer must
    // INVOKE it, so the needle carries its opening parenthesis — and this
    // asserts that the needle really is call-shaped rather than a bare name.
    expect(RECONCILE_CALL.endsWith("(")).toBe(true);
    for (const file of writers) {
      const withoutImports = file.code
        .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];$/gm, "")
        .replace(/^import\s+["'][^"']+["'];$/gm, "");
      expect(
        withoutImports.includes(RECONCILE_CALL),
        `${file.path} imports the reconciler but never calls it`,
      ).toBe(true);
    }
  });
});
