import { fixupConfigRules } from "@eslint/compat";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// #2264 — the three date-rendering restrictions, named so the "Number
// formatting only" block below can re-state the two date ones while dropping
// just `toLocaleString`, instead of switching the whole rule off.
//
// All three enforce INV-DATE-015 (`docs/invariants/booking-dates-and-capacity.md`),
// and each message opens with that id so whoever trips the rule is handed the
// rule it belongs to rather than only the fix (#2691).
const NO_BARE_TO_LOCALE_DATE_STRING = {
  selector:
    "CallExpression > MemberExpression.callee[property.name='toLocaleDateString']",
  message:
    "INV-DATE-015: Use formatNZDate/formatNZDateTime/formatNZLongDate/formatNZWeekdayDate/formatNZMonthYear from @/lib/nzst-date, or a module-level Intl.DateTimeFormat pinned to APP_LOCALE + APP_TIME_ZONE. A bare toLocaleDateString renders in the viewer's zone and locale (#2256, #2264).",
};

const NO_BARE_TO_LOCALE_TIME_STRING = {
  selector:
    "CallExpression > MemberExpression.callee[property.name='toLocaleTimeString']",
  message:
    "INV-DATE-015: Use formatNZTime/formatNZDateTime from @/lib/nzst-date, or a module-level Intl.DateTimeFormat pinned to APP_LOCALE + APP_TIME_ZONE. A bare toLocaleTimeString renders in the viewer's zone and locale (#2256, #2264).",
};

const NO_BARE_TO_LOCALE_STRING = {
  selector:
    "CallExpression > MemberExpression.callee[property.name='toLocaleString']",
  message:
    "INV-DATE-015: Use formatNZDateTime/formatNZDate from @/lib/nzst-date, or a module-level Intl.DateTimeFormat pinned to APP_LOCALE + APP_TIME_ZONE. A bare toLocaleString on a Date renders in the viewer's zone and locale (#2256, #2264). Formatting a NUMBER? Add the file to the Number-formatting block in this config with a one-line reason.",
};

// #2289 — the two shapes of raw SQL that can lie about their own result.
//
// `prisma.$queryRaw<SomeRow[]>` is an UNCHECKED CAST. Raw SQL returns the
// PHYSICAL column names; the type argument declares whatever the author
// believed. Nothing verifies the two agree — not the compiler (the cast silences
// it) and not the tests (a mocked Prisma returns the shape the author believed,
// which is the same wrong belief). Where they disagreed in a real deployment,
// every property arrived `undefined`: `maxRedemptionsTotal` undefined made
// `!== null` true and `n > undefined` false, so a promo's total-redemption cap
// never fired, and `freeNightsPerIndividual` undefined made `?? 0` yield zero,
// so FREE_NIGHTS promos applied no discount at booking creation while the quote
// path showed the member one. Members were quoted a discount and charged without
// it, for months, with nothing logged.
//
// The type argument IS the hazard, so it is the thing banned. It cannot tell you
// a column name is wrong — only that somebody asserted a shape without checking
// it. Two honest alternatives remain, and the message names both.
//
// BOTH CALL FORMS ARE COVERED, deliberately. Prisma accepts a raw statement as a
// tagged template (``$queryRaw`SELECT …` ``) AND as an ordinary call taking a
// composed `Prisma.Sql` (`$queryRaw(Prisma.sql`SELECT …`)`) — and the second is
// this repository's own idiom for anything longer than a one-liner
// (`src/lib/audit-retention.ts` builds its archive statements that way). A rule
// that only matched the tagged template would leave the exact banned pattern —
// typed cast, `SELECT *`, `FOR UPDATE` on a read — passing lint in the style the
// codebase already uses, which is worse than no rule because it reads as covered.
//
// Both messages enforce INV-OPS-001 (`docs/invariants/operations.md`), which
// names these rules and the census test beside them as its two enforcement arms,
// and both open with that id (#2691).
const RAW_SQL_METHOD = "/^\\$(queryRaw|executeRaw)(Unsafe)?$/";
const RESULT_CAST_MESSAGE =
  "INV-OPS-001: Do not type a raw-SQL result: `$queryRaw<T>` is an unchecked cast and a wrong column name arrives as `undefined`, not as an error (#2289). Taking a row lock? Use `$executeRaw` on a statement selecting a constant (`SELECT 1 … FOR UPDATE`) and read what you need through the Prisma model. Genuinely cannot express it as a model read? Validate the rows with `decodeRawRows` from @/lib/raw-sql-rows.";
