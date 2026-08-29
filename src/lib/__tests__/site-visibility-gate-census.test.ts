import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * INV-CONFIG-006 is COMPLETE, not merely true today (epic #213, C16/#247).
 *
 * The invariant's load-bearing claim is not "the gate refuses UNKNOWN" — that is
 * `site-visibility-gate.test.ts`, four lines, settled. It is that **every
 * request-path writer of `ClubTheme.completedAt` asks the gate**. That claim is
 * about a set of call sites, so nothing in the type system can hold it: a third
 * route calling `markClubThemeSetupComplete` compiles perfectly, passes every
 * existing test, and publishes the club's public site from an installation
 * nothing has declared. That is the exact hazard #247 exists for, arriving
 * through a door the fix did not know about.
 *
 * So this is a census, in the shape
 * `environment-role-inference-census.test.ts` and `audit-writer-census.test.ts`
 * established: scan `src/` from disk, find the call sites, and fail closed on one
 * that is not accounted for.
 *
 * ## What it checks, exactly
 *
 * A file that CALLS `saveClubTheme(` or `markClubThemeSetupComplete(` must also
 * call `refuseSiteVisibilityWhileEnvironmentUnknown(`. It does not check the
 * order of the two, nor that the gate guards the right branch — a text census
 * cannot, and `site-style-api.test.ts` and the complete-setup route's own tests
 * pin both properties at the two known sites. What it can do, and what nothing
 * else does, is notice a THIRD site appearing.
 *
 * `saveClubTheme` publishes only when `completeSetup` is true, so a future
 * caller that never sets it would be failed here for a transition it cannot
 * perform. That is the fail-closed direction and it is on purpose: the remedy is
 * an allowance below with a reason, which makes the judgement somebody's rather
 * than nobody's. There are none today.
 *
 * ## Two things it deliberately does not see
 *
 * `prisma/seed.ts` (`SEED_THEME_COMPLETE=1`) and `e2e/helpers/setup-state.ts`
 * write the column directly, outside `src/` and outside the application. They
 * are operator and harness tools holding database credentials, pointed at a
 * database on purpose; no gate in application code could stop them. INV-CONFIG-006
 * is scoped to the REQUEST path for that reason, and both are named in the
 * invariant so "both writers" is never read as "all writers".
 *
 * `test:related` cannot select this file: it reads `src/` with `fs`, so it has
 * no import edge to the files it scans and the module graph cannot reach it. It
 * is CI-caught by design (`docs/TESTING.md`), which is why the failure message
 * hands the reader the rule instead of only the symptom.
 */

const SRC = path.resolve(process.cwd(), "src");
const EXTENSIONS = new Set([".ts", ".tsx"]);

/** The gate every request-path completion writer has to ask. */
const GATE = "refuseSiteVisibilityWhileEnvironmentUnknown";

/**
 * The two functions that can set `ClubTheme.completedAt` from application code.
 *
 * `markClubThemeSetupComplete` is the dedicated one-column transition;
 * `saveClubTheme` stamps it when its input carries `completeSetup: true`, which
 * is the legacy site-style wizard's "Finish setup" button. Both live in
 * `club-theme.ts`, which is excluded below because it DECLARES them.
 */
const COMPLETION_WRITERS = [
  "saveClubTheme",
  "markClubThemeSetupComplete",
] as const;

/**
 * A caller of a completion writer that is exempt from asking the gate, with the
 * reason it cannot perform the transition.
 *
 * Empty, and expected to stay that way. An entry here is a claim that a
 * `saveClubTheme` caller can never pass `completeSetup: true` — provable, but
 * worth writing down rather than assuming.
 */
type Allowance = { file: string; reason: string };
const ALLOWLIST: Allowance[] = [];

/**
 * Where the writers are declared. A declaration is not a call site, and the
 * lookbehind below already excludes `function saveClubTheme(`; this is asserted
 * separately so that MOVING the declarations cannot silently empty the census.
 */
const DECLARING_MODULE = "src/lib/club-theme.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      walk(full, out);
    } else if (
      EXTENSIONS.has(path.extname(name)) &&
      !/\.test\.tsx?$/.test(name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function repoRelative(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/**
 * The source with whole-line comments removed, so that PROSE naming a writer is
 * not read as a call to one.
 *
 * This matters here rather than being tidiness: three modules explain in their
 * docblocks that `saveClubTheme()` never clears `completedAt`, parentheses and
 * all, and a census that counted those would be permanently red for saying
 * something true. Whole-line only — a trailing comment after code is still
 * scanned — which keeps the stripper simple enough to be obviously correct and
 * leaves the census failing CLOSED on anything it is unsure about. The #2440
 * published-PageContent contract behaves the same way, and PR #2813 went red on
 * exactly that; rewording the comment is the remedy there and here.
 */
function withoutWholeLineComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*")
      );
    })
    .join("\n");
}

