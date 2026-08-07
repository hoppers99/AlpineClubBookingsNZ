/**
 * The audit-writer census (#2581).
 *
 * WHY THIS EXISTS. `AuditLog.category` is the field every category-filtered
 * reader depends on — the AI Diagnostics correlation tools filter on it with
 * `category = ANY (…)`, and a row written with no category is matched by none of
 * them. #2581 found 82 production write sites that pass no category at all, and
 * the reason it took a hand census to find them is that nothing in the
 * repository could answer "how many audit writers are there, and which of them
 * omit a category?" This tool answers it, and the contract test beside it
 * (`src/lib/__tests__/audit-writer-census.test.ts`) turns the answer into a
 * gate: adding a new uncategorised audit writer fails CI with the writer named.
 *
 * WHY AN AST WALK RATHER THAN A GREP. Two measured reasons, both from the
 * censuses that came before this file:
 *
 *  - COMMENTS. `src/lib/member-guest-find-service.ts` has the string
 *    `void createStructuredAuditLog(...)` inside a docblock. A text census
 *    counts it and reports a phantom uncategorised structured writer — which is
 *    exactly the error preserved in this issue's own title. The TypeScript
 *    parser never sees a comment as a call.
 *  - NESTED KEYS. `category` appears inside `details:` and `metadata:` payloads.
 *    Only a TOP-LEVEL `category` on the event object is the column, so the walk
 *    resolves the event object and reads its own properties rather than
 *    searching the call's text.
 *
 * WHAT IS A WRITE SITE. Four forms reach the `AuditLog` table in production,
 * and all four are counted:
 *
 *  1. `logAudit(params)`                     fire-and-forget helper
 *  2. `createAuditLog(params, db?)`          awaited helper
 *  3. `createStructuredAuditLog(event, db?)` awaited structured helper
 *  4. `<client>.auditLog.create(…)`          direct Prisma write, usually with
 *                                            `buildStructuredAuditLogCreateArgs`
 *
 * The two boundary writes inside `src/lib/audit.ts` itself, and `logAudit`'s
 * internal hop into `createAuditLog`, are NOT sites: their callers are already
 * counted, and counting the boundary as well would double every row.
 *
 * `auditLog.update` / `updateMany` / `delete` / `deleteMany` do not produce a
 * row and cannot carry a category, so they are inventoried separately as
 * non-producing DML. Today the only ones are the three retention archive/prune
 * statements in `src/lib/audit-retention.ts`; the contract test pins that set so
 * a new hand-written mutation of the audit trail has to be declared.
 *
 * Run it: `npm run audit:census` prints a deterministic TSV of every site.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";

/** The module that owns the audit boundary; its own writes are not call sites. */
export const AUDIT_BOUNDARY_MODULE = "src/lib/audit.ts";

/** The named helpers a production writer calls. */
export const AUDIT_HELPER_SINKS = [
  "logAudit",
  "createAuditLog",
  "createStructuredAuditLog",
] as const;

export type AuditHelperSink = (typeof AUDIT_HELPER_SINKS)[number];

/**
 * The argument builder for a direct Prisma write. Not a sink of its own — it
 * builds `{ data: … }` for a `create` that is counted at the `create`.
 */
const STRUCTURED_ARG_BUILDER = "buildStructuredAuditLogCreateArgs";

/** Prisma `auditLog` methods that produce a row and so can carry a category. */
const ROW_PRODUCING_DML = new Set(["create", "createMany", "upsert"]);