const SELECT_STAR_MESSAGE =
  "INV-OPS-001: Do not `SELECT *` in a raw statement (#2289): the returned column set becomes whatever the database currently has, so a migration changes the result shape with nothing in the source to review. Name the columns — or, if the statement is only there for a row lock, select a constant (`SELECT 1 … FOR UPDATE`).";

// `$queryRaw<T>`…`` — the tagged-template cast.
const NO_RAW_SQL_RESULT_CAST = {
  selector: `TaggedTemplateExpression[typeArguments][tag.property.name=${RAW_SQL_METHOD}]`,
  message: RESULT_CAST_MESSAGE,
};

// `$queryRaw<T>(Prisma.sql`…`)` and `$queryRawUnsafe<T>("…")` — the same cast
// written as a call. One selector covers all four methods.
const NO_RAW_SQL_CALL_RESULT_CAST = {
  selector: `CallExpression[typeArguments][callee.property.name=${RAW_SQL_METHOD}]`,
  message: RESULT_CAST_MESSAGE,
};

// `SELECT *` in a raw statement is the same hazard one step earlier: it makes the
// returned column set whatever the DATABASE currently happens to have, so the
// statement silently changes shape when a migration does — and there is nothing
// in the source to review it against. Name the columns you actually want.
//
// Four selectors because the SQL text can reach the driver four ways, and the
// three below the first are precisely the ones the tagged-template rule missed.
const NO_SELECT_STAR_IN_RAW_SQL = {
  selector: `TaggedTemplateExpression[tag.property.name=${RAW_SQL_METHOD}] TemplateElement[value.raw=/SELECT\\s+\\*/i]`,
  message: SELECT_STAR_MESSAGE,
};

// `$queryRawUnsafe(`SELECT * …`)` — a template literal passed as an argument.
// The child combinator keeps this off `Prisma.sql`…`` arguments, which the
// composition rule below reports instead, so nothing is flagged twice.
const NO_SELECT_STAR_IN_RAW_SQL_CALL = {
  selector: `CallExpression[callee.property.name=${RAW_SQL_METHOD}] > TemplateLiteral TemplateElement[value.raw=/SELECT\\s+\\*/i]`,
  message: SELECT_STAR_MESSAGE,
};

// `$queryRawUnsafe("SELECT * …")` — a plain string argument.
const NO_SELECT_STAR_IN_RAW_SQL_STRING = {
  selector: `CallExpression[callee.property.name=${RAW_SQL_METHOD}] > Literal[value=/SELECT\\s+\\*/i]`,
  message: SELECT_STAR_MESSAGE,
};

// ``Prisma.sql`SELECT * …` `` — anchored on the composition helper rather than on
// the call, so a statement built into a variable and passed to `$queryRaw` on a
// later line is still caught. `Prisma.sql` exists only to build SQL, so there is
// no false-positive surface here.
const NO_SELECT_STAR_IN_PRISMA_SQL = {
  selector:
    'TaggedTemplateExpression[tag.object.name="Prisma"][tag.property.name="sql"] TemplateElement[value.raw=/SELECT\\s+\\*/i]',
  message: SELECT_STAR_MESSAGE,
};

