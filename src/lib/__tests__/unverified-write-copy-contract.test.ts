import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

/**
 * Unverified-write copy — contract (#2668).
 *
 * A browser cannot tell "the request never arrived" from "the request arrived,
 * the server did the work, and the answer was lost". `fetch` rejects for both.
 * So a network-failure branch that tells the person their change "was not
 * saved" / "nothing was recorded" states as fact something it has no way to
 * know, and on a flaky connection it is wrong often enough to send them back to
 * redo a write that already happened.
 *
 * The wording was fixed once before, on one component, and grew back on five
 * others. This test is the thing that stops it growing back again: it re-walks
 * `src/` on every run, finds every branch a network failure can reach, and
 * fails if any of them makes a confident claim about the stored record.
 *
 * It is deliberately a WALK and not a list of the six files fixed in #2668 — a
 * seventh editor written next year by someone who has never read this issue is
 * exactly the case a hand-written list would miss.
 */

function repoPath(...segments: string[]) {
  return path.resolve(process.cwd(), ...segments);
}

/** Every non-test `.ts`/`.tsx` file under `src/`, as repo-relative POSIX paths. */
function allSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      out.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
    }
  };
  walk(repoPath("src"));
  return out.sort();
}

/**
 * Phrases that assert the STORED RECORD did not move.
 *
 * Reporting that the ATTEMPT failed is honest and is deliberately absent here:
 * "Failed to save arrival time", "Could not record this payment", "The photo
 * could not be saved" all describe the request, not the row, and every one of
 * them stays. What is banned is the second clause people reach for — "…so
 * nothing was saved" — which is a claim about the database made by the one
 * party that cannot see it.
 *
 * The separator class tolerates this repo's `"…" +\n  "…"` line-wrapped string
 * concatenation, which a plain line-based grep walks straight past — that is
 * how `restore-built-ins.tsx` kept its claim through the first sweep.
 */
const SEPARATOR = String.raw`[\s"'\`+]*`;
const OUTCOME_VERBS =
  "saved|recorded|changed|applied|sent|created|updated|deleted|removed|cancelled|canceled|submitted|made|stored|added|written|charged|refunded";
const RECORD_UNCHANGED_CLAIMS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: `"nothing was <verb>"`,
    pattern: new RegExp(
      `Nothing${SEPARATOR}(was|has${SEPARATOR}been)${SEPARATOR}(${OUTCOME_VERBS})`,
      "i",
    ),
  },
  {
    label: `"was/were not <verb>"`,
    pattern: new RegExp(
      `(was|were|has|have)${SEPARATOR}not${SEPARATOR}(been${SEPARATOR})?(${OUTCOME_VERBS})`,
      "i",
    ),
  },
  {
    label: `"not saved"`,
    pattern: new RegExp(`not${SEPARATOR}saved`, "i"),
  },
  {
    label: `"no changes were made"`,
    pattern: new RegExp(
      `no${SEPARATOR}changes?${SEPARATOR}(were|was|have${SEPARATOR}been|has${SEPARATOR}been)${SEPARATOR}(made|${OUTCOME_VERBS})`,
      "i",
    ),
  },
];

/**
 * The one place a "nothing changed" claim after a failed `fetch` is TRUE, with
 * the reason it is true. Anything added here has to survive the same question:
 * could the server have done the work and simply failed to tell us?
 */
const HONEST_CLAIMS: Array<{ file: string; reason: string; mustContain: string }> = [
  {
    file: "src/app/(admin)/admin/display/setup/display-wizard-steps.tsx",
    reason:
      "The failing fetch is the GET that READS the current module settings, " +
      "and the function returns before the PUT is ever built. No write was " +
      "attempted, so 'nothing was changed' is a fact about this client's own " +
      "control flow rather than a guess about the server's.",
    // Proof the branch really does precede the write rather than follow it.
    mustContain: "the current values must be read first",
  },
];

/**
 * Names bound to the result of a `fetch` in this file. Only a guard on one of
 * these is a network-failure branch — `if (!dirty)` in a discard-confirm is
 * not, and an earlier draft of this test reported exactly that.
 */
function fetchResultNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?fetch\s*\(/g;
  for (const match of source.matchAll(pattern)) names.add(match[1]);
  return names;
}

/**
 * The BODY of a branch, from its opening line to the brace that closes it.
 *
 * A fixed-size window overruns the branch and reads the code after it, which is
 * how an earlier draft of this test blamed a `if (!res.ok)` guard for a success
 * toast eleven lines below it. Stop at the first line at or left of the opening
 * indent that closes a block, so a finding is always inside the branch it names.
 */
function branchBody(lines: string[], start: number): string {
  const openIndent = lines[start].search(/\S/);
  const body = [lines[start]];
  for (let index = start + 1; index < lines.length && body.length < 24; index += 1) {
    const line = lines[index];
    const indent = line.search(/\S/);
    if (indent >= 0 && indent <= openIndent && /^\s*[})\]]/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/**
 * Every branch a network failure can land in: the body of a `catch`, and the
 * falsy guard that follows a `fetch(...).catch(() => null)`. Both are places
 * where the client holds no response and therefore knows nothing.
 */
