/**
 * Where a file's PREVIOUS length comes from (#2979).
 *
 * The ratchet's rule is unchanged: current size debt may stay, but new debt and
 * debt growth may not appear silently. What changes is where "previous" is read
 * from. It used to be a checked-in ledger, `scripts/quality/file-size-baseline.txt`,
 * and that file was the whole problem rather than the rule:
 *
 *   - every pull request that grows a listed file rewrites the same line, so the
 *     next pull request to merge re-conflicts it, forever. Measured on the 21 Aug
 *     wave: FIVE of nine lanes touched it, and `.gitattributes` gives it no merge
 *     driver (`CHANGELOG.md` is the only `merge=` entry), so every collision was
 *     a real three-way conflict;
 *   - resolving one by picking a side ships a WRONG number, and twice did. Two
 *     lanes both raised the `src/proxy.ts` line; their code merged cleanly in
 *     different regions and the merged file was 1329 lines while the recorded
 *     ceiling read either 1320 or 1208. A third recorded a ceiling of 1101 for a
 *     file whose untouched length on `main` was already 1104 — a ledger the tree
 *     violated the moment it landed;
 *   - and a stored number keyed by PATH is fooled by a rename. A `.ts` file
 *     renamed to `.js` left its entry behind and passed.
 *
 * Reading the previous length from the base ref instead removes the artifact and
 * every one of those failure modes with it. There is no line for two branches to
 * both rewrite, no stored number to drift from the tree, and a rename is followed
 * rather than guessed at, because git reports it.
 *
 * NO NETWORK, NO BUILD, NO DATABASE. Two `git` reads per changed file at worst.
 * CI's `verify` job already checks out full history (`fetch-depth: 0`) and runs
 * this check in the same job, so the base ref is present where it matters.
 *
 * FAILS LOUDLY WHEN THE BASE CANNOT BE RESOLVED, and that is deliberate rather
 * than defensive: a gate that cannot read what it is comparing against must not
 * report a pass it has not earned. `npm run pr:check` already behaves this way
 * for the same reason — an unfetched `origin/main` is a failure there, not a
 * green. The remedy printed is the same: `git fetch origin main`.
 */
import { execFileSync } from "node:child_process";

/** How many lines a file had on the base ref, or that it did not exist there. */
export type BaseSize =
  | { kind: "existed"; lines: number; /** Set when git reports a rename. */ from?: string }
  | { kind: "absent" };

export type BaseResolution =
  | { ok: true; ref: string; sizes: Map<string, BaseSize> }
  | { ok: false; error: string };

/** Count lines the same way `countLines` does, so the two agree exactly. */
function countLinesOfBuffer(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) count += 1;
  }
  if (buf[buf.length - 1] !== 0x0a) count += 1;
  return count;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitBuffer(root: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Confirm the base ref exists and name the commit it points at.
 *
 * Returns the resolved SHA rather than the ref name so a later error message can
 * say which commit was compared against, not merely which name was asked for.
 */
export function resolveBaseRef(
  root: string,
  ref: string,
): { ok: true; sha: string } | { ok: false; error: string } {
  try {
    const sha = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
    if (!sha) return { ok: false, error: `\`git rev-parse ${ref}\` produced no commit.` };
    return { ok: true, sha };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      ok: false,
      error:
        `Could not resolve the base ref \`${ref}\` (${detail}).\n` +
        `  This check compares each changed file against its length on that ref, so it\n` +
        `  cannot run without it — and it fails rather than passing, because a gate that\n` +
        `  cannot read its comparison must not report a green it has not earned.\n` +
        `  Fix with:  git fetch origin main`,
    };
  }
}

/**
 * Files changed between the base and the working tree, with renames followed.
 *
 * `-M` is what makes a rename keep its predecessor's ceiling instead of being
 * judged as a brand-new file that must meet its budget outright. Without it,
 * moving an already-over-budget file would fail the gate for no reason — and,
 * worse in the other direction, a `.ts` to `.js` rename used to slip through the
 * old ledger entirely.
 *
 * `-z` because a path needing quoting must not be misread.
 */
export function changedFilesSinceBase(
  root: string,
  baseSha: string,
): { ok: true; changed: Array<{ file: string; renamedFrom?: string }> } | { ok: false; error: string } {
  try {
    const raw = git(root, [
      "diff",
      "-M",
      "--name-status",
      "-z",
      "--diff-filter=ACMRT",
      baseSha,
    ]);
    const fields = raw.split("\0").filter((f) => f.length > 0);
    const changed: Array<{ file: string; renamedFrom?: string }> = [];
    let i = 0;
    while (i < fields.length) {
      const status = fields[i] ?? "";
      // A rename or copy status is `R100` / `C75` and consumes TWO paths; every
      // other status consumes one. Reading the arity off the status letter is
      // what keeps the NUL stream aligned.
      if (status.startsWith("R") || status.startsWith("C")) {
        const from = fields[i + 1];
        const to = fields[i + 2];
        if (from === undefined || to === undefined) break;
        changed.push({ file: to, renamedFrom: from });
        i += 3;
        continue;
      }
      const file = fields[i + 1];
      if (file === undefined) break;
      changed.push({ file });
      i += 2;
    }
    return { ok: true, changed };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { ok: false, error: `Could not read the diff against ${baseSha}: ${detail}` };
  }
}

/** One file's length on the base ref. `absent` means it is new there. */
export function baseSizeOf(
  root: string,
  baseSha: string,
  file: string,
): BaseSize {
  try {
    return { kind: "existed", lines: countLinesOfBuffer(gitBuffer(root, ["show", `${baseSha}:${file}`])) };
  } catch {
    // `git show` fails for a path that does not exist in that tree, which is the
    // ordinary new-file case rather than an error worth reporting.
    return { kind: "absent" };
  }
}

/**
 * Resolve the previous length of every file changed since `ref`.
 *
 * A renamed file resolves to its length under its OLD path, and records that
 * path so a message can explain where the ceiling came from.
 */
export function resolveBaseSizes(root: string, ref: string): BaseResolution {
  const base = resolveBaseRef(root, ref);
  if (!base.ok) return { ok: false, error: base.error };

  const diff = changedFilesSinceBase(root, base.sha);
  if (!diff.ok) return { ok: false, error: diff.error };

  const sizes = new Map<string, BaseSize>();
  for (const { file, renamedFrom } of diff.changed) {
    if (renamedFrom) {
      const previous = baseSizeOf(root, base.sha, renamedFrom);
      sizes.set(
        file,
        previous.kind === "existed"
          ? { kind: "existed", lines: previous.lines, from: renamedFrom }
          : { kind: "absent" },
      );
      continue;
    }
    sizes.set(file, baseSizeOf(root, base.sha, file));
  }
  return { ok: true, ref: base.sha, sizes };
}
