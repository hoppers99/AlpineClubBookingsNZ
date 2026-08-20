import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  baseSizeOf,
  changedFilesSinceBase,
  resolveBaseRef,
  resolveBaseSizes,
} from "../lib/file-size-base";

/**
 * #2979 — these cases build THROWAWAY GIT REPOSITORIES rather than mocking git.
 *
 * That is deliberate. The whole point of the change is that the previous length
 * comes from git instead of from a file we wrote ourselves, so a test that mocks
 * git would assert nothing about the only question that matters. Rename
 * detection in particular is a git heuristic — asserting that `-M` reports what
 * we expect is asserting git's behaviour, and it can only be done against git.
 *
 * Each repository is a few files in a temp directory and is removed afterwards.
 */

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repository with one commit, and a helper to write files into it. */
function newRepo(): { root: string; write: (file: string, lines: number) => void; commit: (msg: string) => string } {
  const root = mkdtempSync(path.join(tmpdir(), "acb-fsb-"));
  ROOTS.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  // A commit signature would prompt or fail in CI; this suite never signs.
  git(root, "config", "commit.gpgsign", "false");
  const write = (file: string, lines: number) => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n", "utf8");
  };
  const commit = (msg: string) => {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", msg);
    return git(root, "rev-parse", "HEAD").trim();
  };
  return { root, write, commit };
}

describe("resolveBaseRef", () => {
  it("resolves a real ref to its commit", () => {
    const repo = newRepo();
    repo.write("a.ts", 3);
    const sha = repo.commit("first");

    const result = resolveBaseRef(repo.root, "HEAD");

    expect(result).toEqual({ ok: true, sha });
  });

  it("FAILS, rather than passing, when the ref does not exist", () => {
    // The load-bearing case. A gate that cannot read its comparison must not
    // report a green it has not earned - the same rule `npm run pr:check`
    // follows for an unfetched origin/main.
    const repo = newRepo();
    repo.write("a.ts", 3);
    repo.commit("first");

    const result = resolveBaseRef(repo.root, "origin/main");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("origin/main");
      expect(result.error).toContain("git fetch origin main");
    }
  });
});

describe("baseSizeOf", () => {
  it("reports the length a file had at that commit, not now", () => {
    const repo = newRepo();
    repo.write("a.ts", 10);
    const first = repo.commit("first");
    repo.write("a.ts", 40);
    repo.commit("grown");

    expect(baseSizeOf(repo.root, first, "a.ts")).toEqual({ kind: "existed", lines: 10 });
  });

  it("reports absent for a path that did not exist there", () => {
    const repo = newRepo();
    repo.write("a.ts", 10);
    const first = repo.commit("first");
    repo.write("b.ts", 5);
    repo.commit("added b");

    expect(baseSizeOf(repo.root, first, "b.ts")).toEqual({ kind: "absent" });
  });

  it("counts a file with no trailing newline the same way countLines does", () => {
    const repo = newRepo();
    const full = path.join(repo.root, "a.ts");
    writeFileSync(full, "one\ntwo\nthree", "utf8");
    const sha = repo.commit("no trailing newline");

    expect(baseSizeOf(repo.root, sha, "a.ts")).toEqual({ kind: "existed", lines: 3 });
  });
});

describe("changedFilesSinceBase", () => {
  it("lists added and modified files", () => {
    const repo = newRepo();
    repo.write("keep.ts", 4);
    repo.write("grow.ts", 4);
    const base = repo.commit("base");
    repo.write("grow.ts", 9);
    repo.write("new.ts", 2);
    repo.commit("changed");

    const result = changedFilesSinceBase(repo.root, base);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed.map((c) => c.file).sort()).toEqual(["grow.ts", "new.ts"]);
      expect(result.changed.every((c) => c.renamedFrom === undefined)).toBe(true);
    }
  });

  it("follows a rename, so the file keeps its predecessor rather than reading as new", () => {
    const repo = newRepo();
    repo.write("old-name.ts", 30);
    const base = repo.commit("base");
    git(repo.root, "mv", "old-name.ts", "new-name.ts");
    repo.commit("renamed");

    const result = changedFilesSinceBase(repo.root, base);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed).toEqual([{ file: "new-name.ts", renamedFrom: "old-name.ts" }]);
    }
  });

  it("keeps the NUL stream aligned when a path needs quoting", () => {
    // A rename consumes two paths and every other status consumes one, so the
    // arity has to be read off the status letter. A space in a filename is the
    // cheapest way to prove the stream is not being split naively.
    const repo = newRepo();
    repo.write("plain.ts", 3);
    const base = repo.commit("base");
    repo.write("has space.ts", 3);
    repo.write("plain.ts", 6);
    repo.commit("added a spaced path");

    const result = changedFilesSinceBase(repo.root, base);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed.map((c) => c.file).sort()).toEqual(["has space.ts", "plain.ts"]);
    }
  });
});

describe("resolveBaseSizes", () => {
  it("gives every changed file its previous length, and new files absent", () => {
    const repo = newRepo();
    repo.write("grow.ts", 12);
    repo.write("untouched.ts", 99);
    const base = repo.commit("base");
    repo.write("grow.ts", 20);
    repo.write("brand-new.ts", 5);
    repo.commit("changed");

    const result = resolveBaseSizes(repo.root, base);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizes.get("grow.ts")).toEqual({ kind: "existed", lines: 12 });
      expect(result.sizes.get("brand-new.ts")).toEqual({ kind: "absent" });
      // An untouched file is not in the diff at all, which is the point: the
      // check never has to look at a file this pull request did not change.
      expect(result.sizes.has("untouched.ts")).toBe(false);
    }
  });

  it("a renamed file resolves to its OLD path's length and records where from", () => {
    // This is the case the stored ledger got wrong: keyed by path, a rename left
    // the old entry behind and the new path was unlisted, so it passed.
    const repo = newRepo();
    repo.write("big.ts", 1200);
    const base = repo.commit("base");
    git(repo.root, "mv", "big.ts", "big.js");
    repo.commit("renamed to .js");

    const result = resolveBaseSizes(repo.root, base);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizes.get("big.js")).toEqual({
        kind: "existed",
        lines: 1200,
        from: "big.ts",
      });
    }
  });

  it("propagates the unresolvable-base failure rather than returning an empty map", () => {
    // An empty map would read as "nothing changed", i.e. a pass. That is exactly
    // the false green this whole design refuses.
    const repo = newRepo();
    repo.write("a.ts", 3);
    repo.commit("first");

    const result = resolveBaseSizes(repo.root, "refs/heads/does-not-exist");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does-not-exist");
  });
});