function networkFailureBranches(source: string): Array<{ line: number; text: string }> {
  const lines = source.split("\n");
  const resultNames = fetchResultNames(source);
  const branches: Array<{ line: number; text: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const guarded = /^\s*if\s*\(\s*!\s*([A-Za-z_$][\w$]*)\b/.exec(line)?.[1];
    const isNetworkBranch =
      /\bcatch\b/.test(line) || (guarded !== undefined && resultNames.has(guarded));
    if (!isNetworkBranch) continue;
    branches.push({ line: index + 1, text: branchBody(lines, index) });
  }
  return branches;
}

/**
 * Blank comments so a `// this used to say "was not saved"` note is not a
 * finding, WITHOUT collapsing lines — a finding has to point at the real line
 * number or the message sends the next reader to the wrong place.
 */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? "" : line))
    .join("\n");
}

describe("unverified-write copy contract (#2668)", () => {
  it("no browser-side network-failure branch claims the stored record did not move", () => {
    const findings: string[] = [];

    for (const file of allSourceFiles()) {
      // Test helper: reads a fixed repo file under process.cwd(); the path comes
      // from the walk above, not from user input.
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const source = readFileSync(repoPath(file), "utf8");
      if (!/^\s*["']use client["']/m.test(source)) continue;
      if (!/\bfetch\s*\(/.test(source)) continue;
      if (HONEST_CLAIMS.some((allowed) => allowed.file === file)) continue;

      for (const branch of networkFailureBranches(blankComments(source))) {
        for (const claim of RECORD_UNCHANGED_CLAIMS) {
          if (!claim.pattern.test(branch.text)) continue;
          findings.push(
            `${file}:${branch.line} — a network-failure branch asserts ${claim.label}. ` +
              "The client cannot know that: `fetch` also rejects after the server " +
              "committed. Use unverifiedWriteMessage() from " +
              "src/lib/unverified-write-copy.ts, or add the file to HONEST_CLAIMS " +
              "with the reason the claim is true.",
          );
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it("each honest 'nothing changed' claim still reads before it writes", () => {
    for (const allowed of HONEST_CLAIMS) {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const source = readFileSync(repoPath(allowed.file), "utf8");
      expect(
        source.includes(allowed.mustContain),
        `${allowed.file} no longer contains "${allowed.mustContain}", so the ` +
          `reason it is allowed to claim nothing changed may no longer hold: ${allowed.reason}`,
      ).toBe(true);
    }
  });

  it("every editor fixed by #2668 says what is actually known", () => {
    // The seven surfaces the sweep changed, and the thing each one may no
    // longer claim. Named individually so a regression points at the screen it
    // broke, not just at "some file in src".
    const FIXED: Array<{
      file: string;
      outcome: string;
      /** Wording that must NOT come back. */
      bannedPhrase?: string;
      /** Machinery whose removal would quietly restore the old behaviour. */
      mustContain?: string;
    }> = [
      {
        file: "src/components/requested-room-editor.tsx",
        outcome: "your room request was saved",
        bannedPhrase: "Your room request was not saved",
      },
      {
        file: "src/components/admin/booking-manual-payment-controls.tsx",
        outcome: "this payment was recorded",
        bannedPhrase: "Nothing was recorded",
      },
      {
        file: "src/components/admin/manual-refund-task-queue.tsx",
        outcome: "this refund task was closed",
        bannedPhrase: "Nothing was changed",
      },
      {
        file: "src/app/(admin)/admin/display/templates/restore-built-ins.tsx",
        outcome: "the built-in boards were restored",
        bannedPhrase: "was changed — safe to try again",
      },
      {
        file: "src/components/admin/bed-allocation-removal-dialog.tsx",
        outcome: "the removal was applied",
        bannedPhrase: "Removal failed; nothing was removed.",
      },
      {
        file: "src/components/admin/roster-editor.tsx",
        outcome: "the roster was saved",
        // The server's own ROSTER_SERVICE_UNAVAILABLE copy is still allowed —
        // it is the side that knows — so what is pinned here is that the two
        // are separate constants and the browser has its own.
        mustContain: "const UNVERIFIED_COPY",
      },
      {
        file: "src/app/(admin)/admin/notifications/notifications-settings.tsx",
        outcome: "these notification preferences were saved",
        // "Not saved" survives for a batch the SERVER refused outright; what
        // must not come back is saying it when an outcome was never read.
        mustContain: "const allRefused",
      },
    ];

    for (const fixed of FIXED) {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const source = blankComments(readFileSync(repoPath(fixed.file), "utf8"));
      expect(
        source.includes(`"${fixed.outcome}"`),
        `${fixed.file} no longer builds its unverified message from "${fixed.outcome}"`,
      ).toBe(true);
      if (fixed.bannedPhrase !== undefined) {
        expect(
          source.includes(fixed.bannedPhrase),
          `${fixed.file} has re-grown the confident phrasing "${fixed.bannedPhrase}"`,
        ).toBe(false);
      }
      if (fixed.mustContain !== undefined) {
        expect(
          source.includes(fixed.mustContain),
          `${fixed.file} no longer has "${fixed.mustContain}", which is what keeps ` +
            "an unread outcome apart from a refusal the server reported",
        ).toBe(true);
      }
    }
  });

  it("builds the sentence the waitlist offer card shipped, byte for byte", () => {
    // #2623 T8 wrote this wording first. The shared builder has to reproduce it
    // exactly, or moving that component onto it would have changed live copy.
    expect(
      unverifiedWriteMessage(
        "this offer was confirmed",
        "Reload the booking and check its current status before trying again.",
      ),
    ).toBe(
      "The service response could not be read, so we could not verify whether this offer was confirmed. Reload the booking and check its current status before trying again.",
    );
  });
});
