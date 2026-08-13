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
// All three enforce INV-MONEY-003 (`docs/invariants/money.md`) and open with
// that id, so whoever trips one is handed the rule (#2691).
const MONEY_CENTS_MESSAGE =
  "INV-MONEY-003: Do not build cents inline. Money a PERSON typed goes through parseDecimalDollarsToCents (or parseSignedDecimalDollarsToCents where a negative is a real amount) from @/lib/money-input — it parses the decimal digits exactly and returns null, which you must surface as a validation error rather than a silent $0.00. An ALREADY-NUMERIC provider amount, such as a Xero API number, goes through providerAmountToCents from @/lib/money-provider-amount, the one reviewed rounding boundary. Computing a PERCENTAGE rather than cents? Then this rule has misfired: add the file to the money-helper block in eslint.config.mjs with a one-line reason, never an eslint-disable comment (#2685).";

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

const MONEY_CENTS_RESTRICTIONS = [
  // Arm 1 — an inline numeric parse scaled to cents.
  ...TIMES_100_SELECTORS.flatMap((times100) =>
    PARSE_CALL_SELECTORS.map((parseCall) => `${times100} ${parseCall}`),
  ),
  // Arm 2 — a unary `+` coercion scaled to cents (`+input * 100`).
  'BinaryExpression[operator="*"][right.value=100][left.type="UnaryExpression"][left.operator="+"]',
  'BinaryExpression[operator="*"][left.value=100][right.type="UnaryExpression"][right.operator="+"]',
  // Arm 3 — anything scaled to cents ON THE WAY INTO a `…Cents` binding.
  ...TIMES_100_SELECTORS.map((times100) => `${CENTS_TARGET_SELECTOR} ${times100}`),
].map((selector) => ({ selector, message: MONEY_CENTS_MESSAGE }));

// Inside the money-domain modules themselves, a bare `x * 100` is a cents
// conversion and nothing else — these files compute no occupancy percentages and
// no theme ratios, which is exactly why the broad selector is safe here and
// nowhere else. This is the arm that catches a fresh
// `return Math.round(invoice.total * 100)` written straight into a Xero module,
// which the three shape-based arms above cannot see.
const MONEY_MODULE_RESTRICTIONS = TIMES_100_SELECTORS.map((selector) => ({
  selector,
  message: MONEY_CENTS_MESSAGE,
}));

// The files the money rules are lifted from, each for a stated reason. This list
// IS the escape hatch — there are no `eslint-disable` comments for this rule and
// a new one should be read as a site that was never classified.
//
//   * `src/lib/money-input.ts` — the canonical exact text parser. It combines
//     the integer dollar and cent groups with `dollars * 100 + cents`, which is
//     the arithmetic every other file is being sent here to use.
//   * `src/lib/money-provider-amount.ts` — the reviewed provider boundary. It
//     owns `Math.round(value * 100)` for already-numeric amounts, and the
//     documented legacy float fallback for a Xero report cell whose magnitude
//     falls outside the canonical grammar.
const MONEY_HELPER_MODULES = [
  "src/lib/money-input.ts",
  "src/lib/money-provider-amount.ts",
];

// Where a bare `x * 100` is money by construction. Deliberately `src/lib/`-only:
// the Xero ADMIN SCREENS under `src/app/(admin)/admin/xero/` render API-budget
// percentages with the same `usagePercent * 100` shape, and they are correct.
const MONEY_DOMAIN_MODULES = [
  "src/lib/xero-*.ts",
  "src/lib/xero-*/**/*.{ts,tsx}",
  "src/lib/finance-*.ts",
  "src/lib/finance-*/**/*.{ts,tsx}",
  "src/lib/membership-cancellation-*.ts",
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
// `eslint-config-money-guard.test.ts` fails the build if one ever does (#2685).

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
    // conversion by construction, so the broad selector is added on top of
    // everything the `src/**` block already applies. These files compute no
    // percentages: that is what makes this safe here and unsafe anywhere else.
    files: MONEY_DOMAIN_MODULES,
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_BARE_TO_LOCALE_DATE_STRING,
        NO_BARE_TO_LOCALE_TIME_STRING,
        NO_BARE_TO_LOCALE_STRING,
        ...RAW_SQL_RESTRICTIONS,
        ...MONEY_CENTS_RESTRICTIONS,
        ...MONEY_MODULE_RESTRICTIONS,
      ],
    },
  },
  {
    // #2685 — the two canonical money boundaries. The money restrictions are
    // lifted here and ONLY here (reasons on `MONEY_HELPER_MODULES` above); the
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
