import { describe, expect, it } from "vitest";

import {
  buildKnowledgeBundle,
  KnowledgeBundleSecretError,
  type KnowledgeSourceFile,
} from "../generate";
import { OPTIONAL_SOURCE_INCLUDE_GLOBS } from "../allowlist";
import { serializeBundle, computeEntriesDigest } from "../serialize";

const COMMIT_A = "a".repeat(40);
const OBSERVED_A = "2026-01-01T00:00:00.000Z";

// Widen to source so we can exercise symbols/excerpts on `.ts` inputs.
const SOURCE_OVERLAY = { include: [...OPTIONAL_SOURCE_INCLUDE_GLOBS] };

const docFile: KnowledgeSourceFile = {
  path: "docs/GUIDE.md",
  content:
    "# Title\n\nIntro paragraph.\n\n## Section One\n\nBody one.\n\n## Section Two\n\nBody two.\n",
};
const schemaFile: KnowledgeSourceFile = {
  path: "prisma/schema.prisma",
  content:
    "generator client {\n  provider = \"prisma-client-js\"\n}\n\nmodel Member {\n  id String @id\n}\n\nenum Role {\n  ADMIN\n}\n",
};
const srcFile: KnowledgeSourceFile = {
  path: "src/lib/example.ts",
  content:
    "import x from \"y\";\n\nexport function alpha() {\n  return 1;\n}\n\nexport const beta = 2;\n\nexport interface Gamma {\n  n: number;\n}\n",
};

function build(files: KnowledgeSourceFile[], overrides = {}) {
  return buildKnowledgeBundle({
    files,
    commitSha: COMMIT_A,
    observedAt: OBSERVED_A,
    overlay: SOURCE_OVERLAY,
    ...overrides,
  });
}

describe("buildKnowledgeBundle — determinism", () => {
  it("is byte-identical for identical inputs", () => {
    const a = serializeBundle(build([docFile, schemaFile, srcFile]));
    const b = serializeBundle(build([docFile, schemaFile, srcFile]));
    expect(a).toBe(b);
  });

  it("is independent of input file ORDER", () => {
    const a = serializeBundle(build([docFile, schemaFile, srcFile]));
    const b = serializeBundle(build([srcFile, docFile, schemaFile]));
    expect(a).toBe(b);
  });

  it("entries digest is stable across differing commitSha / observedAt", () => {
    const one = build([docFile, schemaFile], {
      commitSha: "b".repeat(40),
      observedAt: "2020-05-05T05:05:05.000Z",
    });
    const two = build([docFile, schemaFile], {
      commitSha: "c".repeat(40),
      observedAt: "2030-09-09T09:09:09.000Z",
    });
    expect(one.integrity.entriesDigest).toBe(two.integrity.entriesDigest);
    // ...but the serialized bundles differ because meta differs.
    expect(serializeBundle(one)).not.toBe(serializeBundle(two));
  });

  it("recorded digest matches an independent recomputation", () => {
    const bundle = build([docFile, schemaFile, srcFile]);
    expect(bundle.integrity.entriesDigest).toBe(
      computeEntriesDigest(bundle.entries),
    );
  });

  it("normalizes CRLF so a Windows checkout hashes identically to LF", () => {
    const lf = build([{ path: "docs/A.md", content: "# H\n\ntext\n" }]);
    const crlf = build([{ path: "docs/A.md", content: "# H\r\n\r\ntext\r\n" }]);
    expect(lf.entries[0].contentHash).toBe(crlf.entries[0].contentHash);
  });
});

describe("buildKnowledgeBundle — extraction", () => {
  it("extracts markdown headings as symbols and section excerpts", () => {
    const entry = build([docFile]).entries[0];
    expect(entry.language).toBe("markdown");
    expect(entry.symbols).toEqual(["Section One", "Section Two", "Title"]);
    expect(entry.excerpts.length).toBeGreaterThanOrEqual(3);
  });

  it("extracts prisma block names as symbols", () => {
    const entry = build([schemaFile]).entries[0];
    expect(entry.language).toBe("prisma");
    expect(entry.symbols).toContain("model Member");
    expect(entry.symbols).toContain("enum Role");
  });

  it("extracts top-level TS exports as symbols", () => {
    const entry = build([srcFile]).entries[0];
    expect(entry.language).toBe("typescript");
    expect(entry.symbols).toEqual(["Gamma", "alpha", "beta"]);
  });

  it("tags sensitivity by path and content class", () => {
    const bundle = build([
      docFile,
      schemaFile,
      { path: "src/lib/auth.ts", content: "export const x = 1;\n" },
      { path: "src/lib/xero-sync.ts", content: "export const y = 2;\n" },
    ]);
    const byPath = Object.fromEntries(
      bundle.entries.map((e) => [e.path, e.sensitivity]),
    );
    expect(byPath["docs/GUIDE.md"]).toEqual(["public-docs"]);
    expect(byPath["prisma/schema.prisma"]).toEqual(["schema"]);
    expect(byPath["src/lib/auth.ts"]).toContain("security-sensitive");
    expect(byPath["src/lib/xero-sync.ts"]).toContain("finance-sensitive");
  });

  it("re-filters through the allowlist even if the caller passes junk", () => {
    // A test file + an env file are handed in; both must be dropped.
    const bundle = build([
      docFile,
      { path: "src/lib/example.test.ts", content: "export const t = 1;\n" },
      { path: ".env", content: "SECRET=whatever\n" },
    ]);
    const paths = bundle.entries.map((e) => e.path);
    expect(paths).toEqual(["docs/GUIDE.md"]);
  });
});

describe("buildKnowledgeBundle — fail closed", () => {
  it("THROWS rather than emitting a bundle when a secret is present", () => {
    const leaky: KnowledgeSourceFile = {
      path: "docs/LEAK.md",
      content: `Example config:\n\naws_key = "AKIA${"1234567890ABCDEF"}"\n`,
    };
    expect(() => build([docFile, leaky])).toThrow(KnowledgeBundleSecretError);
    try {
      build([docFile, leaky]);
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeBundleSecretError);
      expect((err as KnowledgeBundleSecretError).findings[0].path).toBe(
        "docs/LEAK.md",
      );
    }
  });

  it("rejects duplicate paths (order-dependence would break determinism)", () => {
    expect(() =>
      build([
        { path: "docs/A.md", content: "# One\n" },
        { path: "docs/A.md", content: "# Two\n" },
      ]),
    ).toThrow(/Duplicate path/);
  });
});
