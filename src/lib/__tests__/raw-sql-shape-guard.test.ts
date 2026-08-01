import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// #2289 — the guard that keeps raw SQL honest.
//
// `prisma.$queryRaw<SomeRow[]>` is an UNCHECKED CAST. Raw SQL returns the
// PHYSICAL column names; the type argument declares whatever the author
// believed. Nothing verifies the two agree, so where they disagreed every
// property arrived `undefined` — which silently disabled a promo redemption cap
// and a FREE_NIGHTS discount in a live deployment for months, invisible to the
// compiler (the cast) and to the tests (a mock returns the author's own wrong
// belief).
//
// The ESLint rules in `eslint.config.mjs` refuse the type argument and a
// `SELECT *` in a raw template. This file covers what a syntactic lint rule
// cannot see: WHICH statements exist, what each one is for, and whether the ones
// that actually read a result validate it. Every production raw READ must either
// go through `decodeRawRows` or appear, counted and reasoned, in
// `RAW_READ_OPT_OUTS` below — so a new one has to be classified rather than
// merely written.
//
// Advisory locks and their composition order live in
// `advisory-lock-guard.test.ts`; this file is only about result SHAPE.

const SRC_DIR = path.join(process.cwd(), "src");

/**
 * Every non-test file under `src/` that calls `$queryRaw` / `$queryRawUnsafe` —
 * the two entry points that hand back a RESULT SET and can therefore lie about
 * its shape. `$executeRaw` / `$executeRawUnsafe` return an affected-row count
 * and are immune by construction, so they are not inventoried here.
 *
 * Shrinking a count is always fine (delete the entry at zero). Adding one means
 * a new raw read: route it through `decodeRawRows` and say so here, or justify
 * an opt-out below.
 */
const RAW_READ_INVENTORY: Record<string, number> = {
  // The Sentry/observability bootstrap's connectivity probe. `SELECT 1` returns
  // one anonymous column that nothing reads; the call is awaited purely to see
  // whether the database answers at all.
  "src/instrumentation.node.ts": 1,
  // The health endpoint's liveness probe, same statement and same reasoning.
  "src/lib/health-check.ts": 1,
  // THE ONE REAL RAW READ IN THE CODEBASE, and it is validated. The rate
  // limiter's window is one atomic `INSERT … ON CONFLICT … CASE … RETURNING`
  // upsert, which Prisma cannot express and which must stay a single statement
  // or the read-modify-write race it exists to close reopens. Its result goes
  // through `decodeRawRows`.
  "src/lib/rate-limit.ts": 1,
};

/**
 * Raw reads that deliberately do NOT validate their rows, with the reason each
 * one is safe. Both are `SELECT 1` connectivity probes: they name no column, so
 * there is no column name to get wrong, and nothing reads the returned value —
 * only whether the promise settled. Wrapping them in a decoder would add a
 * schema that asserts nothing about anything anybody uses.
 *
 * They stay on `$queryRaw` rather than being converted to `$executeRaw` because
 * these are LIVENESS probes: changing how the one statement that reports
 * "database reachable" is issued is a real risk taken for a purely cosmetic
 * consistency gain.
 *
 * Anything else added here needs the same standard — the returned rows are
 * genuinely never read — and not merely an author's confidence about the shape.
 */
const RAW_READ_OPT_OUTS: Record<string, string> = {
  "src/instrumentation.node.ts": "SELECT 1 connectivity probe; no column is named or read",
  "src/lib/health-check.ts": "SELECT 1 liveness probe; no column is named or read",
};

/** Where the sanctioned decoder lives. */
const DECODER_MODULE = "src/lib/raw-sql-rows.ts";
const DECODER = "decodeRawRows";

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes(".integration.")
  );
}

/** Drop whole-line comments so a docblock discussing `$queryRaw` is not a call site. */
function codeLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      );
    })
    .join("\n");
}

/**
 * Every raw tagged-template call in `source`, with its tag, any type argument,
 * and the SQL between the backticks. Raw SQL templates in this repository never
 * nest a backtick, so the non-greedy body match is exact.
 */