// #2685 — building integer cents inline, instead of at one of the two reviewed
// money boundaries.
//
// Two different mistakes wear the same shape, `something * 100`:
//
//  1. TEXT a person typed. `Math.round(parseFloat(value) * 100)` sends a decimal
//     the person wrote through a binary double, which cannot hold most decimal
//     fractions exactly; `parseFloat` also accepts "50abc" as 50 and returns
//     `NaN` for anything it cannot read at all — and several call sites turned
//     that `NaN` into `0`, or into a `JSON.stringify` `null`, so a typo saved a
//     nightly rate of $0.00 or filed a refund appeal with no amount, silently.
//     `parseDecimalDollarsToCents` reads the digit groups as integers instead,
//     and returns `null` so the caller must show an error.
//  2. A NUMBER a provider already parsed. Xero hands over a JavaScript number,
//     so the decimal source text is gone and the exact parser cannot be used.
//     That conversion belongs at `providerAmountToCents`, the single reviewed
//     rounding boundary, not in twenty-five inline copies.
//
// THE RULE MATCHES THE COMPOSITION, NOT A FUNCTION NAME. Banning `parseFloat`
// was measured on this tree and rejected: every non-test call either already
// ended in a `* 100` (so it adds no coverage) or parses OKLCH colour tokens in
// `club-theme-schema.ts` (so it adds four false positives), and it would miss
// the `Number()`-based parser entirely.
//
// WHAT IT DELIBERATELY DOES NOT MATCH: `ratio * 100` for a percentage —
// occupancy, success rate, setup progress, Xero API budget use — and
// `Math.round(n * 100) / 100` two-decimal rounding in `src/lib/theme/`. There
// are two dozen of those and they are all legitimate; the negative fixtures in
// `money-cents-guard.test.ts` pin every shape.
//
// All of them enforce INV-MONEY-003 (`docs/invariants/money.md`) and open with
// that id, so whoever trips one is handed the rule (#2691).
const MONEY_CENTS_MESSAGE =
  "INV-MONEY-003: Do not build cents inline. Money a PERSON typed goes through parseDecimalDollarsToCents (or parseSignedDecimalDollarsToCents where a negative is a real amount) from @/lib/money-input — it parses the decimal digits exactly and returns null, which you must surface as a validation error rather than a silent $0.00. An ALREADY-NUMERIC provider amount, such as a Xero API number, goes through providerAmountToCents from @/lib/money-provider-amount, the one reviewed rounding boundary. Xero REPORT cell text, which arrives with thousands separators and accountants' bracket negatives, goes through parseProviderReportAmountToCents from the same module — the typed-money parser refuses both of those. Computing a PERCENTAGE rather than cents, or otherwise sure this rule has misfired? Add the file to MONEY_GUARD_EXEMPTIONS in eslint.config.mjs with a written reason — that list is the escape hatch and it is read by money-cents-guard.test.ts, so adding to it passes CI. Never an eslint-disable comment (#2685).";

// A numeric-parse call anywhere inside an expression that is multiplied by 100.
// The descendant combinator is what makes alternate spellings and compositions
// fail too: `(parseFloat(x) || 0) * 100` and `(Number(a) + Number(b)) * 100`
// are the same mistake as `parseFloat(x) * 100` and are all caught here, where
// a selector anchored on the operand itself would let both through.
const PARSE_CALL_SELECTORS = [
  'CallExpression[callee.name=/^(Number|parseFloat|parseInt)$/]',
  'CallExpression[callee.object.name="Number"][callee.property.name=/^(parseFloat|parseInt)$/]',
];

// A binding whose name ends in `Cents`. That suffix is not a guess about English
// — it is this repository's own money convention (INV-MONEY-001), and nothing
// ever stores a percentage in one, which is what lets this arm catch a
// conversion built from a plain variable without touching the percentages.
const CENTS_TARGET_SELECTOR =
  ':matches(VariableDeclarator[id.name=/[Cc]ents$/], AssignmentExpression[left.name=/[Cc]ents$/], AssignmentExpression[left.property.name=/[Cc]ents$/], Property[key.name=/[Cc]ents$/], PropertyDefinition[key.name=/[Cc]ents$/])';

const TIMES_100_SELECTORS = [
  'BinaryExpression[operator="*"][right.value=100]',
  'BinaryExpression[operator="*"][left.value=100]',
];

// The same multiplication, minus the one shape that is a percentage by
// construction: a DIVISION sitting directly inside it. `(calls / budget) * 100`,
// `(beds / capacity) * 100` and `(settled / limit) * 100` are ratios scaled to a
// percentage, and nothing in this repository builds cents that way — a cents
// conversion scales an amount, not a quotient. Excluding it is what lets the
// broad arm below cover the payment modules without making the obvious fix to
// `xero-api-usage.ts`'s fractional `usagePercent` illegal to write.
//
// The residue this gives up is narrow, but it is only narrow because the two
// arms below put the rest back: a quotient of PARSED TEXT scaled to cents, and a
// quotient of anything else scaled INTO a `…Cents` binding, are both still
// caught. What is genuinely given up is `(a / b) * 100` that really is money,
// built from neither typed text nor a `…Cents` destination — indistinguishable,
// by shape or by name, from the occupancy percentage two lines above it.
const TIMES_100_NOT_A_RATIO_SELECTORS = [
  'BinaryExpression[operator="*"][right.value=100]:not([left.type="BinaryExpression"][left.operator="/"])',
  'BinaryExpression[operator="*"][left.value=100]:not([right.type="BinaryExpression"][right.operator="/"])',
];

