import { validateConcurrencyDeclaration } from "./check-pr-concurrency-declaration.mjs";

const heading = "## Concurrency And Lock Impact";
const complete = `${heading}

- Writer class(es), canonical lock key(s), and acquisition order: cancel; global -> lodge
- Immutable pre-lock key source and mutable under-lock re-read: immutable lodgeId; full re-read
- Status-guarded claim and proof that a lost claim runs no side effect: updateMany; count=0 exits
- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: #1911 uses the same lodge helper; race test passes
- Provider calls inside a transaction (write \`None\`, or justify the bounded exception from \`docs/CONCURRENCY_AND_LOCKING.md\`): None

## Residual Risks
`;

describe("PR concurrency declaration gate", () => {
  it("accepts a complete declaration with numbered compatibility evidence", () => {
    expect(() => validateConcurrencyDeclaration(complete)).not.toThrow();
  });

  it("accepts an explicitly checked N/A declaration", () => {
    expect(() =>
      validateConcurrencyDeclaration(`${heading}\n\n- [x] N/A — docs-only change.\n`, [
        "docs/agents/CODEX_WORKFLOW.md",
      ]),
    ).not.toThrow();
  });

  it("rejects N/A when a concurrency-sensitive path changed", () => {
    expect(() =>
      validateConcurrencyDeclaration(`${heading}\n\n- [x] N/A — no impact.\n`, [
        "src/lib/booking-cancel.ts",
      ]),
    ).toThrow(/cannot use N\/A/);
  });

  it("rejects template placeholders and unnumbered compatibility claims", () => {
    expect(() => validateConcurrencyDeclaration(`${heading}\n\n- Writer class(es), canonical lock key(s), and acquisition order:\n`)).toThrow(
      /must complete/,
    );
    expect(() =>
      validateConcurrencyDeclaration(complete.replace("#1911", "recent work")),
    ).toThrow(/PR number/);
  });
});
