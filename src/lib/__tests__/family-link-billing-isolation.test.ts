import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * #2255 (D9), consequence 4: relaxing the family-link cap from two generations
 * to four must not widen who is BILLED or who is COVERED by anyone else's fee.
 *
 * The reason it does not is structural rather than incidental, and this test
 * pins the structure. Money-side coverage in this codebase is derived from
 * `FamilyGroup` / `FamilyGroupMember`, `Member.familyGroupId`,
 * `Member.billingFamilyGroupId`, `SeasonalMembershipAssignment` and the fee
 * schedules — never from `Member.parentMemberId` / `Member.secondaryParentId`.
 * A parent link records who is responsible for a member; it grants nothing.
 * So a chain of three or four generations produces exactly the same invoices,
 * charges, coverage rows and exemptions as the same members with no links at
 * all, because the billing code cannot see the links.
 *
 * That is a property worth a test rather than a comment, because it is one
 * `include: { dependents: … }` away from quietly ceasing to be true — and the
 * symptom would be a family silently under- or over-charged, which nobody
 * notices until a season's invoices go out.
 *
 * Deliberately a SOURCE contract, not a behavioural one. A behavioural test can
 * only show that the fixtures it happens to use are unaffected; this shows that
 * no billing module reads the columns at all, which is the actual claim.
 */

/**
 * Every module that decides who pays, how much, or who a fee covers. Adding a
 * new one here is cheap; leaving one out is the failure mode, so the list is
 * checked for existence too — a renamed file must be re-listed rather than
 * silently dropping out of the contract.
 */
const BILLING_AND_COVERAGE_MODULES = [
  "membership-subscription-billing.ts",
  "xero-subscription-invoices.ts",
  "xero-entrance-fee-invoices.ts",
  "admin-xero-entrance-fee.ts",
  "authoritative-fees.ts",
  "joining-fee.ts",
  "change-fee.ts",
  "manual-subscription-payment.ts",
  "member-subscription-defaults.ts",
  "member-subscription-eligibility.ts",
  "booking-member-guest-subscriptions.ts",
  "resolve-member-family.ts",
  "family-booking.ts",
  "seasonal-membership-assignments.ts",
  "xero-membership-sync.ts",
  "admin-payment-invoice-service.ts",
  "membership-cancellation-xero.ts",
  "member-credit.ts",
];

/**
 * Deliberately NOT in the list above: `member-family-service.ts`. It is the
 * member-facing "my family" READ view and it does render parent links — that is
 * its job. Showing a member who their parents are is not the same as letting a
 * parent link decide who pays, which is what this contract is about.
 */

/**
 * The parent-link columns, and the Prisma RELATION filters that read them from
 * the other end. The bare words "dependents" / "dependants" are NOT matched:
 * `xero-entrance-fee-invoices.ts` uses `dependents` as a local for
 * family-group members in a child age tier, which is a different thing
 * entirely — it is derived from `FamilyGroupMember` and `ageTier`, exactly the
 * inputs coverage is allowed to use.
 */
const PARENT_LINK_READS = [
  /\bparentMemberId\b/,
  /\bsecondaryParentId\b/,
  // `dependents:` with no `{` requirement. `include: { dependents: true }`,
  // `select: { dependents: true }` and `_count: { select: { dependents: true } }`
  // are all reads of the relation, and the narrower `dependents\s*:\s*\{` form
  // matched none of them — a billing module could have started reading the
  // parent graph in any of those three spellings without tripping this
  // contract. Verified safe against the one legitimate use of the word in this
  // area: xero-entrance-fee-invoices writes `const dependents =`, never
  // `dependents:`.
  /\bdependents\s*:/,
  /\bsecondaryDependents\b/,
  /\bsecondaryParent\s*:/,
  // Consuming the family-link WALKS is the same thing one level up: a billing
  // module that imports the depth helpers is reading the parent graph even if
  // it never names a column.
  /member-family-link-depth/,
];

function readModule(fileName: string) {
  return readFileSync(
    resolve(process.cwd(), "src", "lib", fileName),
    "utf8",
  );
}

describe("family links do not reach the billing or coverage code (#2255)", () => {
  for (const fileName of BILLING_AND_COVERAGE_MODULES) {
    it(`${fileName} never reads a parent link`, () => {
      const source = readModule(fileName);
      // Existence check: `readFileSync` throws on a rename, which is the point.
      expect(source.length).toBeGreaterThan(0);

      const hits = PARENT_LINK_READS.filter((pattern) => pattern.test(source));
      expect({ fileName, hits: hits.map(String) }).toEqual({
        fileName,
        hits: [],
      });
    });
  }

  it("EVERY pattern it searches for would actually fire", () => {
    // Mutation guard. Without it the whole suite passes when a pattern is
    // subtly wrong — a stray anchor, a typo'd column name, a `{` the real call
    // sites do not have — and every file reports zero hits for the best
    // possible reason and the worst one alike.
    //
    // `.every`, not `.some`: one live pattern used to vouch for all of them,
    // which is exactly the "guard satisfied by an unrelated block" shape this
    // repo has shipped before.
    //
    // Each pattern is fired against a snippet written to be the thing it is
    // meant to catch, rather than against a file that happens to contain it —
    // a file-content check passes or fails for reasons that have nothing to do
    // with the pattern (someone rewording a comment would "break" it).
    const SAMPLES: Array<[RegExp, string]> = [
      [PARENT_LINK_READS[0], "where: { parentMemberId: memberId }"],
      [PARENT_LINK_READS[1], "where: { secondaryParentId: memberId }"],
      [PARENT_LINK_READS[2], "include: { dependents: true }"],
      [PARENT_LINK_READS[3], "select: { secondaryDependents: { select: { id: true } } }"],
      [PARENT_LINK_READS[4], "where: { secondaryParent: { is: { id: x } } }"],
      [
        PARENT_LINK_READS[5],
        'import { describeChildSideDepth } from "@/lib/member-family-link-depth";',
      ],
    ];
    // Nothing may be added to the pattern list without a sample proving it works.
    expect(SAMPLES).toHaveLength(PARENT_LINK_READS.length);

    for (const [pattern, sample] of SAMPLES) {
      expect({ pattern: String(pattern), fires: pattern.test(sample) }).toEqual({
        pattern: String(pattern),
        fires: true,
      });
    }
  });

  it("matches the relation-read spellings a select or include would use", () => {
    // The forms the narrower `dependents\s*:\s*\{` pattern silently missed.
    const dependentsPattern = PARENT_LINK_READS[2];
    for (const snippet of [
      "include: { dependents: true }",
      "select: { dependents: true, id: true }",
      "_count: { select: { dependents: true } }",
      "dependents: { some: {} }",
    ]) {
      expect({ snippet, matched: dependentsPattern.test(snippet) }).toEqual({
        snippet,
        matched: true,
      });
    }
    // And the local-variable use it must NOT match — which is why the bare word
    // "dependents" is not the pattern.
    expect(
      dependentsPattern.test("const dependents = groupMembers.filter("),
    ).toBe(false);
  });

  it("names the inputs coverage IS allowed to use, so the boundary is explicit", () => {
    // Not an assertion about a specific implementation: it records that the
    // billing side has a family model of its own, and that #2255 changed the
    // OTHER one. If this ever fails because a module stopped using family
    // groups, the two models have started to merge and the isolation above is
    // no longer the whole story.
    const billing = readModule("membership-subscription-billing.ts");
    expect(billing).toMatch(/familyGroup/i);
  });
});