// Scaling to cents WITHOUT a `* 100` anywhere in the source.
//
//   * `c *= 100` is the compound-assignment spelling, and it escaped every arm —
//     including the broad money-module one — because there is no
//     `BinaryExpression` to match. It is the shape one refactoring step away
//     from `const c = parseFloat(raw); c *= 100;`.
//   * `x / 0.01` is `x * 100` written as a division. Dividing by a hundredth is
//     never anything else.
const SCALED_TO_CENTS_WITHOUT_TIMES_100_SELECTORS = [
  'AssignmentExpression[operator="*="][right.value=100]',
  'BinaryExpression[operator="/"][right.value=0.01]',
];

const MONEY_CENTS_RESTRICTIONS = [
  // Arm 1 — an inline numeric parse scaled to cents.
  ...TIMES_100_SELECTORS.flatMap((times100) =>
    PARSE_CALL_SELECTORS.map((parseCall) => `${times100} ${parseCall}`),
  ),
  // Arm 2 — a unary `+` coercion scaled to cents (`+input * 100`).
  'BinaryExpression[operator="*"][right.value=100][left.type="UnaryExpression"][left.operator="+"]',
  'BinaryExpression[operator="*"][left.value=100][right.type="UnaryExpression"][right.operator="+"]',
  // Arm 3 — anything scaled to cents ON THE WAY INTO a `…Cents` binding, MINUS
  // the two shapes arms 1 and 2 have already reported. `parseFloat(raw) * 100`
  // and `parseFloat(raw)` begin at the same column, so without these exclusions
  // the commonest real mistake printed the identical message twice at the
  // identical line:column, and a 25-site regression printed fifty of them
  // (#2685 review). The exclusions mirror arms 1 and 2 exactly — a parse call
  // anywhere inside, or a unary `+` as the scaled operand — so nothing stops
  // being reported, it is reported once.
  ...[
    `BinaryExpression[operator="*"][right.value=100]:not(:has(:matches(${PARSE_CALL_SELECTORS.join(", ")}))):not([left.type="UnaryExpression"][left.operator="+"])`,
    `BinaryExpression[operator="*"][left.value=100]:not(:has(:matches(${PARSE_CALL_SELECTORS.join(", ")}))):not([right.type="UnaryExpression"][right.operator="+"])`,
  ].map((times100) => `${CENTS_TARGET_SELECTOR} ${times100}`),
  // Arm 5 — the two spellings that carry no `* 100` at all.
  ...SCALED_TO_CENTS_WITHOUT_TIMES_100_SELECTORS,
].map((selector) => ({ selector, message: MONEY_CENTS_MESSAGE }));

// Inside the money-domain modules themselves, a bare `x * 100` is a cents
// conversion and nothing else — these files compute no occupancy percentages and
// no theme ratios, which is exactly why the broad selector is safe here and
// nowhere else. This is the arm that catches a fresh
// `return Math.round(invoice.total * 100)` written straight into a Xero module,
// and equally `const d = parseFloat(raw); const c = Math.round(d * 100);`, which
// the shape-based arms above cannot see because the parse and the scaling are in
// different statements.
//
// WHAT THE BROAD ARM DOES AND DOES NOT COVER — stated exactly, because getting
// this wrong is what opened a hole. It covers arms 1–3 for ANY `x * 100` whose
// scaled operand is not a division: whatever `x` is, the broad selector already
// matches the same node, so re-stating the narrower arms for that shape would
// only report one mistake two and three times over. It does NOT cover the shape
// its own `:not(...)` exclusion removes — a division sitting inside the
// multiplication — and there the narrower arms are the only cover there ever
// was. Both arms below put that back:
//
//   * RATIO_OF_PARSE_SELECTORS — a quotient of PARSED TEXT scaled to cents,
//     `(parseFloat(gross) / 1.15) * 100` (GST-exclusive), `(parseFloat(raw) /
//     guests) * 100` (per-guest share), `(parseFloat(line.total) / line.qty) *
//     100` (unit price). Every one of those is money built from typed text, and
//     without this arm all three converted unguarded in every money module and
//     every API route while the identical line was caught in an ordinary
//     `src/lib` file — the guard at its weakest exactly where money lives.
//   * RATIO_INTO_CENTS_SELECTORS — a quotient of anything else scaled INTO a
//     `…Cents` binding, where the repository's own naming convention says the
//     result is money.
//
// A ratio with NEITHER a parse inside it nor a `…Cents` destination stays legal,
// which is the whole point of the exclusion: `(calls / budget) * 100` and
// `(beds / capacity) * 100` are percentages, and they are spelled this way
// inside these very files.
const PARSE_CALL_MATCHES = `:matches(${PARSE_CALL_SELECTORS.join(", ")})`;