function rawTemplates(
  source: string,
): { tag: string; typeArgument: string | null; sql: string }[] {
  const pattern =
    /\$(executeRaw|queryRaw)(Unsafe)?\s*(<[^>]*>)?\s*`([^`]*)`/g;
  const found: { tag: string; typeArgument: string | null; sql: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    found.push({
      tag: `$${match[1]}${match[2] ?? ""}`,
      typeArgument: match[3] ?? null,
      sql: match[4],
    });
  }
  return found;
}

const sources = walk(SRC_DIR)
  .map((file) => ({
    rel: path.relative(process.cwd(), file).split(path.sep).join("/"),
    text: fs.readFileSync(file, "utf8"),
  }))
  .filter(({ rel }) => !isTestFile(rel))
  .map(({ rel, text }) => ({ rel, text, code: codeLines(text) }));

describe("raw SQL cannot lie about its result shape (#2289)", () => {
  it("keeps every raw READ inside the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, code } of sources) {
      const count = (code.match(/\$queryRaw(Unsafe)?\b/g) ?? []).length;
      if (count > 0) found[rel] = count;
    }

    expect(
      found,
      "Raw-SQL READ sites changed. `$queryRaw`/`$queryRawUnsafe` hand back a " +
        "result set whose column names are the DATABASE's, not Prisma's, so a " +
        "name the code gets wrong arrives as `undefined` rather than as an " +
        "error (#2289). Only there for a row lock? Use `$executeRaw` on a " +
        "statement selecting a constant and read through the Prisma model. " +
        "Genuinely need the rows? Validate them with `decodeRawRows` and add " +
        "the file here.",
    ).toEqual(RAW_READ_INVENTORY);
  });

  it("validates every raw read that is not a documented opt-out", () => {
    // Derived from what is actually in the tree, not from the inventory above,
    // so a raw read added without touching either list fails here as well.
    const unvalidated = sources
      .filter(({ code }) => /\$queryRaw(Unsafe)?\b/.test(code))
      .filter(({ rel }) => !(rel in RAW_READ_OPT_OUTS))
      .filter(({ code }) => !code.includes(DECODER))
      .map(({ rel }) => rel);

    expect(
      unvalidated,
      `Raw read(s) neither validated with ${DECODER} (${DECODER_MODULE}) nor ` +
        "listed in RAW_READ_OPT_OUTS with a reason. An opt-out is only honest " +
        "when the returned rows are genuinely never read.",
    ).toEqual([]);
  });

  it("keeps the opt-out list to statements that really read nothing", () => {
    // The list is pinned as data so it cannot grow silently, and every entry is
    // re-checked against the source: a probe that starts naming columns is no
    // longer a probe.
    expect(Object.keys(RAW_READ_OPT_OUTS).sort()).toEqual(
      ["src/instrumentation.node.ts", "src/lib/health-check.ts"].sort(),
    );
    for (const rel of Object.keys(RAW_READ_OPT_OUTS)) {
      const source = sources.find((entry) => entry.rel === rel);
      expect(source, `${rel} is on the opt-out list but does not exist`).toBeDefined();
      expect(source?.code, `${rel} must still be a bare SELECT 1 probe`).toMatch(
        /SELECT 1/,
      );
      // Every opt-out must be in the inventory, so removing the statement
      // forces the list to be tidied too.
      expect(RAW_READ_INVENTORY[rel]).toBeGreaterThan(0);
    }
  });

  it("never types a raw result (the unchecked cast itself)", () => {
    const offenders: string[] = [];
    for (const { rel, code } of sources) {
      for (const template of rawTemplates(code)) {
        if (template.typeArgument) {
          offenders.push(`${rel}: ${template.tag}${template.typeArgument}`);
        }
      }
      // `$queryRawUnsafe<T>(…)` is a call, not a tagged template.
      const unsafeCast = code.match(/\$(query|execute)RawUnsafe\s*<[^>]*>\s*\(/g);
      if (unsafeCast) offenders.push(`${rel}: ${unsafeCast.join(", ")}`);
    }

    expect(
      offenders,
      "A raw-SQL result was given a type argument. That is the unchecked cast " +
        "this issue is about: it tells the compiler what the answer looks like " +
        "and verifies nothing (#2289). Use a Prisma model read, or " +
        `${DECODER}.`,
    ).toEqual([]);
  });

  it("never SELECT *s in a raw statement", () => {
    const offenders: string[] = [];
    for (const { rel, code } of sources) {
      for (const template of rawTemplates(code)) {
        if (/SELECT\s+\*/i.test(template.sql)) {
          offenders.push(`${rel}: ${template.sql.trim().slice(0, 60)}`);
        }
      }
    }

    expect(
      offenders,
      "`SELECT *` makes the returned column set whatever the database " +
        "currently has, so a migration changes the result shape with nothing " +
        "in the source to review it against (#2289). Name the columns, or " +
        "select a constant if the statement is only there for a lock.",
    ).toEqual([]);
  });

  it("takes every row lock with $executeRaw on a constant (lock raw, read typed)", () => {
    const offenders: string[] = [];
    for (const { rel, code } of sources) {
      for (const template of rawTemplates(code)) {
        if (!/FOR UPDATE/i.test(template.sql)) continue;
        if (template.tag !== "$executeRaw") {
          offenders.push(`${rel}: FOR UPDATE issued through ${template.tag}`);
        }
        if (!/^\s*SELECT\s+1\b/i.test(template.sql)) {
          offenders.push(
            `${rel}: FOR UPDATE projects columns instead of a constant — ${template.sql
              .trim()
              .slice(0, 60)}`,
          );
        }
      }
    }

    expect(
      offenders,
      "A row lock must select a CONSTANT through `$executeRaw` and read its " +
        "data back through the Prisma model under that same lock (#2289). " +
        "Projecting columns into a raw result is how booking creation ended up " +
        "reading a promo row whose column names it had guessed — silently " +
        "disabling a redemption cap and a discount. See " +
        "docs/CONCURRENCY_AND_LOCKING.md -> 'Lock raw, read typed'.",
    ).toEqual([]);
  });

  it("keeps the decoder in one place", () => {
    const definers = sources
      .filter(({ code }) => new RegExp(`function\\s+${DECODER}\\b`).test(code))
      .map(({ rel }) => rel);

    expect(
      definers,
      `${DECODER} must be defined once, in ${DECODER_MODULE}. A second copy ` +
        "drifts from the first and the guard above stops meaning anything.",
    ).toEqual([DECODER_MODULE]);
  });
});
