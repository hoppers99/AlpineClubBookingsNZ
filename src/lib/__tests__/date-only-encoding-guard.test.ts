import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import eslintConfig, {
  MANDATORY_SRC_RESTRICTIONS,
  SRC_RESTRICTION_EXEMPTIONS,
} from "../../../eslint.config.mjs";

/**
 * #2684 — the date-only ENCODING guard, second arm.
 *
 * ENFORCES INV-DATE-010 and INV-DATE-019
 * (`docs/invariants/booking-dates-and-capacity.md`), which name this file and
 * the `no-restricted-syntax` rules in `eslint.config.mjs` as their two
 * enforcement arms. Every assertion repeats the id in its failure message so
 * whoever trips one is handed the rule rather than having to go and find it
 * (#2691).
 *
 * THE TWO ARMS DIVIDE ALONG WHAT EACH CAN SEE.
 *
 * Lint sees SYNTAX, exhaustively: no file in `src/` may hand-write
 * `toISOString().slice(0, 10)` or any of its spellings. That closes the
 * duplication, and it is airtight because it needs to know nothing about the
 * value.
 *
 * It cannot see MEANING, and meaning is the whole defect. `formatDateOnly` is
 * correct for a `@db.Date` column, whose UTC midnight is the ENCODING of an NZ
 * calendar day (INV-DATE-010), and wrong for a bare `DateTime`, which is a real
 * instant whose UTC day is the PREVIOUS New Zealand day for roughly the first
 * half of every NZ day (INV-DATE-019). The two are identical in syntax. A Xero
 * invoice due date and a finance export were both a day early for exactly this
 * reason (#2697), and nothing syntactic could have told them apart.
 *
 * So this file classifies by COLUMN TYPE, read out of `prisma/schema.prisma`
 * itself, and requires every encoding of an instant — or of the raw clock — to
 * be a listed, reasoned decision rather than an accident. It also pins the lint
 * config's own composition, because flat config replaces a rule's option list
 * silently and a guard that can be deleted by a neighbouring block is not one.
 */

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// The canonical encoders
// ---------------------------------------------------------------------------

/**
 * The date-only encoders in `src/lib/date-only.ts`. Each takes a value the
 * caller asserts is a CALENDAR DAY and returns its `yyyy-MM-dd` (or `yyyy-MM`)
 * form by reading the UTC clock face — correct exactly when the assertion holds.
 *
 * `formatDateOnlyForTimeZone`, `todayDateOnlyForTimeZone` and `getTodayDateOnly`
 * are deliberately absent: those ASK the club's calendar rather than assuming
 * the value already is one, so they are the fix this guard points at, never the
 * thing it flags.
 */
const CANONICAL_ENCODERS = new Set([
  "formatDateOnly",
  "formatMonthOnly",
  "dateOnlyFromIsoString",
]);

/** The helper module itself — the sanctioned home for the raw truncation. */
const ENCODER_MODULE = "src/lib/date-only.ts";

// ---------------------------------------------------------------------------
// Reviewed exceptions
// ---------------------------------------------------------------------------

/**
 * `DateTime` columns that nevertheless hold a DATE-ONLY value, with the write
 * that proves it.
 *
 * The column type is a good first filter and not the last word. These fields
 * were declared `DateTime` without `@db.Date`, but every write pins them to UTC
 * midnight from a `yyyy-MM-dd` string, so they are calendar days living in an
 * un-annotated column — `formatDateOnly` reads back exactly the day that was
 * stored. Sending them through the club-timezone helper instead would agree on
 * every correctly-pinned row and quietly DISAGREE on a corrupt one, which is the
 * wrong way round for a value whose meaning is a plain date.
 *
 * The honest fix is to annotate the columns `@db.Date`, which is a migration and
 * a data audit rather than a lint pass; until then this list is the record of
 * which ones were checked.
 */
const DATE_ONLY_IN_DATETIME_COLUMN: Record<string, string> = {
  dateOfBirth:
    "Member.dateOfBirth — written via parseDateOnly() on the profile route and new Date('yyyy-mm-dd') on the admin/import paths; a birthday is a calendar day, never an instant",
  requestedDateOfBirth:
    "FamilyGroupJoinRequest.requestedDateOfBirth — the same date-of-birth value carried through the join request",
  childDateOfBirth:
    "FamilyGroupJoinRequest.childDateOfBirth — as above, for the child on a family join request",
  applicantDateOfBirth:
    "MemberApplication.applicantDateOfBirth — the date of birth captured on the membership application",
  joinedDate:
    "Member.joinedDate — the membership START DATE, written from a date string on the admin/import paths and from the Xero first-invoice date on the sync",
  lifeMemberDate:
    "Member.lifeMemberDate — the calendar day life membership was granted",
  validFrom:
    "PromoCode.validFrom — written via parseDateOnly() from a `dateOnlyString` schema; a promo window edge is a calendar day",
  validUntil: "PromoCode.validUntil — same window, same write",
  bookingStartFrom:
    "PromoCode.bookingStartFrom — gates on the booking's CHECK-IN, itself a `@db.Date` lodge night",
  bookingStartUntil: "PromoCode.bookingStartUntil — same gate, same write",
};