const RATIO_OF_PARSE_SELECTORS = [
  `BinaryExpression[operator="*"][right.value=100][left.type="BinaryExpression"][left.operator="/"] ${PARSE_CALL_MATCHES}`,
  `BinaryExpression[operator="*"][left.value=100][right.type="BinaryExpression"][right.operator="/"] ${PARSE_CALL_MATCHES}`,
];

// The same exclusion arm 3 carries, and for the same reason: a parse anywhere
// inside the quotient is reported by the arm above, anchored on the parse call.
// Without it, `const amountCents = Math.round((parseFloat(x) / n) * 100);`
// printed the identical message twice — once at the multiplication and once at
// the parse one column along — which is the duplicate-reporting defect the
// earlier review already made this config fix once (#2685 review).
const RATIO_INTO_CENTS_SELECTORS = [
  `${CENTS_TARGET_SELECTOR} BinaryExpression[operator="*"][right.value=100][left.type="BinaryExpression"][left.operator="/"]:not(:has(${PARSE_CALL_MATCHES}))`,
  `${CENTS_TARGET_SELECTOR} BinaryExpression[operator="*"][left.value=100][right.type="BinaryExpression"][right.operator="/"]:not(:has(${PARSE_CALL_MATCHES}))`,
];

const MONEY_MODULE_RESTRICTIONS = [
  ...TIMES_100_NOT_A_RATIO_SELECTORS,
  ...RATIO_OF_PARSE_SELECTORS,
  ...RATIO_INTO_CENTS_SELECTORS,
  ...SCALED_TO_CENTS_WITHOUT_TIMES_100_SELECTORS,
].map((selector) => ({ selector, message: MONEY_CENTS_MESSAGE }));

/**
 * The two money arm families as bare selector strings, for
 * `money-cents-guard.test.ts`.
 *
 * The suite resolves this config through ESLint's own
 * `calculateConfigForFile()` at a roster of real production paths and checks the
 * resolved rule still carries every selector the family declares. It reads them
 * from HERE rather than from a copy, because a copied list passes happily while
 * the config that ships has dropped the rule — which is the whole failure mode
 * this file's guards exist to prevent. The suite pins a floor on the LENGTH of
 * each family, and its lint-a-real-fixture cases pin the behaviour, so emptying
 * one of these arrays does not quietly empty the expectation with it.
 */
export const MONEY_GUARD_ARMS = {
  standard: MONEY_CENTS_RESTRICTIONS.map((entry) => entry.selector),
  moneyModule: MONEY_MODULE_RESTRICTIONS.map((entry) => entry.selector),
};

/**
 * THE ESCAPE HATCH, and the only one. Each entry lifts the money restrictions
 * from one path and states in writing why that path is allowed to build cents
 * itself. There are no `eslint-disable` comments for this rule, and a new entry
 * here should be read as a site that was never classified.
 *
 * `money-cents-guard.test.ts` reads THIS array rather than a copy of it, and
 * fails on an entry with no reason — so the instruction the rule's own message
 * gives ("add the file with a written reason") is a move that actually passes
 * CI. It did not used to be: the test hard-coded the two helper paths, so a
 * developer told to add a third had no legal option at all (#2685 review).
 */
export const MONEY_GUARD_EXEMPTIONS = [
  {
    file: "src/lib/money-input.ts",
    reason:
      "The canonical exact text parser. It combines the integer dollar and cent groups with `dollars * 100 + cents`, which is the arithmetic every other file is being sent here to use.",
  },
  {
    file: "src/lib/money-provider-amount.ts",
    reason:
      "The reviewed provider boundary. It owns `Math.round(value * 100)` for already-numeric amounts, and the documented legacy float fallback for a Xero report cell whose magnitude falls outside the canonical grammar.",
  },
];

const MONEY_HELPER_MODULES = MONEY_GUARD_EXEMPTIONS.map((entry) => entry.file);

