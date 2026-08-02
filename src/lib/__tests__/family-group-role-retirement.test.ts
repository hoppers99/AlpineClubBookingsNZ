// #2520 — the FamilyGroupMember.role retirement guard.
//
// #2284 removed the last authorisation READER of the column. #2520 removed every
// WRITER of it plus member-merge's vestigial `maxFamilyRole` upgrade. The column
// itself is still in the database, because dropping it is a CONTRACT-phase
// migration that is only old-code compatible once THIS release is the draining
// colour (docs/BLUE_GREEN_MIGRATION_POLICY.md).
//
// That deferral is exactly what makes these structural tests necessary rather
// than decorative. Between now and the drop there is nothing at runtime that can
// fail when somebody re-adds `role: "ADMIN"` to a create: the column still
// exists, the write still succeeds, and no assertion anywhere would notice — the
// harm only lands later, as a production error during the deploy that drops the
// column. Prisma names every scalar of a model in an unnarrowed find's SELECT and
// in a mutation's implicit RETURNING, so the same is true of an unnarrowed read.
// Reading the source is therefore not a shortcut here; it is the only way to
// prove the precondition the CONTRACT migration will rely on.
//
// DELETE THIS FILE with the CONTRACT release that drops the column: once the
// field is gone from schema.prisma, the compiler enforces all of it.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SCAN_DIRS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "prisma")];
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma", "schema.prisma");

/** Prisma delegate methods that WRITE rows. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

/**
 * Prisma delegate methods that PROJECT scalar columns, i.e. whose SQL names
 * every scalar of the model unless the call narrows it. `count`, `aggregate` and
 * `groupBy` are deliberately absent: they project only what they are asked for.
 */
const PROJECTING_READ_METHODS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
]);

function walk(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
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

/**
 * `text` with comments and string/template bodies blanked out, newline-for-
 * newline so reported line numbers stay true. Every scan below runs on this
 * rather than raw source, for two independent reasons:
 *
 *  - a comment that names a removed symbol (explaining why it went) must not
 *    fail the guard that proves it is gone; and
 *  - a string can contain anything that looks like code. An email template in
 *    `email-message-audit-defaults.ts` literally contains the text
 *    "Included memberships: {{…}}", which a raw regex reads as a nested
 *    relation read.
 */
function codeOnly(text: string): string {
  let out = "";
  const keepNewlines = (chunk: string) => {
    for (const ch of chunk) if (ch === "\n") out += "\n";
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) break;
      keepNewlines(text.slice(i, close + 2));
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const openedAt = i;
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      keepNewlines(text.slice(openedAt, i + 1));
      continue;
    }
    out += ch;
  }
  return out;
}

type SourceFile = { rel: string; text: string };

function productionSources(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (isTestFile(rel)) continue;
      out.push({ rel, text: codeOnly(fs.readFileSync(file, "utf8")) });
    }
  }
  return out;
}

/**
 * Scan forward from `start` (the index of an opening delimiter) to its match,
 * skipping string literals, template literals and comments so a brace inside
 * `"{"` or a `// }` cannot unbalance the count. Returns the index of the closing
 * delimiter, or -1 if the source is unbalanced.
 */