/**
 * Call sites that encode a real instant, or the raw clock, as a calendar day.
 *
 * EVERY ENTRY HERE IS A LIVE DEFECT, not a permitted pattern, and every one of
 * them is fixed by **#2834**, which lands BEFORE this branch. They are listed
 * because this branch is not yet rebased onto it and the census below is run
 * against the tree as it stands — a census that silently omitted them would look
 * like a rule that never saw them, when in fact finding them is what the rule
 * was built to do.
 *
 * THEY MUST ALL BE GONE ONCE #2834 IS IN THE BASE. Nothing needs remembering to
 * make that happen: the moment a site stops encoding an instant, the "keeps the
 * reviewed lists honest" assertion below reports its entry as stale and fails
 * until it is deleted. An enforcement change may not ship blessing the thing it
 * exists to forbid (#2684 decision 2 — the exclusion list ships EMPTY), so if
 * this map is not empty by the time the guard merges, the guard is not ready.
 *
 * WHY THEY WERE INVISIBLE. `xero-invoice-helpers` exported `formatDate`, one
 * line delegating to the canonical encoder. Roughly eighteen Xero document dates
 * reached the forbidden pattern through it, so neither a grep for the truncation
 * spellings nor #2682's regex census could see a single one. One rename defeated
 * the entire existing control. That is why this file follows wrappers — both
 * same-file and imported — rather than only inspecting call sites, and why an
 * exported bare rename is refused outright further down.
 */
const FIXED_BY_2834 = "fixed by #2834, which lands before this branch";

const KNOWN_INSTANT_ENCODING_DEFECTS: Record<string, string> = {
  // --- The raw clock as a Xero/accounting document date (INV-DATE-019). ------
  // `formatDateOnly(new Date())` is the UTC day. New Zealand runs 12-13 hours
  // ahead, so every document raised between NZ midnight and NZ midday is dated
  // YESTERDAY in Xero — across a month boundary, the wrong accounting period.
  "src/lib/membership-cancellation-xero.ts:717": `membership cancellation credit-note date — ${FIXED_BY_2834}`,
  "src/lib/membership-cancellation-xero.ts:943": `membership cancellation payment date — ${FIXED_BY_2834}`,
  "src/lib/xero-applied-credit-allocation.ts:272": `applied-credit allocation date — ${FIXED_BY_2834}`,
  "src/lib/xero-applied-credit-deallocation.ts:861": `applied-credit deallocation date — ${FIXED_BY_2834}`,
  "src/lib/xero-booking-invoices.ts:692": `booking invoice payment date — ${FIXED_BY_2834}`,
  "src/lib/xero-credit-notes.ts:264": `refund credit-note date — ${FIXED_BY_2834}`,
  "src/lib/xero-credit-notes.ts:644": `account-credit credit-note date — ${FIXED_BY_2834}`,
  "src/lib/xero-credit-notes.ts:859": `credit-note allocation date — ${FIXED_BY_2834}`,
  "src/lib/xero-entrance-fee-invoices.ts:348": `entrance-fee invoice issue date — ${FIXED_BY_2834}`,
  "src/lib/xero-entrance-fee-invoices.ts:349": `entrance-fee invoice due date (issue + 30 days) — ${FIXED_BY_2834}`,
  "src/lib/xero-invoice-payments.ts:53": `invoice payment date — ${FIXED_BY_2834}`,
  "src/lib/xero-invoice-payments.ts:134": `invoice payment date (second entry point) — ${FIXED_BY_2834}`,
  "src/lib/xero-modification-credit-notes.ts:105": `modification credit-note date — ${FIXED_BY_2834}`,
  "src/lib/xero-modification-credit-notes.ts:207": `modification credit-note allocation date — ${FIXED_BY_2834}`,
  "src/lib/xero-supplementary-invoices.ts:170": `supplementary invoice issue date — ${FIXED_BY_2834}`,
  "src/lib/xero-supplementary-invoices.ts:276": `supplementary credit-note date — ${FIXED_BY_2834}`,

  // --- A `DateTime` instant truncated to a UTC day (INV-DATE-019). ----------
  // Exactly the #2697 defect, on the two sibling documents #2697 did not reach.
  "src/lib/xero-group-settlement-invoices.ts:330": `GroupSettlement.createdAt as the settlement invoice DUE DATE — ${FIXED_BY_2834}`,
  "src/lib/xero-supplementary-invoices.ts:162": `BookingModification.createdAt as the supplementary invoice DUE DATE — ${FIXED_BY_2834}`,

  // --- OUTSIDE the #2834 family, and the one entry that will still be here ---
  // after the rebase. "Details last confirmed by X on <date>" on the profile
  // page (#2284 S3). `Member.detailsConfirmedAt` is stamped `now` when a
  // delegate confirms, so its UTC day is yesterday's for a confirmation made
  // before NZ midday — the member is shown a date one day before the one they
  // acted on. Nothing accounting-side reads it and no Xero document carries it,
  // so #2834 does not cover it; it is reported to the orchestrator for its own
  // routing and this entry carries no issue number until it has one.
  "src/lib/member-family-service.ts:515":
    "Member.detailsConfirmedAt rendered as the confirmation DAY on the profile page — REPORTED, awaiting an issue; not part of #2834",
};