// Where a bare `x * 100` is money by construction.
//
// The families are matched by PREFIX so the guard follows the code through an
// ordinary rename or a split into a directory — the earlier hand-written list
// missed `src/lib/xero.ts` (the facade: `xero-*` does not match `xero`), had no
// `/**` form for `membership-cancellation-*` although the other two families
// did, and matched `.ts` only, so moving one module to `.tsx` would have dropped
// it silently (#2685 review).
//
// The named modules are the rest of the money surface the census found: the
// payment, credit, promo, fee, invoice and pricing modules, plus every API
// route, all of which convert money and none of which computes a percentage.
// `src/lib/admin-payments-service.ts` is the one the issue itself calls
// "invisible to any rule keyed off parseFloat or Math.round" — it is visible to
// this arm.
//
// Still deliberately NOT here: the Xero ADMIN SCREENS under
// `src/app/(admin)/admin/xero/`, which render API-budget percentages with the
// same `usagePercent * 100` shape, and are correct.
const MONEY_DOMAIN_MODULES = [
  "src/lib/xero.ts",
  "src/lib/xero-*.{ts,tsx}",
  "src/lib/xero-*/**/*.{ts,tsx}",
  "src/lib/finance-*.{ts,tsx}",
  "src/lib/finance-*/**/*.{ts,tsx}",
  "src/lib/membership-cancellation-*.{ts,tsx}",
  "src/lib/membership-cancellation-*/**/*.{ts,tsx}",
  "src/lib/*payment*.{ts,tsx}",
  "src/lib/*credit*.{ts,tsx}",
  "src/lib/*refund*.{ts,tsx}",
  "src/lib/*promo*.{ts,tsx}",
  "src/lib/*fee*.{ts,tsx}",
  "src/lib/*invoice*.{ts,tsx}",
  "src/lib/*subscription*.{ts,tsx}",
  "src/lib/pricing.ts",
  "src/lib/stripe.ts",
  "src/lib/stripe-*.{ts,tsx}",
  "src/app/api/**/*.{ts,tsx}",
];

// Flat config REPLACES a rule's whole option list rather than merging it, so
// every block that sets `no-restricted-syntax` for its own reasons has to
// re-state these. Keeping them in one array is what stops a future exemption
// block from silently dropping the raw-SQL guard along with the rule it meant to
// lift (#2289).
const RAW_SQL_RESTRICTIONS = [
  NO_RAW_SQL_RESULT_CAST,
  NO_RAW_SQL_CALL_RESULT_CAST,
  NO_SELECT_STAR_IN_RAW_SQL,
  NO_SELECT_STAR_IN_RAW_SQL_CALL,
  NO_SELECT_STAR_IN_RAW_SQL_STRING,
  NO_SELECT_STAR_IN_PRISMA_SQL,
];

// The same hazard, one rule later: every block below that sets
// `no-restricted-syntax` must re-state the money restrictions as well, or the
// block silently lifts them along with whatever it meant to lift.
// `src/lib/__tests__/money-cents-guard.test.ts` fails the build if one ever
// does (#2685).