/** Prisma `auditLog` methods that mutate or remove existing rows. */
const NON_PRODUCING_DML = new Set([
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

export type AuditWriteSink = AuditHelperSink | `auditLog.${string}`;

/**
 * What the call site says about the row's category.
 *
 *  - `literal`     one string, written verbatim: `category: "booking"`.
 *  - `conditional` a choice between string literals. The owner rule for #2581
 *                  is that category follows the affected business DOMAIN, so an
 *                  actor-based conditional is a finding, not a shape to accept
 *                  quietly — hence its own kind rather than two literals.
 *  - `forwarded`   the value is decided somewhere else: a variable, a shorthand
 *                  property, a spread, or a whole event object passed by
 *                  reference. Fail-closed — every one has to be declared.
 *  - `absent`      the event object carries no `category` key at all. This is
 *                  the population #2581 exists to close.
 */
export type AuditCategoryEvidence =
  | { kind: "literal"; value: string }
  | { kind: "conditional"; values: readonly string[] }
  | { kind: "forwarded"; expression: string }
  | { kind: "absent" };

export type AuditWriteSite = {
  /** Repo-relative POSIX path. */
  file: string;
  /**
   * A stable identity that survives a reformat and a rebase: the enclosing
   * symbol chain plus an ordinal among sites sharing it. Line numbers move —
   * PR #2618 alone moved one of these writers from line 131 to line 293 — so
   * the line is reported for convenience and never used as identity.
   */
  id: string;
  /** The enclosing function/method/variable chain, `<module>` at top level. */
  symbol: string;
  line: number;
  sink: AuditWriteSink;
  /** True for the four row-producing forms; false for non-producing DML. */
  producesRow: boolean;
  /** The `action` value when it is a plain literal, else a description. */
  action: string;
  category: AuditCategoryEvidence;
  /** True when the event object also omits `severity` and `retentionClass`. */
  omitsRetentionInputs: boolean;
  /** True when the event object names an `entityType` or `entityId`. */
  hasEntityIdentifier: boolean;
};

const SCAN_ROOTS = ["src", "scripts", "prisma"] as const;

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs)$/;

/**
 * Directories that hold no production writer. `__tests__`/`__mocks__` and the
 * Playwright tree describe writers or stub them; `generated` is output.
 */
const SKIP_DIRECTORIES = new Set([
  "__tests__",
  "__mocks__",
  "node_modules",
  "e2e",
  "generated",
  "fixtures",
  "test-utils",
]);

const SKIP_FILES = /(\.test\.|\.spec\.|\.d\.ts$)/;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function listSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      listSourceFiles(full, out);
      continue;
    }
    if (!SOURCE_EXTENSIONS.test(entry.name)) continue;
    if (SKIP_FILES.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node)) return unwrap(node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return unwrap(node.expression);
  }
  return node;
}

function literalText(node: ts.Expression): string | null {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return inner.text;
  }
  return null;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

type TopLevelProperty =
  | { kind: "assignment"; value: ts.Expression }
  | { kind: "opaque"; text: string };

/**
 * A view of an event object's OWN top-level keys, with spreads resolved as far
 * as they can be read at the call site.
 *
 * Spreads matter here for one measured reason: the deletion-rejected writer in
 * `src/app/api/admin/deletion-requests/[id]/route.ts` spreads
 * `...(suppressed ? { metadata } : {})` and passes no category. A census that
 * failed closed on any spread would report that site as "category decided
 * elsewhere" instead of as the omission it is, and the uncategorised count would
 * read 81 rather than 82 — a site quietly moved from the population that has to
 * be fixed into an allowlist. So a spread of INLINE literals (or a conditional /
 * `&&` / `??` between them) contributes its keys, exactly as
 * `exclusivity-request-write-sites.test.ts` reads its own payloads. A spread of
 * anything opaque — an identifier, a call result — still fails closed, because
 * its keys are decided somewhere a reviewer cannot see.
 */
type ResolvedObject = {
  keys: Map<string, TopLevelProperty>;
  opaqueSpread: boolean;
};

function spreadLiterals(expression: ts.Expression): ts.ObjectLiteralExpression[] | null {
  const inner = unwrap(expression);
  if (ts.isObjectLiteralExpression(inner)) return [inner];
  if (ts.isConditionalExpression(inner)) {
    const whenTrue = spreadLiterals(inner.whenTrue);
    const whenFalse = spreadLiterals(inner.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (ts.isBinaryExpression(inner)) {
    // `cond && { … }` / `value ?? { … }` — read whichever side is a literal.
    const left = spreadLiterals(inner.left);
    const right = spreadLiterals(inner.right);
    if (left && right) return [...left, ...right];
    return right ?? left;
  }
  return null;
}

function resolveObjectLiteral(literal: ts.ObjectLiteralExpression): ResolvedObject {
  const keys = new Map<string, TopLevelProperty>();
  let opaqueSpread = false;

  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name);
      if (name) keys.set(name, { kind: "assignment", value: property.initializer });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      keys.set(property.name.text, {
        kind: "opaque",
        text: property.name.text,
      });
      continue;
    }
    if (ts.isSpreadAssignment(property)) {
      const branches = spreadLiterals(property.expression);
      if (!branches) {
        opaqueSpread = true;
        continue;
      }
      for (const branch of branches) {
        const resolved = resolveObjectLiteral(branch);
        opaqueSpread = opaqueSpread || resolved.opaqueSpread;
        for (const [name, value] of resolved.keys) {
          // A key that arrives through a spread may or may not be present at
          // runtime, so its VALUE is not readable even when its name is.
          keys.set(name, { kind: "opaque", text: `spread ${name}` });
          void value;
        }
      }
    }
  }

  return { keys, opaqueSpread };
}

