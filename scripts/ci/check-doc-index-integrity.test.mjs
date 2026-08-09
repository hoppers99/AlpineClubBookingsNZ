import { describe, expect, it } from "vitest";

import {
  BYTE_ORDER_MARK,
  auditDocReachability,
  auditDocs,
  auditEncoding,
  auditIndexRows,
  auditInvariantFilesLinkedFromIndex,
  auditInvariantIds,
  auditLineNumberCitations,
  auditRoutingTable,
  routingTableRows,
  scannableLines,
} from "./check-doc-index-integrity.mjs";

/**
 * Unit coverage for the pure half of the doc-index gate (#2691 phase 4).
 *
 * This file is the ONE entry in the checker's `CITATION_EXEMPT_FILES`, which
 * covers both the invariant-id scan and the line-number citation scan. Its
 * fixtures must contain unresolvable ids, unrecognised prefixes and line-number
 * citations, because that is what they assert the checker rejects. Every fixture
 * below is therefore a literal that would fail the real scan, which is the
 * point. Nothing else is exempt — not even the checker itself.
 *
 * It is NOT exempt from the encoding audit, so the mojibake fixtures are built
 * from code points rather than written out: this file stays ASCII and the check
 * it is testing stays green over it.
 */

/** An em dash after one UTF-8 -> cp1252 -> UTF-8 round-trip. */
const MOJIBAKE_EM_DASH = String.fromCharCode(0xe2, 0x20ac, 0x201d);

/** A non-breaking space after the same round-trip. */
const MOJIBAKE_NBSP = String.fromCharCode(0xc2, 0xa0);