/**
 * Instant-typed field names read back as a calendar day where the VALUE at that
 * site is known to be date-only, even though the column is mixed.
 */
const REVIEWED_INSTANT_READS: Record<string, string> = {
  "src/app/api/admin/members/import/route.ts:654":
    "Member.cancelledAt is mixed — the admin cancellation flow writes `now`, but the CSV import writes a parsed date-only value, and this audit-metadata line reads back the value the import itself just parsed",
};

// ---------------------------------------------------------------------------
// Prisma schema — the authority on what a field MEANS
// ---------------------------------------------------------------------------

type FieldIndex = Map<string, string[]>;

function readSchemaDateFields(): { dateOnly: FieldIndex; instant: FieldIndex } {
  const source = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const dateOnly: FieldIndex = new Map();
  const instant: FieldIndex = new Map();
  let model: string | null = null;

  for (const line of source.split("\n")) {
    const opening = line.match(/^\s*model\s+(\w+)\s*\{/);
    if (opening) {
      model = opening[1];
      continue;
    }
    if (/^\s*\}/.test(line)) {
      model = null;
      continue;
    }
    if (!model) continue;

    const field = line.match(/^\s*(\w+)\s+DateTime\??(\[\])?\s*(.*)$/);
    if (!field) continue;

    const bucket = /@db\.Date\b/.test(field[3] ?? "") ? dateOnly : instant;
    if (!bucket.has(field[1])) bucket.set(field[1], []);
    bucket.get(field[1])!.push(model);
  }

  return { dateOnly, instant };
}

const { dateOnly: DATE_ONLY_FIELDS, instant: INSTANT_FIELDS } = readSchemaDateFields();

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") {
        listSourceFiles(full, out);
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function parse(rel: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** `new Date()` / `new Date(Date.now() …)` — the raw clock. */
function isClockRead(node: ts.Node): boolean {
  if (!ts.isNewExpression(node)) return false;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "Date") return false;
  if (!node.arguments || node.arguments.length === 0) return true;
  return /\bDate\.now\(\s*\)/.test(node.arguments[0].getText());
}

/**
 * The property name a value was read from, looking through the wrappers that do
 * not change WHICH field is being read: non-null assertions, parentheses, casts,
 * a `new Date(...)` reparse, and the `??` / `||` fallbacks a nullable column is
 * usually read behind. Anything else (a local, a call result, a parameter)
 * returns null and is left alone — this guard reports what it can PROVE.
 */
function readFieldNames(node: ts.Node, depth = 0): string[] {
  if (depth > 6) return [];
  let n: ts.Node = node;
  while (
    ts.isNonNullExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n)
  ) {
    n = n.expression;
  }
  if (
    ts.isNewExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "Date" &&
    n.arguments?.length === 1 &&
    !isClockRead(n)
  ) {
    return readFieldNames(n.arguments[0], depth + 1);
  }
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...readFieldNames(n.left, depth + 1), ...readFieldNames(n.right, depth + 1)];
  }
  if (ts.isConditionalExpression(n)) {
    return [
      ...readFieldNames(n.whenTrue, depth + 1),
      ...readFieldNames(n.whenFalse, depth + 1),
    ];
  }
  if (ts.isPropertyAccessExpression(n)) return [n.name.text];
  return [];
}

/** Does this expression, or anything it falls back to, read the raw clock? */
function readsClock(node: ts.Node, depth = 0): boolean {
  if (depth > 6) return false;
  let n: ts.Node = node;
  while (
    ts.isNonNullExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n)
  ) {
    n = n.expression;
  }
  if (isClockRead(n)) return true;
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return readsClock(n.left, depth + 1) || readsClock(n.right, depth + 1);
  }
  if (ts.isConditionalExpression(n)) {
    return readsClock(n.whenTrue, depth + 1) || readsClock(n.whenFalse, depth + 1);
  }
  return false;
}

/**
 * Functions in this file that are a BARE DELEGATION to a canonical encoder —
 * `f(value) => formatDateOnly(value)`, the encoder called on the function's own
 * parameter and nothing else.
 *
 * They are resolved so a call site written through one is classified as if it
 * called the encoder directly. This is not stylistic tidiness: an alias is
 * exactly how a whole class of defects stayed invisible. `xero-invoice-helpers`
 * exported `formatDate` — one line, one delegation — and thirty-three Xero
 * document dates behind it were never seen by any date audit, sixteen of them
 * encoding the raw clock. A wrapper that ADDS meaning (`getBookingInvoiceIssueDate`,
 * which passes `booking.checkIn`, not its own parameter) is not a delegation and
 * is left alone; it is naming a decision rather than hiding one.
 */