function findTopLevelProperty(
  resolved: ResolvedObject,
  key: string,
): TopLevelProperty | null {
  return resolved.keys.get(key) ?? null;
}

/**
 * The event/params object a write site passes, unwrapped through the structured
 * argument builder and through a Prisma `{ data: … }` envelope. Returns null
 * when the payload is not an inline literal — the `forwarded` case.
 */
function resolveEventObject(
  argument: ts.Expression | undefined,
): ts.ObjectLiteralExpression | null {
  if (!argument) return null;
  const inner = unwrap(argument);

  if (ts.isObjectLiteralExpression(inner)) {
    // A Prisma create envelope: `{ data: { … } }`.
    const data = findTopLevelProperty(resolveObjectLiteral(inner), "data");
    if (data?.kind === "assignment") {
      return resolveEventObject(data.value);
    }
    return inner;
  }

  if (ts.isCallExpression(inner)) {
    const callee = unwrap(inner.expression);
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null;
    if (name === STRUCTURED_ARG_BUILDER) {
      return resolveEventObject(inner.arguments[0]);
    }
    return null;
  }

  if (ts.isArrayLiteralExpression(inner)) {
    // `createMany({ data: [ … ] })`. One row-producing site; take the first
    // element so its category is still read, and the caller's `forwarded`
    // fallback covers a heterogeneous array.
    const [first] = inner.elements;
    return first ? resolveEventObject(first) : null;
  }

  return null;
}

