// #2520 — the FamilyGroupMember.role retirement guard.
//
// #2284 removed the last authorisation READER of the column. #2520 removed every
// WRITER of it plus member-merge's vestigial `maxFamilyRole` upgrade, and then
// marked the field `@ignore` in prisma/schema.prisma. The column itself is still
// in the database, because dropping it is a CONTRACT-phase migration that is
// only old-code compatible once THIS release is the draining colour
// (docs/BLUE_GREEN_MIGRATION_POLICY.md).
//
// WHAT ACTUALLY MAKES THE DROP SAFE, and why removing the call sites was not
// enough on its own. Measured against Prisma 7.9.0 on this schema by recording
// the SQL through a driver adapter, not reasoned about:
//
//   - a static `@default("MEMBER")` is materialised CLIENT-side as a bind
//     parameter, so the column appeared in the column list of EVERY INSERT the
//     client emitted — `create`, `upsert`'s insert branch, and `createMany` —
//     even for a call that set no role and narrowed itself to
//     `select: { id: true }`. Narrowing cannot reach this: it is the write's
//     column list, not its projection;
//   - an unnarrowed `create`/`update`/`upsert`/`delete` names every scalar in
//     its implicit RETURNING, and an `include:` on the join table names every
//     scalar in its SELECT.
//
// `@ignore` removes the field from the generated client, which closes all of
// those at once: with it in place none of those SQL forms can name the column,
// and naming `role` on this delegate is a COMPILE error rather than a latent
// production error. The `@ignore` is therefore the single load-bearing fact this
// file exists to pin, and the client-shape test below is the strongest
// assertion here — it interrogates the generated client rather than the source.
//
// DIVISION OF LABOUR — do not re-implement one in the other. Narrowing of the
// `prisma.familyGroupMember.*` delegate calls themselves is enforced by
// `doomed-column-select-guard.test.ts`, which registers `familyGroupMember` in
// its NARROW_SELECT_MODELS and already walks src/, prisma/ AND scripts/ with
// create/update/upsert/delete in its PROJECTING_METHODS. THIS file covers what
// that delegate scan cannot see: the generated client's shape, the schema
// annotations, the join table reached as a NESTED RELATION, and raw SQL.
//
// DELETE THIS FILE with the CONTRACT release that drops the column, and remove
// `familyGroupMember` from the other guard's NARROW_SELECT_MODELS at the same
// time: once the field is gone from schema.prisma the compiler enforces all of
// it unconditionally.
import fs from "node:fs";
import path from "node:path";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
// scripts/ is walked because that is exactly where a survivor hid: the retired
// audit script named the column in raw fixture SQL and in a snapshot query,
// invisible to a src/+prisma/ scan (#2520 review finding).
const SCAN_DIRS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "prisma"),
  path.join(REPO_ROOT, "scripts"),
];
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
 * `delete` IS here — its RETURNING projects every scalar exactly as a `create`'s
 * does (measured), and the omission was a gap in the first version of this file.
 */
const PROJECTING_READ_METHODS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "delete",
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
 * `text` with `//` and block comments blanked out, newline-for-newline so
 * reported line numbers stay true. String and template bodies are KEPT, because
 * the raw-SQL scan needs them; the code scans below run on `codeOnly` instead.
 */