function matchDelimiter(text: string, start: number): number {
  const open = text[start];
  const close = open === "(" ? ")" : open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    // Comments.
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    // String and template literals (escape-aware; template substitutions are
    // skipped wholesale, which is safe because we only need balance).
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Keys written at depth 1 of a `{ … }` object literal, i.e. the argument's own
 * keys and not those of anything nested inside it. Used so a `select:` buried in
 * a nested relation cannot be mistaken for the call narrowing itself.
 */
function topLevelKeys(objectText: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < objectText.length; i += 1) {
    const ch = objectText[i];
    if (ch === "/" && objectText[i + 1] === "/") {
      const nl = objectText.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "/" && objectText[i + 1] === "*") {
      const end = objectText.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < objectText.length && objectText[i] !== ch) {
        if (objectText[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 1) continue;
    const rest = objectText.slice(i);
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest);
    if (m) {
      keys.push(m[1]);
      i += m[0].length - 1;
    }
  }
  return keys;
}

type Call = { rel: string; method: string; args: string; line: number };

/** Every `…familyGroupMember.<method>( … )` call in production source. */
function familyGroupMemberCalls(): Call[] {
  const calls: Call[] = [];
  for (const { rel, text } of productionSources()) {
    const pattern = /familyGroupMember\s*\.\s*([A-Za-z]+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const parenIndex = m.index + m[0].length - 1;
      const end = matchDelimiter(text, parenIndex);
      expect(
        end,
        `${rel}: could not find the closing paren of familyGroupMember.${m[1]}(`,
      ).toBeGreaterThan(parenIndex);
      calls.push({
        rel,
        method: m[1],
        args: text.slice(parenIndex + 1, end),
        line: text.slice(0, m.index).split("\n").length,
      });
      pattern.lastIndex = end;
    }
  }
  return calls;
}

/** The `{ … }` object literal an argument list opens with, braces included. */
function argumentObject(args: string): string | null {
  const brace = args.indexOf("{");
  if (brace === -1) return null;
  const end = matchDelimiter(args, brace);
  if (end === -1) return null;
  return args.slice(brace, end + 1);
}

describe("#2520 FamilyGroupMember.role retirement", () => {
  it("finds the call sites it is meant to police", () => {
    // A refactor that renames the delegate, or a scan that silently walks
    // nothing, must fail here rather than vacuously passing everything below.
    const calls = familyGroupMemberCalls();
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.some((c) => WRITE_METHODS.has(c.method))).toBe(true);
    expect(calls.some((c) => PROJECTING_READ_METHODS.has(c.method))).toBe(true);
  });

  it("no production write sets `role`", () => {
    const offenders = familyGroupMemberCalls()
      .filter((c) => WRITE_METHODS.has(c.method))
      .filter((c) => /(^|[^\w.])role\s*:/.test(c.args))
      .map((c) => `${c.rel}:${c.line} (familyGroupMember.${c.method})`);
    expect(
      offenders,
      "FamilyGroupMember.role is retired (#2284/#2520) and its CONTRACT drop " +
        "assumes no deployed colour writes it. Remove the `role` key: the " +
        "column grants nothing, and the database default fills it until the " +
        "drop lands.",
    ).toEqual([]);
  });

  it("every projecting read is narrowed with an explicit top-level `select`", () => {
    const offenders: string[] = [];
    for (const call of familyGroupMemberCalls()) {
      if (!PROJECTING_READ_METHODS.has(call.method)) continue;
      const obj = argumentObject(call.args);
      const keys = obj ? topLevelKeys(obj) : [];
      const where = `${call.rel}:${call.line} (familyGroupMember.${call.method})`;
      if (!keys.includes("select")) {
        offenders.push(`${where} — no top-level \`select\``);
      } else if (keys.includes("include")) {
        offenders.push(`${where} — \`include\` alongside \`select\``);
      }
    }
    expect(
      offenders,
      "An unnarrowed (or `include`-based) read names EVERY scalar of " +
        "FamilyGroupMember in its SELECT, including the retired `role` column. " +
        "This colour must never name it: the CONTRACT migration drops the " +
        "column while this colour is still draining. Narrow the read with an " +
        "explicit `select` listing only the columns and relations it uses.",
    ).toEqual([]);
  });

  it("no production read selects `role`", () => {
    const offenders = familyGroupMemberCalls()
      .filter((c) => PROJECTING_READ_METHODS.has(c.method))
      .filter((c) => {
        const obj = argumentObject(c.args);
        if (!obj) return false;
        const selectMatch = /(^|[^\w.])select\s*:\s*\{/.exec(obj);
        if (!selectMatch) return false;
        const braceIndex = obj.indexOf("{", selectMatch.index + selectMatch[0].length - 1);
        const end = matchDelimiter(obj, braceIndex);
        if (end === -1) return false;
        return topLevelKeys(obj.slice(braceIndex, end + 1)).includes("role");
      })
      .map((c) => `${c.rel}:${c.line} (familyGroupMember.${c.method})`);
    expect(
      offenders,
      "FamilyGroupMember.role has no reader (#2284 retired the last one) and " +
        "the CONTRACT drop assumes it stays that way.",
    ).toEqual([]);
  });

  // The delegate scan above only sees `prisma.familyGroupMember.…` calls. The
  // join table is ALSO reachable as a nested relation — `memberships` from
  // FamilyGroup and `familyGroupMemberships` from Member — and those reads
  // project its scalars by exactly the same rule. That blind spot is not
  // hypothetical: it is where every reader that survived #2284 was hiding (an
  // `include` on the admin family-group routes, and an explicit `role: true` in
  // the member-facing onboarding query), so it is policed here too.
  const RELATION_KEYS = ["memberships", "familyGroupMemberships"] as const;

  function relationReads(): { rel: string; key: string; line: number; body: string }[] {
    const found: { rel: string; key: string; line: number; body: string }[] = [];
    for (const { rel, text } of productionSources()) {
      for (const key of RELATION_KEYS) {
        const pattern = new RegExp(`(^|[^\\w.])${key}\\s*:\\s*\\{`, "g");
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(text)) !== null) {
          const braceIndex = m.index + m[0].length - 1;
          const end = matchDelimiter(text, braceIndex);
          if (end === -1) continue;
          found.push({
            rel,
            key,
            line: text.slice(0, m.index).split("\n").length,
            body: text.slice(braceIndex, end + 1),
          });
          pattern.lastIndex = end;
        }
      }
    }
    return found;
  }

  it("finds the nested relation reads it is meant to police", () => {
    const reads = relationReads();
    expect(reads.length).toBeGreaterThan(20);
    expect(reads.some((r) => r.key === "memberships")).toBe(true);
    expect(reads.some((r) => r.key === "familyGroupMemberships")).toBe(true);
  });

  it("no nested relation read projects the join table's scalars", () => {
    const offenders: string[] = [];
    for (const read of relationReads()) {
      const keys = topLevelKeys(read.body);
      // A pure filter (`{ some: … }`, `{ none: … }`, `{ every: … }`) is a WHERE
      // clause, not a projection: it selects no columns at all.
      if (keys.some((k) => ["some", "none", "every"].includes(k))) continue;
      const where = `${read.rel}:${read.line} (${read.key})`;
      if (keys.includes("include")) {
        offenders.push(`${where} — \`include\` projects every scalar`);
        continue;
      }
      if (!keys.includes("select")) {
        offenders.push(`${where} — neither \`select\` nor a filter`);
        continue;
      }
      const selectMatch = /(^|[^\w.])select\s*:\s*\{/.exec(read.body);
      if (!selectMatch) continue;
      const braceIndex = read.body.indexOf("{", selectMatch.index + selectMatch[0].length - 1);
      const end = matchDelimiter(read.body, braceIndex);
      if (end === -1) continue;
      if (topLevelKeys(read.body.slice(braceIndex, end + 1)).includes("role")) {
        offenders.push(`${where} — selects the retired \`role\``);
      }
    }
    expect(
      offenders,
      "A nested `memberships` / `familyGroupMemberships` read must narrow the " +
        "join table with an explicit `select` that does not name the retired " +
        "`role` column — an `include` projects every scalar, which names it.",
    ).toEqual([]);
  });

  it("member-merge no longer carries the vestigial maxFamilyRole upgrade", () => {
    const mergeText = codeOnly(
      fs.readFileSync(path.join(REPO_ROOT, "src", "lib", "member-merge.ts"), "utf8"),
    );
    expect(mergeText).not.toContain("maxFamilyRole");
    // The whole reason it existed: promoting the surviving membership row.
    expect(mergeText).not.toMatch(/familyGroupMember\s*\.\s*update\b/);
  });

  it("the schema records the column as retired for as long as it survives", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    const model = /model FamilyGroupMember \{[\s\S]*?\n\}/.exec(schema);
    expect(model, "FamilyGroupMember model not found in schema.prisma").not.toBeNull();
    const body = model![0];
    if (!/\n\s*role\s+String/.test(body)) {
      // The CONTRACT release landed. This whole file should go with it.
      return;
    }
    expect(
      body,
      "While FamilyGroupMember.role still exists, the schema must keep saying " +
        "it is retired — the comment is what stops a future author treating " +
        "the column as a live signal.",
    ).toContain("RETIRED");
  });
});
