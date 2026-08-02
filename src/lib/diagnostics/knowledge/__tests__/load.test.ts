import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildKnowledgeBundle } from "../generate";
import { OPTIONAL_SOURCE_INCLUDE_GLOBS } from "../allowlist";
import { serializeBundle, computeEntriesDigest } from "../serialize";
import { loadKnowledgeBundle } from "../load";
import { verifyBundleObject } from "../verify";
import { KNOWLEDGE_BUNDLE_PLACEHOLDER_SHA, type KnowledgeBundle } from "../types";

const COMMIT = "abc1230000000000000000000000000000000def";

function validBundle(): KnowledgeBundle {
  return buildKnowledgeBundle({
    files: [
      { path: "docs/GUIDE.md", content: "# Title\n\nHello world.\n" },
      { path: "src/lib/pay.ts", content: "export const total = 1;\n" },
    ],
    commitSha: COMMIT,
    observedAt: "2026-02-02T00:00:00.000Z",
    overlay: { include: [...OPTIONAL_SOURCE_INCLUDE_GLOBS] },
  });
}

describe("verifyBundleObject — accepts a good bundle", () => {
  it("returns ok for an untampered, verified-commit bundle", () => {
    const result = verifyBundleObject(validBundle());
    expect(result.ok).toBe(true);
  });
});

describe("verifyBundleObject — FAILS CLOSED on tamper", () => {
  it("integrity-mismatch when an entry field is altered without re-signing", () => {
    const b = structuredClone(validBundle());
    b.entries[0].byteLength += 1; // changes canonical entries, not the digest
    const result = verifyBundleObject(b);
    expect(result).toMatchObject({ ok: false, reason: "integrity-mismatch" });
  });

  it("excerpt-hash-mismatch when excerpt text is swapped but re-digested", () => {
    const b = structuredClone(validBundle());
    b.entries[0].excerpts[0].text += " TAMPERED";
    // Attacker refreshes the WHOLE-bundle digest so integrity passes...
    b.integrity.entriesDigest = computeEntriesDigest(b.entries);
    // ...but the per-excerpt hash is now stale — this is the guard that catches it.
    const result = verifyBundleObject(b);
    expect(result).toMatchObject({ ok: false, reason: "excerpt-hash-mismatch" });
  });

  it("count-mismatch when meta.entryCount lies", () => {
    const b = structuredClone(validBundle());
    b.meta.entryCount = 999;
    expect(verifyBundleObject(b)).toMatchObject({
      ok: false,
      reason: "count-mismatch",
    });
  });

  it("unverified-commit for the build-time placeholder SHA", () => {
    const b = structuredClone(validBundle());
    b.meta.commitSha = KNOWLEDGE_BUNDLE_PLACEHOLDER_SHA;
    expect(verifyBundleObject(b)).toMatchObject({
      ok: false,
      reason: "unverified-commit",
    });
  });

  it("unverified-commit for a non-hex / short SHA", () => {
    const b = structuredClone(validBundle());
    b.meta.commitSha = "not-a-real-sha";
    expect(verifyBundleObject(b)).toMatchObject({
      ok: false,
      reason: "unverified-commit",
    });
  });

  it("invalid-schema for a structurally wrong object", () => {
    expect(verifyBundleObject({ schemaVersion: 1 })).toMatchObject({
      ok: false,
      reason: "invalid-schema",
    });
    expect(verifyBundleObject(null)).toMatchObject({
      ok: false,
      reason: "invalid-schema",
    });
  });
});

describe("loadKnowledgeBundle — filesystem fail-closed", () => {
  const dirs: string[] = [];
  function tmp(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "kb-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    delete process.env.KNOWLEDGE_BUNDLE_PATH;
  });

  it("MISSING when the bundle file does not exist", async () => {
    const result = await loadKnowledgeBundle({
      path: path.join(tmp(), "does-not-exist.json"),
    });
    expect(result).toMatchObject({ ok: false, reason: "missing" });
  });

  it("malformed when the file is not valid JSON", async () => {
    const file = path.join(tmp(), "bad.json");
    writeFileSync(file, "{ not json", "utf8");
    const result = await loadKnowledgeBundle({ path: file });
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("ok when a real serialized bundle is present on disk", async () => {
    const file = path.join(tmp(), "knowledge-bundle.json");
    writeFileSync(file, serializeBundle(validBundle()), "utf8");
    const result = await loadKnowledgeBundle({ path: file });
    expect(result.ok).toBe(true);
  });

  it("resolves the path from KNOWLEDGE_BUNDLE_PATH when set", async () => {
    const file = path.join(tmp(), "env-bundle.json");
    writeFileSync(file, serializeBundle(validBundle()), "utf8");
    process.env.KNOWLEDGE_BUNDLE_PATH = file;
    const result = await loadKnowledgeBundle();
    expect(result.ok).toBe(true);
  });
});
