import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "ci", "check-pr-body.mjs");

/**
 * A throwaway repo with a `base` branch and one commit on top of it, so the
 * script's `git merge-base HEAD <base>` has something real to resolve.
 * `extraFiles` is `{ relPath: contents }` added in that second commit.
 */
function makeRepo(extraFiles) {
  const root = mkdtempSync(join(tmpdir(), "pr-body-gate-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch", "base");
  git("config", "user.email", "gate-test@example.invalid");
  git("config", "user.name", "Gate Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  git("checkout", "--quiet", "-b", "work");
  for (const [relPath, contents] of Object.entries(extraFiles)) {
    mkdirSync(join(root, dirname(relPath)), { recursive: true });
    writeFileSync(join(root, relPath), contents);
  }
  git("add", "-A");
  git("commit", "--quiet", "-m", "work");
  return root;
}

function runGate(root, body) {
  const bodyPath = join(root, "body.md");
  writeFileSync(bodyPath, body);
  const result = spawnSync(process.execPath, [script, bodyPath, "--base", "base"], {
    cwd: root,
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * A body that satisfies the concurrency gate, so the exit code these tests
 * assert on is decided by the changelog gate alone rather than by a second
 * failure leaking into the same status. The fixtures below touch only
 * `src/lib/thing.ts`, which is not on a concurrency-sensitive path, so the
 * ticked `N/A` is the truthful declaration for them.
 *
 * The heading and the checkbox line are copied verbatim from
 * `.github/pull_request_template.md`; the gate matches them exactly.
 */
const BODY_WITHOUT_FRAGMENT = [
  "## Summary",
  "",
  "- adds a source file",
  "",
  "## Concurrency And Lock Impact",
  "",
  "- [x] N/A — no transaction, lifecycle, capacity, settlement, credit, webhook,",
  "      cron, or concurrency-sensitive writer changed.",
  "",
].join("\n");

describe("pr:check offline gate runner", () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  /**
   * The regression this file exists for. `validateChangelogFragment` reads
   * `change.path` off each element, so handing it bare `--name-only` strings
   * makes every path `undefined`: `isCodeBearing` sees nothing, the gate returns
   * `not-code-bearing`, and PASS is printed for a body that CI will reject.
   *
   * Reverting `changesAgainst` to `--name-only` (or dropping `parseNameStatus`)
   * turns this assertion red, which is the point — the previous shape reported a
   * hollow PASS on every local run.
   */
  it("fails a code-bearing diff that adds no fragment and carries no marker", () => {
    root = makeRepo({ "src/lib/thing.ts": "export const value = 1;\n" });
    const { status, output } = runGate(root, BODY_WITHOUT_FRAGMENT);
    expect(output).toContain("FAIL  Changelog fragment");
    expect(status).toBe(1);
  });

  it("passes the same diff once it adds a fragment", () => {
    root = makeRepo({
      "src/lib/thing.ts": "export const value = 1;\n",
      "changelog.d/1234-thing.md": "Adds a thing.\n",
    });
    const { status, output } = runGate(root, BODY_WITHOUT_FRAGMENT);
    expect(output).toContain("PASS  Changelog fragment");
    expect(status).toBe(0);
  });

  it("passes the same diff when the body carries the none marker instead", () => {
    root = makeRepo({ "src/lib/thing.ts": "export const value = 1;\n" });
    const { status, output } = runGate(
      root,
      `${BODY_WITHOUT_FRAGMENT}\nchangelog: none — internal refactor with no behaviour change\n`,
    );
    expect(output).toContain("PASS  Changelog fragment");
    expect(status).toBe(0);
  });

  /**
   * A deleted fragment must not be credited as an added one — that is the whole
   * reason the gate needs `--name-status` rather than `--name-only`.
   */
  it("does not credit a code-bearing diff for deleting somebody else's fragment", () => {
    root = mkdtempSync(join(tmpdir(), "pr-body-gate-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "--quiet", "--initial-branch", "base");
    git("config", "user.email", "gate-test@example.invalid");
    git("config", "user.name", "Gate Test");
    git("config", "commit.gpgsign", "false");
    git("config", "core.autocrlf", "false");
    mkdirSync(join(root, "changelog.d"), { recursive: true });
    writeFileSync(join(root, "changelog.d", "1111-existing.md"), "Someone else's entry.\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "seed");
    git("checkout", "--quiet", "-b", "work");
    rmSync(join(root, "changelog.d", "1111-existing.md"));
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "thing.ts"), "export const value = 1;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "work");

    const { status, output } = runGate(root, BODY_WITHOUT_FRAGMENT);
    expect(output).toContain("FAIL  Changelog fragment");
    expect(status).toBe(1);
  });

  /** Test-only source changes are not code-bearing, so no fragment is owed. */
  it("passes a test-only change under src/ with no fragment", () => {
    root = makeRepo({
      "src/lib/__tests__/thing.test.ts": "it('works', () => {});\n",
    });
    const { status, output } = runGate(root, BODY_WITHOUT_FRAGMENT);
    expect(output).toContain("PASS  Changelog fragment");
    expect(status).toBe(0);
  });
});