function resolveCategory(
  event: ResolvedObject | null,
  fallbackExpression: string,
): AuditCategoryEvidence {
  if (!event) {
    return { kind: "forwarded", expression: fallbackExpression };
  }

  const property = findTopLevelProperty(event, "category");
  if (!property) {
    return event.opaqueSpread
      ? { kind: "forwarded", expression: "opaque spread" }
      : { kind: "absent" };
  }
  if (property.kind === "opaque") {
    return { kind: "forwarded", expression: property.text };
  }

  const value = unwrap(property.value);
  const direct = literalText(value);
  if (direct !== null) return { kind: "literal", value: direct };

  if (ts.isConditionalExpression(value)) {
    const whenTrue = literalText(value.whenTrue);
    const whenFalse = literalText(value.whenFalse);
    if (whenTrue !== null && whenFalse !== null) {
      return { kind: "conditional", values: [whenTrue, whenFalse] };
    }
  }

  return { kind: "forwarded", expression: collapse(value.getText()) };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resolveAction(event: ResolvedObject | null): string {
  if (!event) return "(forwarded)";
  const property = findTopLevelProperty(event, "action");
  if (!property) return "(none)";
  if (property.kind === "opaque") return "(forwarded)";
  const direct = literalText(property.value);
  return direct ?? `(dynamic) ${collapse(property.value.getText())}`;
}

/**
 * The enclosing symbol chain, outermost first. Named function declarations,
 * methods, classes and `const fn = …` initialisers all contribute; an anonymous
 * arrow inside one of them does not, so a reformat that wraps a call in another
 * callback does not change the identity.
 */
function symbolChain(node: ts.Node): string {
  const names: string[] = [];
  let cursor: ts.Node | undefined = node.parent;
  while (cursor) {
    if (
      (ts.isFunctionDeclaration(cursor) ||
        ts.isMethodDeclaration(cursor) ||
        ts.isClassDeclaration(cursor)) &&
      cursor.name &&
      ts.isIdentifier(cursor.name)
    ) {
      names.unshift(cursor.name.text);
    } else if (
      ts.isVariableDeclaration(cursor) &&
      ts.isIdentifier(cursor.name)
    ) {
      names.unshift(cursor.name.text);
    }
    cursor = cursor.parent;
  }
  return names.length ? names.join(".") : "<module>";
}

function sinkNameOf(call: ts.CallExpression): AuditWriteSink | null {
  const callee = unwrap(call.expression);

  if (ts.isIdentifier(callee)) {
    const name = callee.text;
    return (AUDIT_HELPER_SINKS as readonly string[]).includes(name)
      ? (name as AuditHelperSink)
      : null;
  }

  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  if (!ROW_PRODUCING_DML.has(method) && !NON_PRODUCING_DML.has(method)) {
    return null;
  }

  // `<anything>.auditLog.<method>(…)` or a destructured `auditLog.<method>(…)`.
  const receiver = unwrap(callee.expression);
  const isAuditDelegate =
    (ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === "auditLog") ||
    (ts.isIdentifier(receiver) && receiver.text === "auditLog");
  return isAuditDelegate ? (`auditLog.${method}` as AuditWriteSink) : null;
}

/**
 * True for a call the census must not count, because counting it would count the
 * same row twice: the two `db.auditLog.create` boundary writes inside
 * `src/lib/audit.ts` and `logAudit`'s own hop into `createAuditLog`.
 */
function isBoundaryOwnWrite(file: string, sink: AuditWriteSink): boolean {
  if (file !== AUDIT_BOUNDARY_MODULE) return false;
  return sink.startsWith("auditLog.") || sink === "createAuditLog";
}

/** True when the declaration of a helper is being read rather than a call. */
function isDeclarationName(call: ts.CallExpression): boolean {
  return ts.isFunctionDeclaration(call.parent) || ts.isMethodDeclaration(call.parent);
}

function scanFile(file: string, repoRoot: string): AuditWriteSite[] {
  const relativePath = toPosix(relative(repoRoot, file));
  const ast = parse(file);
  const found: AuditWriteSite[] = [];
  const ordinals = new Map<string, number>();

  eachNode(ast, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (isDeclarationName(node)) return;
    const sink = sinkNameOf(node);
    if (!sink) return;
    if (isBoundaryOwnWrite(relativePath, sink)) return;

    const method = sink.startsWith("auditLog.") ? sink.slice("auditLog.".length) : null;
    const producesRow = method === null || ROW_PRODUCING_DML.has(method);

    const literal = producesRow ? resolveEventObject(node.arguments[0]) : null;
    const event = literal ? resolveObjectLiteral(literal) : null;
    const symbol = symbolChain(node);
    const key = `${relativePath}::${symbol}`;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);

    found.push({
      file: relativePath,
      id: `${key}#${ordinal}`,
      symbol,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      sink,
      producesRow,
      action: producesRow ? resolveAction(event) : "(dml)",
      category: producesRow
        ? resolveCategory(event, collapse(node.arguments[0]?.getText() ?? "(no argument)"))
        : { kind: "absent" },
      omitsRetentionInputs:
        producesRow &&
        event !== null &&
        !findTopLevelProperty(event, "severity") &&
        !findTopLevelProperty(event, "retentionClass"),
      hasEntityIdentifier:
        producesRow &&
        event !== null &&
        (findTopLevelProperty(event, "entityType") !== null ||
          findTopLevelProperty(event, "entityId") !== null ||
          findTopLevelProperty(event, "entity") !== null),
    });
  });

  return found;
}

export type AuditWriterCensus = {
  /** Every row-producing site, sorted by id. */
  sites: readonly AuditWriteSite[];
  /** Every non-producing `auditLog` DML statement, sorted by id. */
  nonProducingDml: readonly AuditWriteSite[];
  /** Row-producing sites whose event object carries no `category` key. */
  uncategorised: readonly AuditWriteSite[];
  /** Row-producing sites whose category is decided outside the call. */
  forwarded: readonly AuditWriteSite[];
  /** Row-producing sites choosing between category literals. */
  conditional: readonly AuditWriteSite[];
  /** Literal category value to the number of sites writing it. */
  categoryCounts: Readonly<Record<string, number>>;
  /** Sink to `{ total, uncategorised }`. */
  sinkCounts: Readonly<Record<string, { total: number; uncategorised: number }>>;
  /** Files scanned, for the "did the scan actually run" assertion. */
  filesScanned: number;
};

