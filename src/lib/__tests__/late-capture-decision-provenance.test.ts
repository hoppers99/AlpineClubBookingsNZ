import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #2773 / #2774 — the provenance guard.
 *
 * WHY A TEST AND NOT A REVIEW NOTE. Two independent review lenses found the same
 * defect on this branch: thirteen places in code and in **permanent invariant
 * documents** recorded the #2773 / #2774 directions as a settled "owner decision
 * 11 Aug 2026", while both issues carried `needs-decision`, zero comments, zero
 * ticked options and no assignee. That is not a wording nicety. `CLAUDE.md` makes
 * the issue thread the audit trail, `docs/DOMAIN_INVARIANTS.md` is mandatory
 * reading, and `INV-ADDPAY-039` **withholds a member's refund** — so a false
 * "owner decided" clause in it would tell every future agent that the semantics
 * are settled and must not be revisited. The attribution outlives the branch;
 * prose alone would let it come back on the next edit.
 *
 * WHAT IT PINS, in both directions:
 *
 * 1. **No source or document claims an owner decision for #2773 or #2774.** The
 *    scan is over the exact files that carried the false clause, so re-adding one
 *    fails here by name rather than in a reviewer's head.
 * 2. **The pending-decision provenance is actually stated** where a reader lands:
 *    the invariant file's own note, `INV-ADDPAY-039`'s rule text, the index row in
 *    `docs/DOMAIN_INVARIANTS.md`, and the shared epilogue's module docblock. A
 *    silent strip would satisfy (1) while leaving the next reader to assume the
 *    same thing, so both halves are required.
 *
 * MUTATION PROOF. Restore any "owner decision 11 Aug 2026" clause and (1) fails
 * naming the file. Delete the provenance paragraph from the invariant, the index
 * row's pending clause, or the module docblock and (2) fails.
 *
 * IT DOES NOT ASSERT THE DECISION IS ABSENT FOREVER. When the owner rules on #2773
 * and #2774 and the answer is on the issue threads, this test is what has to be
 * updated deliberately — pointing at the recorded comment — which is the intended
 * cost of claiming owner authority.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/**
 * Every file that carried the false clause, plus the surfaces most likely to grow
 * one next. Listed explicitly rather than globbed: a tree-wide scan would trip on
 * legitimate citations of the #2760 / #2761 decisions, which ARE on the record.
 */
const PROVENANCE_SCANNED_FILES = [
  "docs/invariants/additional-payment-chasing.md",
  "docs/DOMAIN_INVARIANTS.md",
  "docs/STATE_MACHINES.md",
  "docs/UX_FLOW_MAP.md",
  "docs/guides/payments.md",
  "docs/guides/notification-recipients.md",
  "docs/CONCURRENCY_AND_LOCKING.md",
  "scripts/audit/audit-writer-census-manifest.ts",
  "src/lib/cancelled-booking-late-capture.ts",
  "src/lib/deleted-booking-modification-payment.ts",
  "src/lib/stripe-webhook-service.ts",
  "src/lib/email-message-registry.ts",
  "src/lib/email-message-audit-defaults.ts",
  "src/lib/email-message-notes.ts",
  "src/lib/email/admin-alerts-finance.ts",
  "src/components/admin/manual-refund-task-queue.tsx",
  "changelog.d/2773-late-capture-both-paths-and-hand-back-fence.md",
] as const;

/**
 * The shapes an "it was decided" claim takes in this repository. Deliberately
 * matched on the CLAIM rather than on the date: back-dating or re-dating the same
 * sentence is the obvious way round a date-only guard.
 */
const SETTLED_DECISION_CLAIMS = [
  /owner\s+decisions?\s+11\s+Aug\s+2026/i,
  /owner\s+decided\s+to\s+keep/i,
  /the\s+owner\s+chose\s+to\s+keep/i,
  /owner\s+settled\s+the\s+carve/i,
  /#2773[^.\n]{0,40}owner\s+decision/i,
  /#2774[^.\n]{0,40}owner\s+decision(?!\s*(?:\.|,|;|—|-)?\s*(?:pending|and))/i,
];

describe("#2773 / #2774 decision provenance", () => {
  it("no source or document claims a settled owner decision for #2773 or #2774", () => {
    const offenders: string[] = [];
    for (const relativePath of PROVENANCE_SCANNED_FILES) {
      const contents = read(relativePath);
      contents.split(/\r?\n/).forEach((line, index) => {
        for (const claim of SETTLED_DECISION_CLAIMS) {
          if (claim.test(line)) {
            offenders.push(`${relativePath}:${index + 1} ${line.trim()}`);
          }
        }
      });
    }
    // Named rather than counted, so a failure says which file and which sentence.
    expect(offenders).toEqual([]);
  });

  it("the invariant file states that the #2773 / #2774 extensions are pending the owner's decision", () => {
    const invariants = read("docs/invariants/additional-payment-chasing.md");
    expect(invariants).toContain("PROVENANCE OF THE #2773 / #2774 EXTENSIONS");
    // The two words that keep a future reader from citing it as settled.
    expect(invariants).toMatch(/PENDING the owner's decision/);
    expect(invariants).toContain("Do not read any of it as owner-settled");
  });

  it("INV-ADDPAY-039 says in its own rule text that it is not owner-settled", () => {
    const invariants = read("docs/invariants/additional-payment-chasing.md");
    const section = invariants.slice(invariants.indexOf("### INV-ADDPAY-039"));
    expect(section).toContain("**This rule is not owner-settled.**");
    expect(section).toMatch(/recommended default and PENDING the\s+owner's decision/);
  });

  it("the invariant index row for INV-ADDPAY-039 carries the pending clause", () => {
    const index = read("docs/DOMAIN_INVARIANTS.md");
    const row = index
      .split(/\r?\n/)
      .find((line) => line.includes("| `INV-ADDPAY-039` |"));
    expect(row).toBeDefined();
    expect(row).toContain("PENDING the owner's decision");
  });

  it("the shared epilogue's docblock states the provenance where an implementor reads it", () => {
    const epilogue = read("src/lib/cancelled-booking-late-capture.ts");
    expect(epilogue).toContain("PROVENANCE, STATED HONESTLY");
    expect(epilogue).toMatch(/PENDING THE OWNER'S DECISION/);
  });
});
