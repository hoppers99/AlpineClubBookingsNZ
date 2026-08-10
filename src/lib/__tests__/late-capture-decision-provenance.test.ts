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
 * 2. **The true attribution is actually stated** where a reader lands: the
 *    authority line under `INV-ADDPAY-039`, the index row in
 *    `docs/DOMAIN_INVARIANTS.md`, and the shared epilogue's module docblock. A
 *    silent strip would satisfy (1) while leaving the next reader to assume the
 *    same thing, so both halves are required.
 * 3. **The TRUE #2760 / #2761 citation is still there.** Deleting a real owner
 *    decision to make a scan pass is the same failure pointing the other way, and
 *    it is the obvious wrong way to fix a failure of (1).
 *
 * MUTATION PROOF. Restore any "owner decision 11 Aug 2026" clause and (1) fails
 * naming the file and the sentence. Delete the authority line, the index row's
 * attribution, or the module docblock and (2) fails. Strip the real 10 Aug
 * citation and (3) fails.
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
  // The date the fabricated clause carried. No owner decision bears it, so it has no
  // legitimate use in these files at all — not even inside a warning about itself,
  // which is why the authority line describes the incident rather than quoting it.
  /11\s+Aug\s+2026/i,
  /owner\s+decisions?\s+(?:10\s+and\s+)?11\b/i,
  // The claims, independent of any date, because re-dating the same sentence is the
  // obvious way round a date-only guard. Each of these is a sentence this branch
  // actually shipped.
  /OWNER\s+DECIDED\s+TO\s+KEEP/i,
  /owner\s+(?:chose|decided)\s+to\s+keep/i,
  /owner\s+settled\s+the\s+carve/i,
  /decided\s+by\s+the\s+owner/i,
  // And the citation form, in both word orders, scoped to these two issues so the
  // real #2750 / #2760 / #2761 citations in the same paragraphs are untouched.
  /#277[34][^.\n]{0,60}owner\s+decision/i,
  /owner\s+decision[^.\n]{0,60}#277[34]/i,
  /#277[34]\s+settled\b/i,
];

/**
 * The one true citation these files must KEEP. `INV-ADDPAY-037` credits the owner's
 * real 10 Aug 2026 decision on #2760, and the fastest wrong way to satisfy the scan
 * above is to delete every "owner decision" in sight. Asserting the true one stays
 * makes that fix fail instead of passing quietly.
 */
const TRUE_OWNER_CITATION = /#2760\s+—\s+owner\s+decision\s+10\s+Aug\s+2026/;

describe("#2773 / #2774 decision provenance", () => {
  it("no source or document claims an owner decision for #2773 or #2774", () => {
    // A Set, because several patterns deliberately overlap on the sentences this
    // branch actually shipped — reporting one line three times reads as three
    // defects.
    const offenders = new Set<string>();
    for (const relativePath of PROVENANCE_SCANNED_FILES) {
      read(relativePath)
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (SETTLED_DECISION_CLAIMS.some((claim) => claim.test(line))) {
            offenders.add(`${relativePath}:${index + 1} ${line.trim()}`);
          }
        });
    }
    // Named rather than counted, so a failure says which file and which sentence.
    expect([...offenders]).toEqual([]);
  });

  it("INV-ADDPAY-039 carries the authority line, naming the orchestrator", () => {
    const invariants = read("docs/invariants/additional-payment-chasing.md");
    const section = invariants.slice(invariants.indexOf("### INV-ADDPAY-039"));
    expect(section).toContain(
      "WHO DECIDED THIS — THE ORCHESTRATOR, NOT THE OWNER",
    );
    // The three facts every other site is allowed to compress into a clause, so the
    // one place holding the full statement must actually hold all three.
    expect(section).toMatch(/\*\*The owner has not ruled on #2773\s*\n?>?\s*or #2774\.\*\*/);
    expect(section).toMatch(/Recommended\*\* option/);
    expect(section).toMatch(/reversible/i);
  });

  it("keeps the real #2760 owner citation it sits next to", () => {
    expect(read("docs/invariants/additional-payment-chasing.md")).toMatch(
      TRUE_OWNER_CITATION,
    );
  });

  it("the invariant index row for INV-ADDPAY-039 names the orchestrator too", () => {
    // The index is mandatory reading and is where an agent in a hurry stops, so the
    // one-line row has to carry the attribution rather than only the detail page.
    const row = read("docs/DOMAIN_INVARIANTS.md")
      .split(/\r?\n/)
      .find((line) => line.includes("| `INV-ADDPAY-039` |"));
    expect(row).toBeDefined();
    expect(row).toContain("orchestrator decision");
    expect(row).toContain("owner has not ruled");
  });

  it("the shared epilogue's docblock states the provenance where an implementor reads it", () => {
    const epilogue = read("src/lib/cancelled-booking-late-capture.ts");
    expect(epilogue).toContain("WHO DECIDED THIS: THE ORCHESTRATOR");
    expect(epilogue).toMatch(/owner has NOT ruled/);
  });
});