/** `name(` where `name` is not the function being declared. */
function callsFunction(source: string, name: string): boolean {
  return new RegExp(`(?<!\\bfunction\\s)\\b${name}\\s*\\(`).test(source);
}

/** Every production file under `src/` that calls a completion writer. */
function completionWriterCallSites(): string[] {
  const sites: string[] = [];
  for (const file of walk(SRC)) {
    const relative = repoRelative(file);
    if (relative === DECLARING_MODULE) continue;
    const source = withoutWholeLineComments(readFileSync(file, "utf8"));
    if (COMPLETION_WRITERS.some((writer) => callsFunction(source, writer))) {
      sites.push(relative);
    }
  }
  return sites.sort();
}

function asksTheGate(file: string): boolean {
  const source = withoutWholeLineComments(
    readFileSync(path.resolve(process.cwd(), file), "utf8"),
  );
  return callsFunction(source, GATE);
}

const REMEDY =
  `Publishing the club's public site is refused while the canonical ` +
  `environment role is UNKNOWN (INV-CONFIG-006). A caller of saveClubTheme or ` +
  `markClubThemeSetupComplete can set ClubTheme.completedAt, which is that ` +
  `transition, so it must call ${GATE}() from ` +
  `src/lib/site-visibility-gate.ts BEFORE its first write and return the ` +
  `refusal unchanged. An undeclared installation may be a copy restored from ` +
  `the club's live database, and publishing one puts a second version of the ` +
  `club's site in front of the public with no transition back that the public ` +
  `did not already see. If this caller provably cannot set completeSetup, add ` +
  `it to ALLOWLIST in ` +
  `src/lib/__tests__/site-visibility-gate-census.test.ts with the reason.`;

describe("site-visibility gate census (INV-CONFIG-006)", () => {
  it("finds the completion writers where the census believes they are declared", () => {
    // If they move, the exclusion above stops matching and this says so, rather
    // than the census quietly scanning a file that only declares them.
    const declared = readFileSync(
      path.resolve(process.cwd(), DECLARING_MODULE),
      "utf8",
    );
    for (const writer of COMPLETION_WRITERS) {
      expect(
        declared,
        `${writer} is no longer declared in ${DECLARING_MODULE}; update ` +
          `DECLARING_MODULE, or this census will scan a declaration as a call.`,
      ).toContain(`function ${writer}(`);
    }
  });

  it("still finds the two request-path writers it was written for", () => {
    // A census that finds NOTHING passes vacuously, which is the failure mode
    // every scanner of this shape has. These two are the sites #247 gated, so
    // their absence means the scan stopped working, not that the risk went away.
    expect(completionWriterCallSites()).toEqual(
      expect.arrayContaining([
        "src/app/api/admin/site-style/route.ts",
        "src/app/api/admin/site-style/complete-setup/route.ts",
      ]),
    );
  });

  it("gives every allowance a real reason", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, `${entry.file} needs a reason`).toBeGreaterThan(
        30,
      );
    }
  });

  it("has no completion writer call site that does not ask the gate", () => {
    const allowed = new Set(ALLOWLIST.map((entry) => entry.file));
    const ungated = completionWriterCallSites().filter(
      (file) => !allowed.has(file) && !asksTheGate(file),
    );

    expect(ungated, `Ungated writer of ClubTheme.completedAt. ${REMEDY}`).toEqual(
      [],
    );
  });
});