function withoutJsComments(text: string): string {
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
      out += text.slice(openedAt, i + 1);
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * `text` with comments AND string/template bodies blanked out, newline-for-
 * newline so reported line numbers stay true. Every CODE scan below runs on this
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

type SourceFile = { rel: string; text: string; raw: string };

function productionSources(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (isTestFile(rel)) continue;
      const source = fs.readFileSync(file, "utf8");
      out.push({ rel, text: codeOnly(source), raw: withoutJsComments(source) });
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
  // ---------------------------------------------------------------------------
  // The load-bearing pair: the generated client cannot name the column, and the
  // schema annotation that makes that true is still there. Everything below is
  // defence in depth behind these two.
  // ---------------------------------------------------------------------------

  it("the generated Prisma Client does not expose the retired column at all", () => {
    // This is the CONTRACT migration's actual precondition, asserted against the
    // generated client rather than inferred from the source: if the client has no
    // `role` field, no SELECT, no INSERT column list and no implicit RETURNING it
    // emits can name the column, whatever any call site does.
    const scalars = Object.keys(Prisma.FamilyGroupMemberScalarFieldEnum);
    expect(
      scalars,
      "FamilyGroupMember.role must stay `@ignore`d in prisma/schema.prisma. " +
        "Without it Prisma materialises the static @default client-side, so the " +
        "column reappears in the column list of every INSERT — even one that " +
        "sets no role and narrows itself with `select` — and the CONTRACT " +
        "`DROP COLUMN` stops being old-code compatible.",
    ).not.toContain("role");
    // Sanity: the enum is really this model's, so the assertion above is not
    // vacuously true of an empty or wrong object.
    expect(scalars).toEqual(
      expect.arrayContaining(["id", "familyGroupId", "memberId", "joinedAt"]),
    );
  });

  it("the schema keeps the column @ignore'd and marked retired", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    const model = /model FamilyGroupMember \{[\s\S]*?\n\}/.exec(schema);
    expect(model, "FamilyGroupMember model not found in schema.prisma").not.toBeNull();
    const body = model![0];
    const roleLine = /\n(\s*role\s+String[^\n]*)/.exec(body);
    if (!roleLine) {
      // The CONTRACT release landed. This whole file should go with it, along
      // with `familyGroupMember` in doomed-column-select-guard.test.ts.
      return;
    }
    expect(
      roleLine[1],
      "While FamilyGroupMember.role still exists it must carry `@ignore`, which " +
        "is what keeps it out of the generated client and therefore out of every " +
        "statement the client emits.",
    ).toContain("@ignore");
    expect(
      body,
      "While FamilyGroupMember.role still exists, the schema must keep saying " +
        "it is retired — the comment is what stops a future author treating " +
        "the column as a live signal.",
    ).toContain("RETIRED");
  });

  // ---------------------------------------------------------------------------
  // Source-level defence in depth. Narrowing of the delegate calls themselves is
  // enforced by doomed-column-select-guard.test.ts (see the header) — these
  // cover the surfaces that scan cannot reach.
  // ---------------------------------------------------------------------------

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
        "column grants nothing, and its NOT NULL DEFAULT 'MEMBER' fills it in " +
        "the database until the drop lands.",
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
        "FamilyGroupMember in its SELECT. This colour must never name the " +
        "retired column: the CONTRACT migration drops it while this colour is " +
        "still draining. Narrow the read with an explicit `select` listing only " +
        "the columns and relations it uses.",
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
  // join table is ALSO reachable as a nested relation and those reads project
  // its scalars by exactly the same rule. That blind spot is not hypothetical:
  // it is where every reader that survived #2284 was hiding (an `include` on the
  // admin family-group routes, and an explicit `role: true` in the member-facing
  // onboarding query), so it is policed here too.
  //
  // All THREE relations that reach the join table are listed. `billingMembership`
  // (FamilyGroup.billingMembership, @relation("FamilyBillingMembership")) was
  // missing from the first version of this file: the family-billing surface is
  // actively worked, `include: { billingMembership: true }` is the natural way to
  // write that read, and the harm would not surface until a deploy months later.
  const RELATION_KEYS = [
    "memberships",
    "familyGroupMemberships",
    "billingMembership",
  ] as const;

  type RelationRead = {
    rel: string;
    key: string;
    line: number;
    body: string | null;
  };

  function relationReads(): RelationRead[] {
    const found: RelationRead[] = [];
    for (const { rel, text } of productionSources()) {
      for (const key of RELATION_KEYS) {
        // Two forms project the relation: `key: { … }` and the bare `key: true`.
        // The bare form matched nothing in the first version of this file, which
        // made `include: { memberships: true }` — the cheapest possible
        // regression — invisible.
        const pattern = new RegExp(`(^|[^\\w.])${key}\\s*:\\s*(\\{|true\\b)`, "g");
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(text)) !== null) {
          const line = text.slice(0, m.index).split("\n").length;
          if (m[2] === "true") {
            // `_count: { select: { memberships: true } }` counts rows and
            // projects no scalar at all, so it is not a projection. Detect it by
            // the enclosing key rather than by position in the file.
            const lead = text.slice(Math.max(0, m.index - 40), m.index);
            if (/_count\s*:/.test(lead)) {
              pattern.lastIndex = m.index + m[0].length;
              continue;
            }
            found.push({ rel, key, line, body: null });
            pattern.lastIndex = m.index + m[0].length;
            continue;
          }
          const braceIndex = m.index + m[0].length - 1;
          const end = matchDelimiter(text, braceIndex);
          if (end === -1) continue;
          found.push({ rel, key, line, body: text.slice(braceIndex, end + 1) });
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
    expect(reads.some((r) => r.key === "billingMembership")).toBe(true);
  });

  it("no nested relation read projects the join table's scalars", () => {
    const offenders: string[] = [];
    for (const read of relationReads()) {
      const where = `${read.rel}:${read.line} (${read.key})`;
      if (read.body === null) {
        offenders.push(`${where} — bare \`: true\` projects every scalar`);
        continue;
      }
      const keys = topLevelKeys(read.body);
      // A pure filter (`{ some: … }`, `{ none: … }`, `{ every: … }`) is a WHERE
      // clause, not a projection: it selects no columns at all.
      if (keys.some((k) => ["some", "none", "every"].includes(k))) continue;
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
      "A nested `memberships` / `familyGroupMemberships` / `billingMembership` " +
        "read must narrow the join table with an explicit `select` that does not " +
        "name the retired `role` column — an `include`, or a bare `: true`, " +
        "projects every scalar, which names it.",
    ).toEqual([]);
  });

  it("no raw SQL names the retired column", () => {
    // The Prisma-client guards above are blind to `$queryRaw`/`$executeRaw` and
    // to the psql heredocs in scripts/. That is not hypothetical either: the
    // retired audit script kept a `SELECT "role" … FROM "FamilyGroupMember"`
    // snapshot query and an `INSERT … ("role") …` fixture through #2284, which a
    // src/+prisma/ delegate scan could never have seen.
    //
    // Comments are stripped, but STRING BODIES ARE NOT — that is the point, since
    // the SQL lives in them. So prose inside a SQL template literal must not
    // write the quoted identifier; say `role column`, not the quoted form.
    const offenders: string[] = [];
    for (const { rel, raw } of productionSources()) {
      const table = /"FamilyGroupMember"/g;
      let m: RegExpExecArray | null;
      while ((m = table.exec(raw)) !== null) {
        const window = raw.slice(
          Math.max(0, m.index - 500),
          Math.min(raw.length, m.index + 500),
        );
        if (/"role"/.test(window)) {
          offenders.push(`${rel}:${raw.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(
      offenders,
      'Raw SQL naming "FamilyGroupMember" must not name the retired "role" ' +
        "column: the CONTRACT migration drops it, and raw SQL is not protected " +
        "by the `@ignore` that shields every Prisma-client statement.",
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
});