function localEncoderAliases(sf: ts.SourceFile): {
  names: Set<string>;
  exported: string[];
} {
  const names = new Set<string>();
  const exported: string[] = [];

  /** `param`, `new Date(param)`, `param!`, `(param as Date)` — a pass-through. */
  const reducesToParam = (node: ts.Node, paramNames: Set<string>, depth = 0): boolean => {
    if (depth > 4) return false;
    let n: ts.Node = node;
    while (
      ts.isNonNullExpression(n) ||
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n)
    ) {
      n = n.expression;
    }
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "Date" &&
      n.arguments?.length === 1
    ) {
      return reducesToParam(n.arguments[0], paramNames, depth + 1);
    }
    return ts.isIdentifier(n) && paramNames.has(n.text);
  };

  /**
   * A function is a DELEGATION when what it RETURNS is a canonical-encoder call
   * handed one of its own parameters — `return formatDateOnly(value)`, or the
   * same behind the null guard a nullable column is usually read through,
   * `return value ? formatDateOnly(new Date(value)) : null`. Such a function adds
   * a name and nothing else, so its call sites read as if the encoder were never
   * involved, which is precisely how a class of defects goes unaudited.
   *
   * Three shapes are deliberately NOT delegations, because each is doing
   * something the caller would otherwise have to decide:
   *
   *  - the encoder feeds another call rather than being the result
   *    (`return parseDateOnly(formatDateOnly(value))` normalises a Xero payload
   *    date to a date-only `Date` — a conversion, not a rename);
   *  - the argument is a FIELD of the parameter rather than the parameter
   *    (`getBookingInvoiceIssueDate(booking)` passes `booking.checkIn`, which is
   *    the function asserting WHICH value is a lodge night);
   *  - the encoder result is used for something else entirely
   *    (`lockRosterDate` builds an advisory-lock key out of it).
   */
  const returnedExpressions = (body: ts.ConciseBody): ts.Expression[] => {
    if (!ts.isBlock(body)) return [body];
    const out: ts.Expression[] = [];
    const walk = (n: ts.Node) => {
      if (
        n !== body &&
        (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))
      ) {
        return;
      }
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      ts.forEachChild(n, walk);
    };
    walk(body);
    return out;
  };

  /** Every leaf a returned expression can evaluate to, through `?:`, `??`, `||`. */
  const resultLeaves = (node: ts.Expression, depth = 0): ts.Expression[] => {
    if (depth > 4) return [node];
    let n: ts.Expression = node;
    while (
      ts.isNonNullExpression(n) ||
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n)
    ) {
      n = n.expression;
    }
    if (ts.isConditionalExpression(n)) {
      return [...resultLeaves(n.whenTrue, depth + 1), ...resultLeaves(n.whenFalse, depth + 1)];
    }
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return [...resultLeaves(n.left, depth + 1), ...resultLeaves(n.right, depth + 1)];
    }
    return [n];
  };

  const NOT_A_DELEGATION = { resolvable: false, rename: false };

  const delegatedParam = (
    body: ts.ConciseBody | undefined,
    params: readonly ts.ParameterDeclaration[],
  ): { resolvable: boolean; rename: boolean } => {
    if (!body || params.length === 0) return NOT_A_DELEGATION;
    const paramNames = new Set(
      params
        .filter((p) => ts.isIdentifier(p.name))
        .map((p) => (p.name as ts.Identifier).text),
    );
    if (paramNames.size === 0) return NOT_A_DELEGATION;

    const leaves = returnedExpressions(body).flatMap((e) => resultLeaves(e));
    const isEncoderCall = (leaf: ts.Expression) =>
      ts.isCallExpression(leaf) &&
      ts.isIdentifier(leaf.expression) &&
      CANONICAL_ENCODERS.has(leaf.expression.text);

    // A null/empty guard is the only thing a RENAME may add. Anything else in
    // the result — a branch that trims a string, narrows an `unknown`, or hands
    // off to another helper — makes the function a normaliser rather than a
    // rename, and normalising is a decision worth its own name.
    const isTrivial = (leaf: ts.Expression) =>
      leaf.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(leaf) && leaf.text === "undefined") ||
      ts.isStringLiteral(leaf) ||
      ts.isNumericLiteral(leaf);

    const encoderLeaves = leaves.filter(isEncoderCall) as ts.CallExpression[];
    const passThrough = encoderLeaves.filter(
      (call) => call.arguments[0] != null && reducesToParam(call.arguments[0], paramNames),
    );

    return {
      // GENEROUS, for the census: any function that hands a caller's own value
      // to an encoder is worth following, so the receiver at its call sites gets
      // classified. Resolving one that turns out to be harmless costs a reviewed
      // list entry; failing to resolve one costs a defect nobody sees.
      resolvable: passThrough.length > 0,
      // STRICT, for the ban: only a pure rename. A normaliser earns its name.
      rename:
        encoderLeaves.length > 0 &&
        encoderLeaves.length === passThrough.length &&
        leaves.every((leaf) => isEncoderCall(leaf) || isTrivial(leaf)),
    };
  };

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

  const record = (name: string, verdict: { resolvable: boolean; rename: boolean }, exportedHere: boolean) => {
    if (verdict.resolvable) names.add(name);
    if (verdict.rename && exportedHere) exported.push(name);
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      record(node.name.text, delegatedParam(node.body, node.parameters), isExported(node));
    }
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer != null &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          record(
            d.name.text,
            delegatedParam(d.initializer.body, d.initializer.parameters),
            isExported(node),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  return { names, exported };
}