/** A minimal repository that satisfies every rule, as a `Map` of path -> text. */
function repo(overrides = {}) {
  return new Map(
    Object.entries({
      "README.md": "# Repo\n\nSee [docs](docs/README.md).\n",
      "AGENTS.md": [
        "# Agent Guidelines",
        "",
        "### Routing table",
        "",
        "| About to change... | Invariants | Also read |",
        "| --- | --- |  --- |",
        "| Anything holding cents | `INV-MONEY` -> [`money.md`](docs/invariants/money.md) | [`hub`](docs/README.md) |",
        "",
        "### Something else",
        "",
        "| Not | A | Routing row |",
        "",
      ].join("\n"),
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

describe("routingTableRows", () => {
  it("takes the rows under the heading and stops at the next heading", () => {
    const rows = routingTableRows(repo().get("AGENTS.md")).map((row) => row.text);

    // Header row plus the one content row; the separator and the table under the
    // NEXT heading are both left out.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("INV-MONEY");
    expect(rows.join("\n")).not.toContain("Routing row");
  });
});

describe("auditRoutingTable", () => {
  it("passes a table whose prefixes and documents all resolve", () => {
    expect(auditRoutingTable(repo())).toEqual([]);
  });

  it("fails a row that links to a document nobody tracks", () => {
    const files = repo();
    files.set(
      "AGENTS.md",
      files.get("AGENTS.md").replace("](docs/README.md)", "](docs/gone.md)"),
    );

    const problems = auditRoutingTable(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/gone.md");
    expect(problems[0]).toContain("is not a tracked file");
  });

  it("fails a routed prefix that nothing declares (the typo case)", () => {
    const files = repo();
    files.set(
      "AGENTS.md",
      files.get("AGENTS.md").replace("`INV-MONEY`", "`INV-MONYE`"),
    );

    const problems = auditRoutingTable(files);

    // Routed-but-undeclared, and declared-but-unrouted: both directions fire.
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("routes INV-MONYE");
    expect(problems[1]).toContain("INV-MONEY is declared");
  });

  it("fails a declared invariant family that no row sends anybody to", () => {
    const files = repo({
      "docs/invariants/beds.md": "# Beds\n\n## INV-CAP-001\n\n- A rule.\n",
    });
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}| \`INV-CAP-001\` | A rule |\n`,
    );

    const problems = auditRoutingTable(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-CAP is declared");
    expect(problems[0]).toContain("no routing table row");
  });

  it("fails loudly if the heading it anchors on is renamed away", () => {
    const files = repo();
    files.set(
      "AGENTS.md",
      files.get("AGENTS.md").replace("### Routing table", "### Where to look"),
    );

    const problems = auditRoutingTable(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("No routing table found");
  });
});

describe("auditLineNumberCitations", () => {
  it("fails a line-number citation into the invariants index", () => {
    const problems = auditLineNumberCitations(
      repo({ "src/lib/money.ts": "// See docs/DOMAIN_INVARIANTS.md:120.\n" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("src/lib/money.ts:1");
    expect(problems[0]).toContain("docs/DOMAIN_INVARIANTS.md:120");
    expect(problems[0]).toContain("LINE");
  });

  it("fails a line-RANGE citation into a domain file", () => {
    const problems = auditLineNumberCitations(
      repo({ "src/lib/money.ts": "// invariants/money.md:35-40 says so.\n" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("invariants/money.md:35-40");
  });

  it("fails in the files that used to be grandfathered, like anywhere else", () => {
    // These three carried the five pre-existing citations. They were fixed
    // rather than registered, and the register was deleted, so a fresh citation
    // here is now caught exactly like a fresh citation anywhere — this is the
    // case an allowlist would have masked.
    const problems = auditLineNumberCitations(
      repo({
        "src/lib/booking-request-quotes.ts": "// DOMAIN_INVARIANTS.md:35-40\n",
        "src/lib/booking-request-shared.ts": "// DOMAIN_INVARIANTS.md:35-40\n",
        "src/lib/ib-hold-clearing-audit.ts": "// DOMAIN_INVARIANTS.md:124-128\n",
      }),
    );

    expect(problems).toHaveLength(3);
    expect(problems.map((p) => p.split(" ")[0])).toEqual([
      "src/lib/booking-request-quotes.ts:1",
      "src/lib/booking-request-shared.ts:1",
      "src/lib/ib-hold-clearing-audit.ts:1",
    ]);
  });

  it("fails every citation on a line, not just the first", () => {
    const problems = auditLineNumberCitations(
      repo({
        "src/lib/money.ts":
          "// DOMAIN_INVARIANTS.md:120 and invariants/money.md:900 disagree.\n",
      }),
    );

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("DOMAIN_INVARIANTS.md:120");
    expect(problems[1]).toContain("invariants/money.md:900");
  });

  it("points the reader at the id scheme rather than just refusing", () => {
    const [problem] = auditLineNumberCitations(
      repo({ "src/lib/money.ts": "// DOMAIN_INVARIANTS.md:120\n" }),
    );

    expect(problem).toContain("INV-CAP-021 style");
    expect(problem).toContain("docs/DOMAIN_INVARIANTS.md");
  });

  it("ignores a fenced example", () => {
    expect(
      auditLineNumberCitations(
        repo({ "docs/example.md": "# Example\n\n```\nDOMAIN_INVARIANTS.md:35-40\n```\n" }),
      ),
    ).toEqual([]);
  });

  it("ignores a line reference into a document that is not an invariants file", () => {
    expect(
      auditLineNumberCitations(
        repo({ "src/lib/money.ts": "// See docs/ARCHITECTURE.md:120.\n" }),
      ),
    ).toEqual([]);
  });
});

describe("auditEncoding", () => {
  it("passes the clean fixture repository", () => {
    expect(auditEncoding(repo())).toEqual([]);
  });

  it("fails a file that starts with a UTF-8 byte-order mark", () => {
    const problems = auditEncoding(
      repo({ "docs/example.md": `${BYTE_ORDER_MARK}# Example\n` }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/example.md");
    expect(problems[0]).toContain("byte-order mark");
    expect(problems[0]).toContain("UTF-8 without a BOM");
  });

  it("fails double-encoded text and explains where it comes from", () => {
    const problems = auditEncoding(
      repo({
        "docs/example.md": `# Example\n\nOne rule ${MOJIBAKE_EM_DASH} and no more.\n`,
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/example.md:3");
    expect(problems[0]).toContain("mojibake");
    expect(problems[0]).toContain("cp1252");
  });

  it("catches the non-breaking-space signature too", () => {
    const problems = auditEncoding(
      repo({ "docs/example.md": `# Example\n\n$10${MOJIBAKE_NBSP}per night.\n` }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/example.md:3");
  });

  it("stays quiet on legitimate non-ASCII text", () => {
    // Real prose in this repository: em dashes, curly quotes, te reo macrons and
    // the odd accented name. None of them forms a lead+trail pair.
    const prose = [
      "# Example",
      "",
      "Tokoroa Alpine Club — the club's “house style” uses em dashes.",
      "Māori place names carry macrons: Whakatāne, Tūrangi.",
      "A café in Zürich costs £5 – or €6.",
      "",
    ].join("\n");

    expect(auditEncoding(repo({ "docs/example.md": prose }))).toEqual([]);
  });
});
