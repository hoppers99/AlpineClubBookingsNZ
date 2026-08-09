import { describe, expect, it } from "vitest";

import {
  auditDocReachability,
  auditDocs,
  auditIndexRows,
  auditInvariantFilesLinkedFromIndex,
  auditInvariantIds,
  scannableLines,
} from "./check-doc-index-integrity.mjs";

/**
 * Unit coverage for the pure half of the doc-index gate (#2691 phase 4).
 *
 * This file is the ONE entry in the checker's `CITATION_EXEMPT_FILES`, because
 * its fixtures must contain unresolvable ids and unrecognised prefixes — that is
 * what they assert the checker rejects. Every fixture below is therefore a
 * literal id that would fail the real scan, which is the point.
 */

/** A minimal repository that satisfies every rule, as a `Map` of path -> text. */
function repo(overrides = {}) {
  return new Map(
    Object.entries({
      "README.md": "# Repo\n\nSee [docs](docs/README.md).\n",
      "docs/README.md": "# Docs\n\n- [Domain invariants](DOMAIN_INVARIANTS.md)\n",
      "docs/DOMAIN_INVARIANTS.md": [
        "# Domain Invariants",
        "",
        "File: [`money.md`](invariants/money.md).",
        "",
        "| ID | Covers |",
        "| --- | --- |",
        "| `INV-MONEY-001` | Store and calculate money as integer cents |",
        "",
      ].join("\n"),
      "docs/invariants/money.md": [
        "# Money",
        "",
        "Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md).",
        "",
        "## INV-MONEY-001",
        "",
        "- Store and calculate money as integer cents.",
        "",
      ].join("\n"),
      ...overrides,
    }),
  );
}

describe("scannableLines", () => {
  it("drops fenced blocks so a document can show an example id", () => {
    const lines = scannableLines("real\n```\nfenced\n```\nreal again\n");
    expect(lines.map((l) => l.text)).toEqual(["real", "real again", ""]);
  });

  it("keeps inline backticks, because that is how citations are written", () => {
    const lines = scannableLines("see `INV-MONEY-001` for the rule\n");
    expect(lines[0].text).toContain("INV-MONEY-001");
  });
});

describe("auditDocs — the whole check", () => {
  it("passes a repository that satisfies every rule", () => {
    expect(auditDocs(repo())).toEqual([]);
  });
});