/**
 * Walk `src/`, `scripts/` and `prisma/` and inventory every audit write.
 *
 * `prisma/` and `scripts/` are in scope because they reach the same database
 * without going through a route: a seed or an operator backfill that wrote an
 * audit row would be invisible to a `src`-only scan. Neither contributes a site
 * today, and the contract test pins that.
 */
export function scanAuditWriterCensus(
  repoRoot: string = process.cwd(),
): AuditWriterCensus {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    listSourceFiles(join(repoRoot, root), files);
  }
  files.sort();

  const all = files.flatMap((file) => scanFile(file, repoRoot));
  const byId = (a: AuditWriteSite, b: AuditWriteSite) => a.id.localeCompare(b.id);

  const sites = all.filter((site) => site.producesRow).sort(byId);
  const nonProducingDml = all.filter((site) => !site.producesRow).sort(byId);

  const categoryCounts: Record<string, number> = {};
  const sinkCounts: Record<string, { total: number; uncategorised: number }> = {};
  for (const site of sites) {
    const bucket = (sinkCounts[site.sink] ??= { total: 0, uncategorised: 0 });
    bucket.total += 1;
    if (site.category.kind === "absent") bucket.uncategorised += 1;
    if (site.category.kind === "literal") {
      categoryCounts[site.category.value] =
        (categoryCounts[site.category.value] ?? 0) + 1;
    }
  }

  return {
    sites,
    nonProducingDml,
    uncategorised: sites.filter((site) => site.category.kind === "absent"),
    forwarded: sites.filter((site) => site.category.kind === "forwarded"),
    conditional: sites.filter((site) => site.category.kind === "conditional"),
    categoryCounts,
    sinkCounts,
    filesScanned: files.length,
  };
}

/** How a site's category reads in the TSV. */
export function describeCategory(evidence: AuditCategoryEvidence): string {
  switch (evidence.kind) {
    case "literal":
      return evidence.value;
    case "conditional":
      return `conditional:${evidence.values.join("|")}`;
    case "forwarded":
      return `forwarded:${evidence.expression}`;
    case "absent":
      return "(absent)";
  }
}

const TSV_HEADER = [
  "id",
  "file",
  "symbol",
  "line",
  "sink",
  "producesRow",
  "action",
  "category",
  "omitsRetentionInputs",
  "hasEntityIdentifier",
].join("\t");

/** A deterministic TSV of the whole census, newest analysis first in id order. */
export function renderCensusTsv(census: AuditWriterCensus): string {
  const rows = [...census.sites, ...census.nonProducingDml].map((site) =>
    [
      site.id,
      site.file,
      site.symbol,
      String(site.line),
      site.sink,
      String(site.producesRow),
      site.action,
      describeCategory(site.category),
      String(site.omitsRetentionInputs),
      String(site.hasEntityIdentifier),
    ].join("\t"),
  );
  return [TSV_HEADER, ...rows].join("\n");
}

function main(): void {
  const census = scanAuditWriterCensus();
  process.stdout.write(`${renderCensusTsv(census)}\n`);
  process.stderr.write(
    [
      `files scanned:        ${census.filesScanned}`,
      `row-producing sites:  ${census.sites.length}`,
      `uncategorised:        ${census.uncategorised.length}`,
      `forwarded category:   ${census.forwarded.length}`,
      `conditional category: ${census.conditional.length}`,
      `non-producing DML:    ${census.nonProducingDml.length}`,
      `category values:      ${JSON.stringify(census.categoryCounts)}`,
      `by sink:              ${JSON.stringify(census.sinkCounts)}`,
      "",
    ].join("\n"),
  );
}

// `tsx scripts/audit/audit-writer-census.ts` runs the census; importing it (the
// contract test does) must not.
if (
  process.argv[1] &&
  toPosix(process.argv[1]).endsWith("scripts/audit/audit-writer-census.ts")
) {
  main();
}
