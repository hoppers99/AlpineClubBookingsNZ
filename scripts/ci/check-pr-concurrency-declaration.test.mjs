import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  REQUIRED_FIELDS,
  validateConcurrencyDeclaration,
} from "./check-pr-concurrency-declaration.mjs";
// `selectPrBody` moved to the shared PR-body module when the changelog fragment
// gate (#2452) needed the same live-body behaviour; its contract is unchanged.
// `gitDiffChangedFiles` is the shared diff invocation both gates now use.
import { gitDiffChangedFiles, selectPrBody } from "./pr-body.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A throwaway two-commit repo whose second commit adds `relPath`. `core.quotePath`
 * is pinned to git's DEFAULT (true) locally, so the `-c core.quotePath=false` in
 * `gitDiffChangedFiles` — a command-line `-c` beats local config — is the only
 * thing keeping a non-ASCII path from arriving C-quoted. The same fixture exists
 * in `check-pr-changelog-fragment.test.mjs`.
 */
function makeRepoAdding(relPath) {
  const root = mkdtempSync(join(tmpdir(), "quoted-path-gate-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.email", "gate-test@example.invalid");
  git("config", "user.name", "Gate Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.quotePath", "true");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  mkdirSync(join(root, dirname(relPath)), { recursive: true });
  writeFileSync(join(root, relPath), "export const value = 1;\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "add file");
  return root;
}

const heading = "## Concurrency And Lock Impact";
const complete = `${heading}

- Writer class(es), canonical lock key(s), and acquisition order: cancel; global -> lodge
- Immutable pre-lock key source and mutable under-lock re-read: immutable lodgeId; full re-read
- Status-guarded claim and proof that a lost claim runs no side effect: updateMany; count=0 exits
- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: #1911 uses the same lodge helper; race test passes
- Provider calls inside a transaction (write \`None\`, or justify the bounded exception from \`docs/CONCURRENCY_AND_LOCKING.md\`): None

## Residual Risks
`;

// A body that mirrors the REAL template: all five field bullets present, but
// fields 1-3 are left empty, field 4 carries only a `#number`, and field 5 has
// a value. Before the horizontal-whitespace fix, `\s` in the required-field
// regex consumed the newline after an empty bullet and captured the NEXT bullet
// line as the field value, so this bypassed the gate. It must now throw.
function blankFieldExploit(newline) {
  return [
    heading,
    "",
    "- Writer class(es), canonical lock key(s), and acquisition order:",
    "- Immutable pre-lock key source and mutable under-lock re-read:",
    "- Status-guarded claim and proof that a lost claim runs no side effect:",
    "- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: #123",
    "- Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`): None",
    "",
    "## Residual Risks",
    "",
  ].join(newline);
}

describe("PR concurrency declaration gate", () => {
  it("accepts a complete declaration with numbered compatibility evidence", () => {
    expect(() => validateConcurrencyDeclaration(complete)).not.toThrow();
  });

  it("accepts a complete declaration whose bullets use CRLF line endings", () => {
    expect(() => validateConcurrencyDeclaration(complete.replace(/\n/g, "\r\n"))).not.toThrow();
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
    // The message must NAME the offending files, or an author on a 40-file PR
    // has no way to tell which one made N/A untrue.
    expect(() =>
      validateConcurrencyDeclaration(`${heading}\n\n- [x] N/A — no impact.\n`, [
        "docs/README.md",
        "src/lib/booking-cancel.ts",
      ]),
    ).toThrow(/sensitive paths: src\/lib\/booking-cancel\.ts/);
  });

  it("rejects template placeholders and unnumbered compatibility claims", () => {
    expect(() => validateConcurrencyDeclaration(`${heading}\n\n- Writer class(es), canonical lock key(s), and acquisition order:\n`)).toThrow(
      /no value on its own line/,
    );
    expect(() =>
      validateConcurrencyDeclaration(complete.replace("#1911", "recent work")),
    ).toThrow(/PR number/);
  });

  it("rejects the real-template blank-field bypass (LF) where only field 4 is filled", () => {
    expect(() => validateConcurrencyDeclaration(blankFieldExploit("\n"))).toThrow(
      /no value on its own line/,
    );
  });

  it("rejects the real-template blank-field bypass (CRLF) where only field 4 is filled", () => {
    expect(() => validateConcurrencyDeclaration(blankFieldExploit("\r\n"))).toThrow(
      /no value on its own line/,
    );
  });

  it("finds the real heading even when the body quotes the heading text in prose", () => {
    // A PR body that EXPLAINS this gate will quote its heading. A plain indexOf
    // matches that mention first, so the section starts mid-prose, runs to the
    // next `## `, and every field reports missing while the real declaration
    // sits untouched below. Found by running this gate against its own PR body.
    const quotedFirst = [
      "Verified the error for a reworded heading:",
      "`PR body must include ## Concurrency And Lock Impact`.",
      "",
      "## Some Other Section",
      "",
      "- nothing to declare here",
      "",
      complete,
    ].join("\n");

    expect(() => validateConcurrencyDeclaration(quotedFirst)).not.toThrow();
  });

  it("does not accept a value that sits on the line after the label", () => {
    const nextLineValue = [
      heading,
      "",
      "- Writer class(es), canonical lock key(s), and acquisition order:",
      "  cancel; global -> lodge",
      "- Immutable pre-lock key source and mutable under-lock re-read: x",
      "- Status-guarded claim and proof that a lost claim runs no side effect: x",
      "- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: #1",
      "- Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`): None",
      "",
    ].join("\n");
    // The message must SAY SO. A bare "complete this field" sent an author who
    // believed the field was filled round four CI cycles re-guessing the format
    // (#2634, #2640), so the same-line rule is asserted here as part of the
    // contract rather than left as a comment in the matcher.
    expect(() => validateConcurrencyDeclaration(nextLineValue)).toThrow(
      /SAME line as the label/,
    );
    expect(() => validateConcurrencyDeclaration(nextLineValue)).toThrow(
      /npm run pr:check/,
    );
  });

  it("rejects a field whose value is only whitespace", () => {
    const whitespaceValue = complete.replace(
      "acquisition order: cancel; global -> lodge",
      "acquisition order:    ",
    );
    expect(() => validateConcurrencyDeclaration(whitespaceValue)).toThrow(
      /no value on its own line/,
    );
  });

  it("lets a test-only change check N/A even though the path name looks sensitive", () => {
    expect(() =>
      validateConcurrencyDeclaration(`${heading}\n\n- [x] N/A — test-only change.\n`, [
        "src/lib/__tests__/booking-cancel-split.test.ts",
      ]),
    ).not.toThrow();
  });

  it("still requires a full declaration when a test accompanies real sensitive source", () => {
    expect(() =>
      validateConcurrencyDeclaration(`${heading}\n\n- [x] N/A — no impact.\n`, [
        "src/lib/__tests__/booking-cancel-split.test.ts",
        "src/lib/booking-cancel.ts",
      ]),
    ).toThrow(/cannot use N\/A/);
  });

  /*
    #2726. The gate used to demand the heading UNCONDITIONALLY and only then
    consult the diff — at which point it accepted a ticked `N/A` for any PR
    touching no sensitive path. So for a non-sensitive PR it already agreed there
    was nothing to declare; it just refused to say so until the author pasted in
    a heading. Every Dependabot PR failed there permanently, because Dependabot
    writes its own body and cannot use `.github/pull_request_template.md`.

    The three tests below pin the whole enforcement boundary. Deleting the
    `diffKnown && sensitiveFiles.length === 0` short-circuit turns the first one
    red; the other two stay green either way, which is the point — they are the
    proof that the short-circuit took no enforcement with it.
  */
  it("waives a missing section for a known diff with no sensitive path (#2726)", () => {
    // A real Dependabot body: a package table, no template headings anywhere.
    const dependabotBody = [
      "Bumps [next](https://github.com/vercel/next.js) from 15.5.0 to 15.5.1.",
      "",
      "| Package | From | To |",
      "| --- | --- | --- |",
      "| next | 15.5.0 | 15.5.1 |",
      "",
    ].join("\n");

    expect(() =>
      validateConcurrencyDeclaration(dependabotBody, [
        "package.json",
        "package-lock.json",
        ".github/workflows/ci.yml",
      ]),
    ).not.toThrow();
  });

  it("still demands the section when a known diff touches a sensitive path (#2726)", () => {
    // The same bodyless PR, now bumping a dependency that also edits a payment
    // writer. This is the case the gate was written for and it must still fail.
    expect(() =>
      validateConcurrencyDeclaration("Bumps stripe from 18.0.0 to 18.1.0.", [
        "package.json",
        "src/lib/payment-settlement.ts",
      ]),
    ).toThrow(/PR body must include ## Concurrency And Lock Impact/);
  });

  it("names the sensitive files when it demands the section (#2726)", () => {
    expect(() =>
      validateConcurrencyDeclaration("no headings here", [
        "src/app/api/webhooks/stripe/route.ts",
        "docs/README.md",
      ]),
    ).toThrow(/src\/app\/api\/webhooks\/stripe\/route\.ts/);
  });

  /*
    Fail closed on an UNKNOWN diff. `changedFiles` omitted means the caller could
    not resolve one (no PR_BASE_SHA/PR_HEAD_SHA, no local merge base) — not that
    the PR changed nothing. Reading unknown as empty would hand the #2726 waiver
    to every PR the moment the diff range went missing, which is a far larger
    hole than the one #2726 closed. Deleting the `diffKnown &&` half of the
    short-circuit turns this red.
  */
  it("still demands the section when the diff is unknown rather than empty (#2726)", () => {
    expect(() => validateConcurrencyDeclaration("no headings here")).toThrow(
      /PR body must include ## Concurrency And Lock Impact/,
    );
    expect(() => validateConcurrencyDeclaration("no headings here", null)).toThrow(
      /PR body must include ## Concurrency And Lock Impact/,
    );
  });

  /*
    The sharper half of the same defect as in the changelog gate: git quotes any
    path holding a non-ASCII byte by default, so a booking/payment file named
    `src/lib/booking-café.ts` reaches this gate as `"src/lib/booking-caf\303\251.ts"`.
    `SENSITIVE_PATH` is anchored at `^src/`, so the quoted form matches nothing —
    the gate stops seeing a concurrency-sensitive change and accepts a bare
    `[x] N/A` on a PR that moves money or capacity. Real git, real accented
    filename, real diff.
  */
  it("sees a non-ASCII sensitive path instead of failing open on git's quoting", () => {
    const root = makeRepoAdding("src/lib/booking-café.ts");
    try {
      const changedFiles = gitDiffChangedFiles("HEAD~1", "HEAD", { cwd: root })
        .split(/\r?\n/)
        .filter(Boolean);
      expect(changedFiles).toEqual(["src/lib/booking-café.ts"]);
      expect(() =>
        validateConcurrencyDeclaration(
          `${heading}\n\n- [x] N/A — no impact.\n`,
          changedFiles,
        ),
      ).toThrow(/cannot use N\/A/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selectPrBody prefers a successfully fetched live body over the event payload", () => {
    expect(selectPrBody({ fetchedBody: "live", eventBody: "stale" })).toBe("live");
    // An empty fetched body still wins (fetch succeeded) so the gate fails closed.
    expect(selectPrBody({ fetchedBody: "", eventBody: "stale" })).toBe("");
  });

  it("selectPrBody falls back to the event body only when the fetch failed", () => {
    expect(selectPrBody({ fetchedBody: null, eventBody: "event" })).toBe("event");
    expect(selectPrBody({ fetchedBody: null, eventBody: undefined })).toBe("");
  });

  it("keeps REQUIRED_FIELDS labels in lockstep with the PR template bullets", () => {
    const template = readFileSync(resolve(repoRoot, ".github/pull_request_template.md"), "utf8");
    for (const field of REQUIRED_FIELDS) {
      expect(template).toContain(`- ${field}:`);
    }
  });
});