describe("auditInvariantIds", () => {
  it("fails a duplicate definition, naming both places", () => {
    const problems = auditInvariantIds(
      repo({
        "docs/invariants/other.md": "# Other\n\n## INV-MONEY-001\n\n- A second one.\n",
      }),
    );

    expect(problems.some((p) => p.includes("INV-MONEY-001") && p.includes("2 times"))).toBe(
      true,
    );
  });

  it("fails a citation under a declared prefix that resolves to nothing", () => {
    const problems = auditInvariantIds(
      repo({
        "src/lib/money.ts": "// Enforces INV-MONEY-742.\n",
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-742");
    expect(problems[0]).toContain("src/lib/money.ts:1");
  });

  it("fails an unrecognised prefix rather than ignoring it (the typo case)", () => {
    // `MONYE` is the likelier mistake than a genuinely new area, and a blanket
    // whitelist of unknown prefixes would make it invisible.
    const problems = auditInvariantIds(
      repo({ "src/lib/money.ts": "// See INV-MONYE-001.\n" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONYE-");
    expect(problems[0]).toContain("reserved");
  });

  it("accepts the Xero invoice-number fixtures that share the shape", () => {
    const problems = auditInvariantIds(
      repo({
        "src/lib/__tests__/xero.test.ts":
          'const invoices = ["INV-IB-001", "INV-SETTLE-001", "INV-SETTLE-002", "INV-SUP-001"];\n',
      }),
    );

    expect(problems).toEqual([]);
  });

  it("ignores an id inside a fenced code block", () => {
    const problems = auditInvariantIds(
      repo({
        "docs/example.md": "# Example\n\n```\nINV-MONEY-742\nINV-NOPE-001\n```\n",
      }),
    );

    expect(problems).toEqual([]);
  });

  it("catches a two-digit near-miss under a real prefix", () => {
    // It slips past the strict citation pattern and would otherwise resolve to
    // nothing while being reported as nothing.
    const problems = auditInvariantIds(
      repo({ "src/lib/money.ts": "// See INV-MONEY-01.\n" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-01");
    expect(problems[0]).toContain("2 digit(s)");
  });

  it("does not apply the shape guard to a reserved invoice prefix", () => {
    const problems = auditInvariantIds(
      repo({ "src/lib/__tests__/xero.test.ts": 'const n = "INV-XERO-9";\n' }),
    );

    expect(problems).toEqual([]);
  });

  it("only takes definitions from docs/invariants", () => {
    const problems = auditInvariantIds(
      repo({ "docs/elsewhere.md": "# Elsewhere\n\n## INV-MONEY-742\n" }),
    );

    // The heading did not define anything, so the id in it is an unresolved
    // citation — which is the loud outcome, not a silent second definition.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no file under docs/invariants/ defines it");
  });
});

describe("auditInvariantFilesLinkedFromIndex", () => {
  it("fails an invariant file the index does not name", () => {
    const files = repo({
      "docs/invariants/orphan.md": "# Orphan\n\n## INV-MONEY-002\n\n- A rule.\n",
    });
    // Keep the index catalogue honest so this test isolates the link rule.
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}| \`INV-MONEY-002\` | A rule |\n`,
    );

    const problems = auditInvariantFilesLinkedFromIndex(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/invariants/orphan.md");
  });

  it("fails loudly when the index itself is gone", () => {
    const files = repo();
    files.delete("docs/DOMAIN_INVARIANTS.md");

    expect(auditInvariantFilesLinkedFromIndex(files)[0]).toContain("is missing");
  });
});

describe("auditIndexRows", () => {
  it("fails a defined id with no catalogue row", () => {
    const files = repo({
      "docs/invariants/money.md": [
        "# Money",
        "",
        "## INV-MONEY-001",
        "",
        "- Cents.",
        "",
        "## INV-MONEY-002",
        "",
        "- Also cents.",
        "",
      ].join("\n"),
    });

    const problems = auditIndexRows(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-002");
    expect(problems[0]).toContain("no row");
  });

  it("fails a catalogue row whose definition does not exist", () => {
    const files = repo();
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}| \`INV-MONEY-002\` | Vanished |\n`,
    );

    const problems = auditIndexRows(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-002");
    expect(problems[0]).toContain("nothing under docs/invariants/ defines it");
  });

  it("fails a duplicated catalogue row", () => {
    const files = repo();
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}| \`INV-MONEY-001\` | Listed twice |\n`,
    );

    const problems = auditIndexRows(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2 rows");
  });

  it("does not count an id used as an illustration in the index's own prose", () => {
    const files = repo();
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}\nCite ids, never line numbers: \`INV-MONEY-001\` stays valid.\n`,
    );

    expect(auditIndexRows(files)).toEqual([]);
  });
});

describe("auditDocReachability", () => {
  it("fails a docs page nothing links to", () => {
    const problems = auditDocReachability(
      repo({ "docs/lonely/notes.md": "# Notes\n" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/lonely/notes.md");
  });

  it("accepts a page reached through a chain of hubs", () => {
    const problems = auditDocReachability(
      repo({
        "docs/README.md":
          "# Docs\n\n- [Domain invariants](DOMAIN_INVARIANTS.md)\n- [Lobby](lobby/README.md)\n",
        "docs/lobby/README.md": "# Lobby\n\n- [ADR-1](decisions/ADR-001.md)\n",
        "docs/lobby/decisions/ADR-001.md": "# ADR-001\n",
      }),
    );

    expect(problems).toEqual([]);
  });

  it("ignores Markdown outside docs/", () => {
    expect(auditDocReachability(repo({ "notes/scratch.md": "# Scratch\n" }))).toEqual([]);
  });
});