type Encoding = {
  site: string;
  kind: "clock" | "instant";
  field?: string;
  snippet: string;
};

/**
 * Resolve a module specifier to the file it names, so a wrapper imported from
 * another module can be followed. `@/x` is the `src/` alias; `./x` and `../x`
 * are relative. Anything else (a package) is not ours and returns null.
 */
function resolveModule(fromRel: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.posix.join("src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.posix.join(path.posix.dirname(fromRel), specifier);
  } else {
    return null;
  }
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (fs.existsSync(path.join(ROOT, candidate))) return candidate;
  }
  return null;
}

/** Named imports in `sf`, as `localName -> { module, importedName }`. */
function namedImports(
  sf: ts.SourceFile,
  rel: string,
): Map<string, { module: string; imported: string }> {
  const out = new Map<string, { module: string; imported: string }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const target = resolveModule(rel, st.moduleSpecifier.text);
    if (!target) continue;
    for (const element of bindings.elements) {
      out.set(element.name.text, {
        module: target,
        imported: (element.propertyName ?? element.name).text,
      });
    }
  }
  return out;
}

function scanEncodings(): { encodings: Encoding[]; exportedAliases: string[] } {
  const encodings: Encoding[] = [];
  const exportedAliases: string[] = [];

  const files = listSourceFiles(path.join(ROOT, "src")).map((file) => {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    return { rel, text, sf: parse(rel, text) };
  });

  // Pass 1 — which functions in each file hand a caller's own value to an
  // encoder. Collected for EVERY file, including the helper module, so pass 2
  // can follow one across a module boundary.
  const resolvableByFile = new Map<string, Set<string>>();
  for (const { rel, sf } of files) {
    const aliases = localEncoderAliases(sf);
    resolvableByFile.set(rel, aliases.names);
    if (rel !== ENCODER_MODULE) {
      for (const name of aliases.exported) exportedAliases.push(`${rel}: ${name}`);
    }
  }

  // Pass 2 — classify call sites, following both same-file and IMPORTED
  // wrappers. Cross-module resolution is what stops the whole exercise being
  // defeated by one rename in a neighbouring file, which is exactly how the
  // Xero `formatDate` helper hid roughly eighteen document dates from #2682's
  // census. One hop is enough: an exported BARE rename is refused outright
  // below, so the only wrappers left to follow are normalisers, and a chain of
  // those would have to be written deliberately.
  for (const { rel, text, sf } of files) {
    if (rel === ENCODER_MODULE) continue;

    const lines = text.split("\n");
    const encoders = new Set([
      ...CANONICAL_ENCODERS,
      ...(resolvableByFile.get(rel) ?? []),
    ]);
    for (const [local, source] of namedImports(sf, rel)) {
      if (resolvableByFile.get(source.module)?.has(source.imported)) encoders.add(local);
    }

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        encoders.has(node.expression.text) &&
        node.arguments.length > 0
      ) {
        const arg = node.arguments[0];
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const site = `${rel}:${line}`;
        const snippet = (lines[line - 1] ?? "").trim().slice(0, 120);

        if (readsClock(arg)) {
          encodings.push({ site, kind: "clock", snippet });
        } else {
          for (const field of readFieldNames(arg)) {
            if (INSTANT_FIELDS.has(field)) {
              encodings.push({ site, kind: "instant", field, snippet });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return { encodings, exportedAliases };
}

const { encodings: ENCODINGS, exportedAliases: EXPORTED_ALIASES } = scanEncodings();

// ---------------------------------------------------------------------------

describe("the Prisma schema is what says whether a value is a day or a moment (#2684)", () => {
  it("reads both kinds of date column out of the schema", () => {
    // A scanner's real failure mode is passing VACUOUSLY: the schema format
    // shifts, both indexes come back empty, and every assertion below goes green
    // over nothing. Pin one known member of each kind rather than only a count.
    expect(
      DATE_ONLY_FIELDS.get("checkIn"),
      "INV-DATE-010 (docs/invariants/booking-dates-and-capacity.md): " +
        "`Booking.checkIn` is the archetypal `@db.Date` lodge night. If this " +
        "guard can no longer see it, the schema parse has broken and every " +
        "classification below is meaningless.",
    ).toContain("Booking");
    expect(
      INSTANT_FIELDS.get("createdAt"),
      "INV-DATE-019: `createdAt` is the archetypal bare `DateTime` instant — " +
        "the one #2697's defect was truncating. If the instant index is empty " +
        "this guard reports nothing, whatever the code does.",
    ).toContain("Booking");
    expect(DATE_ONLY_FIELDS.size).toBeGreaterThanOrEqual(15);
    expect(INSTANT_FIELDS.size).toBeGreaterThanOrEqual(100);
  });

  it("keeps every date field name unambiguous across models", () => {
    // This guard classifies a call site by the FIELD NAME it reads, which is
    // sound only while a name means the same thing everywhere. Today no name is
    // both `@db.Date` on one model and bare `DateTime` on another. A migration
    // that introduced one would make every reading of that name a coin flip, so
    // it fails here rather than silently weakening the rule.
    const ambiguous = [...DATE_ONLY_FIELDS.keys()]
      .filter((name) => INSTANT_FIELDS.has(name))
      .map(
        (name) =>
          `${name}: @db.Date on ${DATE_ONLY_FIELDS.get(name)!.join("/")}, ` +
          `DateTime on ${INSTANT_FIELDS.get(name)!.join("/")}`,
      );

    expect(
      ambiguous,
      "INV-DATE-019: A field name is now a date-only column on one model and a " +
        "real instant on another. This guard classifies by name, so it can no " +
        "longer tell those call sites apart. Rename one side, or teach the " +
        "scanner to resolve the model.",
    ).toEqual([]);
  });
});

describe("an instant is never encoded as a calendar day by accident (#2684)", () => {
  it("finds encoder call sites at all", () => {
    // Same vacuity guard, one level up: if the AST walk stops recognising a
    // call, the two censuses below pass over an empty list.
    expect(
      ENCODINGS.length,
      "The encoder scan found NOTHING. Either every instant encoding really is " +
        "gone (in which case delete the opt-out lists too), or the walk has " +
        "stopped seeing calls and this file is now asserting nothing.",
    ).toBeGreaterThan(0);
  });

  it("routes every clock read through the club's calendar, or records why not", () => {
    const unlisted = ENCODINGS.filter((e) => e.kind === "clock")
      .filter((e) => !(e.site in KNOWN_INSTANT_ENCODING_DEFECTS))
      .map((e) => `${e.site} — ${e.snippet}`);

    expect(
      unlisted,
      "INV-DATE-019 (docs/invariants/booking-dates-and-capacity.md): " +
        "A date-only encoder was handed the RAW CLOCK. `formatDateOnly(new Date())` " +
        "is the UTC day, and New Zealand runs 12-13 hours ahead, so for roughly " +
        "the first half of every NZ day that is YESTERDAY — across a month " +
        "boundary it is the wrong accounting period. Ask the club's calendar " +
        "instead: todayDateOnlyForTimeZone() for the string, getTodayDateOnly() " +
        "for the Date (@/lib/date-only). If the site is a known defect awaiting " +
        "its own fix, add it to KNOWN_INSTANT_ENCODING_DEFECTS with the issue.",
    ).toEqual([]);
  });

  it("never truncates a DateTime column without saying why it is safe", () => {
    const unexplained = ENCODINGS.filter((e) => e.kind === "instant")
      .filter(
        (e) =>
          !(e.site in KNOWN_INSTANT_ENCODING_DEFECTS) &&
          !(e.site in REVIEWED_INSTANT_READS) &&
          !(e.field! in DATE_ONLY_IN_DATETIME_COLUMN),
      )
      .map((e) => `${e.site} — .${e.field} — ${e.snippet}`);

    expect(
      unexplained,
      "INV-DATE-019 (docs/invariants/booking-dates-and-capacity.md): " +
        "A bare `DateTime` column was encoded as a calendar day. A `@db.Date` " +
        "value may be read this way — its UTC midnight IS the encoding of an NZ " +
        "day — but a `DateTime` is a real instant, and its UTC day is the " +
        "PREVIOUS New Zealand day all morning. That is the whole of #2697. Use " +
        "formatDateOnlyForTimeZone() from @/lib/date-only, or, if the column is " +
        "one of the ones that holds a date-only value despite its type, add the " +
        "FIELD to DATE_ONLY_IN_DATETIME_COLUMN with the write that proves it.",
    ).toEqual([]);
  });

  it("keeps the reviewed lists honest against the tree", () => {
    // A list entry that no longer matches a real site is worse than no list: it
    // reads as coverage while covering nothing, and the next reader trusts it.
    const live = new Set(ENCODINGS.map((e) => e.site));
    const stale = [
      ...Object.keys(KNOWN_INSTANT_ENCODING_DEFECTS),
      ...Object.keys(REVIEWED_INSTANT_READS),
    ].filter((site) => !live.has(site));

    expect(
      stale,
      "These sites are listed as reviewed or as known defects but no longer " +
        "exist (or have moved line). If the defect is FIXED, delete the entry — " +
        "that is the list doing its job. If the code merely moved, re-anchor it.",
    ).toEqual([]);

    for (const field of Object.keys(DATE_ONLY_IN_DATETIME_COLUMN)) {
      expect(
        INSTANT_FIELDS.has(field),
        `${field} is listed as a date-only value in a DateTime column, but the ` +
          "schema no longer declares it that way. If it is now `@db.Date`, the " +
          "exception has been fixed properly — delete the entry.",
      ).toBe(true);
    }
  });

  it("lets no module hide an encoder behind an exported alias", () => {
    // `xero-invoice-helpers` exported `formatDate`, a one-line delegation to the
    // canonical encoder. Eleven modules imported it, and the thirty-three Xero
    // document dates behind it were invisible to #2682's spelling census —
    // sixteen of them encoding the raw clock straight into the club's accounts.
    // A rename is all it takes to put a class of defects back out of reach, so
    // the rename is what is banned.
    expect(
      EXPORTED_ALIASES,
      "INV-DATE-019: A module exports a bare delegation to a date-only encoder. " +
        "Callers should import the canonical helper from @/lib/date-only by its " +
        "own name, so this guard — and the next person auditing dates — can see " +
        "what is being encoded. A wrapper that adds MEANING (reading a specific " +
        "field, choosing between the date-only and club-timezone helpers) is " +
        "fine and is not what this catches.",
    ).toEqual([]);
  });
});

// Does every glob in a block's list name a TEST path?
//
// Its own named function because the subtle failure is easy to write and
// impossible to see: asserting against the JOINED label (does `files.join()`
// contain "__tests__") passes for a two-glob list whose FIRST glob is a
// production path under `src/lib` and whose second is a `__tests__` one. Such a
// block reads as a tests-only exemption and disarms the whole of `src/lib`.
// EVERY glob must qualify, never the concatenation.
function isTestOnlyGlobList(files: readonly string[]): boolean {
  return (
    files.length > 0 &&
    files.every(
      (pattern) => pattern.includes("__tests__") || pattern.includes(".test."),
    )
  );
}

describe("the lint guard cannot be dropped by a neighbouring config block (#2684)", () => {
  type Restriction = { selector: string; message: string };
  type ConfigEntry = { files?: string[]; rules?: Record<string, unknown> };

  const entries = (eslintConfig as ConfigEntry[]).filter(
    (entry) => entry?.rules?.["no-restricted-syntax"] !== undefined,
  );

  const selectorsOf = (option: unknown): Set<string> | null => {
    if (!Array.isArray(option)) return null;
    return new Set(
      option
        .slice(1)
        .map((r) => (typeof r === "string" ? r : (r as Restriction)?.selector))
        .filter((s): s is string => typeof s === "string"),
    );
  };

  const sameFiles = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((f, i) => f === b[i]);

  /** Covers production code: names a `src/` path and is not entirely tests. */
  const coversSrcProduction = (files: string[]) =>
    files.some((f) => f.startsWith("src/")) && !isTestOnlyGlobList(files);

  it("sees the config it is meant to be pinning", () => {
    // Vacuity guard. If this file stops resolving the config, every assertion
    // below iterates an empty list and reports a clean bill of health.
    expect(
      entries.length,
      "No config block sets `no-restricted-syntax`. Either the rule is gone or " +
        "this test is reading the wrong export — both are failures.",
    ).toBeGreaterThanOrEqual(4);
    expect(
      MANDATORY_SRC_RESTRICTIONS.length,
      "The mandatory restriction set is empty, so requiring it of every block " +
        "requires nothing.",
    ).toBeGreaterThan(0);
  });

  it("keeps the guards this repository has already paid for in the mandatory set", () => {
    // A FLOOR under the array, because every other assertion here measures
    // blocks AGAINST that array — deleting a restriction from it would
    // otherwise make the whole file agree that nothing is missing. Named guards
    // only: one added later needs no edit here, removing one of these does.
    const selectors = MANDATORY_SRC_RESTRICTIONS.map((r: Restriction) => r.selector);
    const required: Array<[string, RegExp]> = [
      ["#2684 date-only truncation", /toISOString\|toJSON/],
      ["#2684 ISO split on T", /'split'/],
      ["#2289 raw-SQL result cast", /queryRaw\|executeRaw/],
    ];
    for (const [label, pattern] of required) {
      expect(
        selectors.some((s) => pattern.test(s)),
        `The mandatory restriction set no longer contains the ${label} guard. ` +
          "Every other check in this file measures blocks against that set, so " +
          "removing a restriction from it silently retires the guard everywhere.",
      ).toBe(true);
    }
  });

  it("carries every mandatory restriction in every src/** production block", () => {
    // Flat config REPLACES a rule's option list; it does not merge. A block
    // added to lift ONE restriction silently takes the others down with it for
    // the files it matches, and lint still passes. This walks the RESOLVED
    // config — what ESLint actually runs — and measures each block against the
    // config's OWN mandatory array, so a guard added later is covered here
    // without this test being touched.
    const gaps: string[] = [];

    for (const entry of entries) {
      const files = entry.files ?? [];
      if (!coversSrcProduction(files)) continue;

      const exemption = SRC_RESTRICTION_EXEMPTIONS.find((e) =>
        sameFiles(e.files, files),
      );
      const omitted = new Set(
        (exemption?.omits ?? []).map((r: Restriction) => r.selector),
      );

      const selectors = selectorsOf(entry.rules!["no-restricted-syntax"]);
      if (!selectors) {
        gaps.push(
          `${JSON.stringify(files)}: sets the rule to ` +
            `${JSON.stringify(entry.rules!["no-restricted-syntax"])} over production code`,
        );
        continue;
      }
      for (const restriction of MANDATORY_SRC_RESTRICTIONS as Restriction[]) {
        if (omitted.has(restriction.selector)) continue;
        if (!selectors.has(restriction.selector)) {
          gaps.push(`${JSON.stringify(files)}: missing ${restriction.selector}`);
        }
      }
    }

    expect(
      gaps,
      "INV-DATE-019 and INV-OPS-001: An ESLint block covering `src/**` " +
        "production code drops a restriction the rest of the config relies on. " +
        "Flat config replaces the whole option list rather than merging it, so " +
        "a block written to lift one rule removes the others by omission and " +
        "lint goes green over an unguarded file. Build the value with " +
        "`srcRestrictedSyntax(...)`, or `srcRestrictedSyntaxWithout(GROUP)` " +
        "when a block genuinely cannot obey one guard — and record that in " +
        "SRC_RESTRICTION_EXEMPTIONS with a reason.",
    ).toEqual([]);
  });

  it("switches the rule off only for blocks that are entirely tests", () => {
    const disarmed = entries
      .filter((entry) => entry.rules!["no-restricted-syntax"] === "off")
      .filter((entry) => !isTestOnlyGlobList(entry.files ?? []))
      .map((entry) => JSON.stringify(entry.files));

    expect(
      disarmed,
      "A block switches `no-restricted-syntax` off over globs that are not all " +
        "test paths. Every glob in the list must be a test path — checking the " +
        "concatenation lets one production glob ride along beside a test one " +
        "and disarms every guard for it.",
    ).toEqual([]);

    // Pin the predicate itself, rather than trusting that today's config
    // happens not to contain the mixed shape.
    expect(
      isTestOnlyGlobList(["src/**/__tests__/**/*.ts", "src/**/*.test.ts"]),
    ).toBe(true);
    expect(isTestOnlyGlobList(["src/lib/**/*.ts", "src/**/__tests__/**"])).toBe(
      false,
    );
    expect(isTestOnlyGlobList([])).toBe(false);
  });

  it("keeps every exemption documented, exact, and to a named group", () => {
    const mandatory = new Set(
      (MANDATORY_SRC_RESTRICTIONS as Restriction[]).map((r) => r.selector),
    );

    for (const exemption of SRC_RESTRICTION_EXEMPTIONS) {
      expect(
        exemption.reason?.length ?? 0,
        `The exemption for ${JSON.stringify(exemption.files)} carries no reason.`,
      ).toBeGreaterThan(20);
      expect(
        exemption.omits.length,
        `The exemption for ${JSON.stringify(exemption.files)} omits nothing, so it is not an exemption.`,
      ).toBeGreaterThan(0);
      for (const restriction of exemption.omits as Restriction[]) {
        expect(
          mandatory.has(restriction.selector),
          `${JSON.stringify(exemption.files)} claims an exemption from a restriction that is not mandatory, so it is describing something already unenforced.`,
        ).toBe(true);
      }
      expect(
        entries.some((entry) => sameFiles(exemption.files, entry.files ?? [])),
        `${JSON.stringify(exemption.files)} is exempted but no block has exactly those globs. Widening a block's globs must not carry its exemption along.`,
      ).toBe(true);
    }
  });

  it("exempts only the encoder's own module from the encoding restrictions", () => {
    const exemptFromEncoding = SRC_RESTRICTION_EXEMPTIONS.filter((e) =>
      (e.omits as Restriction[]).some((r) =>
        /toISOString\|toJSON|'split'/.test(r.selector),
      ),
    ).map((e) => JSON.stringify(e.files));

    expect(
      exemptFromEncoding,
      "Only `src/lib/date-only.ts` may be exempt from the #2684 encoding " +
        "restrictions — it is where the truncation is supposed to live. Another " +
        "file needing an exemption is a site that was never classified.",
    ).toEqual([JSON.stringify(["src/lib/date-only.ts"])]);
  });
});