const eslintConfig = defineConfig([
  ...fixupConfigRules(nextVitals),
  ...fixupConfigRules(nextTs),
  {
    rules: {
      // The current admin/lodge UI relies on effect-driven fetch/reset flows.
      // Enabling these rules would require a broad React refactor rather than
      // a lint-only cleanup pass.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
    },
  },
  {
    files: ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // The Xero subsystem's internal modules must depend on the focused domain
    // module that owns each symbol, not on the `@/lib/xero` compatibility
    // facade (which exists only for external callers). Importing the facade
    // from within `src/lib/xero-*` hides the real dependency graph and invites
    // import cycles (#1208). The exact-path match here does NOT fire on the
    // `@/lib/xero-*` domain modules — only on the bare facade path. The glob
    // also covers subsystem split directories such as `src/lib/xero-inbound/`
    // (#1270) so the guard follows the code into its new home; `../xero` is the
    // relative facade path seen from those nested modules.
    files: ["src/lib/xero-*.ts", "src/lib/xero-*/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/xero",
              message:
                "xero-* modules must import the source domain module directly, not the @/lib/xero compatibility facade (#1208).",
            },
            {
              name: "./xero",
              message:
                "xero-* modules must import the source domain module directly, not the @/lib/xero compatibility facade (#1208).",
            },
            {
              name: "../xero",
              message:
                "xero-* modules must import the source domain module directly, not the @/lib/xero compatibility facade (#1208).",
            },
          ],
        },
      ],
    },
  },
  {
    // #2264 — every rendered date and time must go through the NZ-pinned
    // helpers in `src/lib/nzst-date.ts` (`formatNZDate`, `formatNZDateTime`,
    // `formatNZLongDate`, `formatNZTime`, `formatNZMonthYear`,
    // `formatNZWeekdayDate`). A bare `toLocaleDateString()` /
    // `toLocaleTimeString()` / `toLocaleString()` renders in the VIEWER's time
    // zone and locale, so an admin abroad saw a different lodge night than the
    // one stored, and the lobby clock showed the wrong time on a TV whose
    // browser was not set to New Zealand (#2256, #2264).
    //
    // ALL THREE `toLocale*` date entry points are restricted. `toLocaleString`
    // was originally left out because `Number.prototype.toLocaleString` is
    // thousands-separator formatting and has nothing to do with dates — but
    // roughly a quarter of the sites this issue fixed were date-context
    // `toLocaleString` calls, so leaving it unguarded left the biggest single
    // hole in a rule `docs/DOMAIN_INVARIANTS.md` claims closes the class. It is
    // restricted here, and the three files that genuinely format NUMBERS get a
    // narrow block of their own below.
    //
    // KNOWN LIMITATION (accepted): the selector is syntactic, so computed
    // access (`d["toLocaleDateString"]()`) and a detached method alias
    // (`const f = d.toLocaleDateString; f()`) both slip past it. Neither
    // appears in the tree and neither is a shape anyone writes by accident;
    // the rule is a guard against the ordinary mistake, not a sandbox.
    //
    // A site whose format is legitimately none of the six helper shapes
    // (weekday-bearing, month-year-short, seconds-bearing, or an `en-CA` ISO
    // extractor) is expressed as a module-level
    // `new Intl.DateTimeFormat(APP_LOCALE, { timeZone: APP_TIME_ZONE, … })`
    // constant, which is both zone-correct and rule-clean. THAT is the escape
    // hatch — not an `eslint-disable` comment. There are none in the tree, and
    // a new one should be read as a site that was never classified.
    //
    // Documented exclusions (each has its own block below):
    //   * `src/lib/nzst-date.ts`, `src/lib/date-only.ts` — the helpers
    //     themselves, the sanctioned home for raw date formatting.
    //   * `src/lib/email-templates.ts` — `formatChoreRosterDate` (#2256): the
    //     chore-roster long-weekday subject line and body must stay
    //     byte-identical, and the helper is shared with `src/lib/email/chores.ts`.
    //     Flat config cannot scope a rule to one function, so the exemption is
    //     file-wide and therefore coarser than we would like. It exists SOLELY
    //     for `formatChoreRosterDate`; new date rendering in that file must
    //     still use the helpers, as `formatOperationalDateTime` does after
    //     being migrated in this very pull request.
    //   * the three Number-formatting files — a narrowed block, NOT an `off`:
    //     they keep both date restrictions and drop only `toLocaleString`.
    //   * `src/lib/xero-invoice-helpers.ts` — ISO payload dates for the Xero
    //     API. Listed for the record only: it builds them with `toISOString()`,
    //     so it never actually trips this rule and needs no block.
    //   * tests — expectation builders deliberately mirror a component's
    //     current (non-standard) format, which is how they catch a drift.
    //   * `e2e/**` is outside this block's `files` glob already (`src/**`
    //     only). `e2e/helpers/booking.ts`, `e2e/helpers/stay-dates.ts` and
    //     `e2e/admin-retroactive-booking.spec.ts` build expected label strings
    //     on purpose; if this rule is ever widened to the repository root, add
    //     an `off` block for `e2e/**`.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_BARE_TO_LOCALE_DATE_STRING,
        NO_BARE_TO_LOCALE_TIME_STRING,
        NO_BARE_TO_LOCALE_STRING,
        ...RAW_SQL_RESTRICTIONS,
        ...MONEY_CENTS_RESTRICTIONS,
      ],
    },
  },
  {
    // The raw-SQL guard (#2289) is NOT an `src/`-only rule, even though the date
    // rules above are. Operator CLIs and seed/migration helpers are where
    // hand-written SQL is most likely — Prisma cannot express a bulk correlated
    // update, and these files run against production data with an operator
    // watching a row count. `scripts/` alone holds the money-adjacent
    // `backfill-orphaned-applied-credits.ts`,
    // `backfill-cancel-flattened-payments.ts`,
    // `backfill-finance-monthly-facts.ts` and `xero-booking-repair.ts`. Neither
    // directory contains any raw SQL today, so this costs nothing now and is
    // purely about what may be written next — and it makes the unqualified
    // promise in CONTRIBUTING.md and docs/DOMAIN_INVARIANTS.md true rather than
    // aspirational.
    //
    // `e2e/**` is deliberately NOT here: it is entirely Playwright tests, which
    // are exempt for the same reason `src/**/__tests__/**` is (see the last
    // block) — a test's raw statement runs against a throwaway database and its
    // result is asserted on the spot.
    files: ["scripts/**/*.{ts,tsx}", "prisma/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...RAW_SQL_RESTRICTIONS,
        // The money restrictions reach here for the same reason: `scripts/`
        // holds the money-adjacent backfills, which is precisely where somebody
        // writes a one-off cents conversion by hand (#2685).
        ...MONEY_CENTS_RESTRICTIONS,
      ],
    },
  },
  {
    // The date helpers themselves, and the one documented format exclusion.
    // Flat config replaces a rule's whole option list rather than merging it, so
    // this block re-states the raw-SQL restrictions (#2289) instead of switching
    // `no-restricted-syntax` off outright: none of these three files contains
    // raw SQL, and the exemption they need is from the DATE rules only. Same
    // reasoning in the Number-formatting block below.
    files: [
      "src/lib/nzst-date.ts",
      "src/lib/date-only.ts",
      "src/lib/email-templates.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...RAW_SQL_RESTRICTIONS,
        ...MONEY_CENTS_RESTRICTIONS,
      ],
    },
  },
  {
    // Number formatting, not dates: these three call
    // `Number.prototype.toLocaleString` for thousands separators, so only that
    // one restriction is lifted — both date restrictions still apply here.
    files: [
      // Character counter: "12,345 / 50,000 characters" on the raw-CSS box.
      "src/app/(admin)/admin/site-style/site-style-wizard.tsx",
      // Validation message quoting the notice body's character limit.
      "src/components/admin/notice-editor.tsx",
      // Redemption/export row counts in the promo-code panel.
      "src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_BARE_TO_LOCALE_DATE_STRING,
        NO_BARE_TO_LOCALE_TIME_STRING,
        ...RAW_SQL_RESTRICTIONS,
        ...MONEY_CENTS_RESTRICTIONS,
      ],
    },
  },
  {
    // #2685 — inside the money-domain modules a bare `x * 100` is a cents
    // conversion by construction, so the broad selector replaces the narrower
    // shape-based arms FOR THAT SHAPE rather than joining them: it matches the
    // same node they do, and listing both made the commonest real mistake report
    // two and three times at the same line and column; a 25-site regression
    // printed sixty identical messages and read far worse than it was (#2685
    // review). These files compute no percentages: that is what makes the broad
    // selector safe here and unsafe anywhere else.
    //
    // IT IS NOT, HOWEVER, STRICTLY STRONGER THAN THE NARROW ARMS, and this
    // config used to claim it was. The broad arm excludes a division inside the
    // multiplication so that a genuine percentage stays writable, and for a
    // while that exclusion was the only money rule these files had — so a typed
    // amount that was DIVIDED and then scaled, `(parseFloat(gross) / 1.15) * 100`
    // or `(parseFloat(raw) / guests) * 100`, was caught in an ordinary
    // `src/lib` file and caught nowhere at all in a Xero module, a payment
    // module or an API route. `MONEY_MODULE_RESTRICTIONS` therefore states the
    // ratio-of-a-parse arm explicitly; see the comment above it.
    files: MONEY_DOMAIN_MODULES,
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_BARE_TO_LOCALE_DATE_STRING,
        NO_BARE_TO_LOCALE_TIME_STRING,
        NO_BARE_TO_LOCALE_STRING,
        ...RAW_SQL_RESTRICTIONS,
        ...MONEY_MODULE_RESTRICTIONS,
      ],
    },
  },
  {
    // #2685 — the exempt paths. The money restrictions are lifted here and ONLY
    // here, each with its written reason on `MONEY_GUARD_EXEMPTIONS` above; the
    // date and raw-SQL restrictions still apply, which is why this block
    // re-states them rather than switching the rule off.
    files: MONEY_HELPER_MODULES,
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_BARE_TO_LOCALE_DATE_STRING,
        NO_BARE_TO_LOCALE_TIME_STRING,
        NO_BARE_TO_LOCALE_STRING,
        ...RAW_SQL_RESTRICTIONS,
      ],
    },
  },
  {
    // Test expectation builders mirror the component format under test.
    //
    // The raw-SQL restrictions (#2289) are off here too, deliberately. A test's
    // raw statement runs against a throwaway database and its result is
    // asserted on the spot, so a wrong shape fails the test rather than
    // silently mispricing a booking — `concurrency-lock-races.realdb.test.ts`
    // reads counts that way on purpose. What must never regress is PRODUCTION
    // code, and `raw-sql-shape-guard.test.ts` pins that inventory file by file.
    files: ["src/**/__tests__/**/*.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-syntax": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
