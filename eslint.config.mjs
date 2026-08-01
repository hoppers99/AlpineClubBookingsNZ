import { fixupConfigRules } from "@eslint/compat";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// #2264 — the three date-rendering restrictions, named so the "Number
// formatting only" block below can re-state the two date ones while dropping
// just `toLocaleString`, instead of switching the whole rule off.
const NO_BARE_TO_LOCALE_DATE_STRING = {
  selector:
    "CallExpression > MemberExpression.callee[property.name='toLocaleDateString']",
  message:
    "Use formatNZDate/formatNZDateTime/formatNZLongDate/formatNZWeekdayDate/formatNZMonthYear from @/lib/nzst-date, or a module-level Intl.DateTimeFormat pinned to APP_LOCALE + APP_TIME_ZONE. A bare toLocaleDateString renders in the viewer's zone and locale (#2256, #2264).",
};

const NO_BARE_TO_LOCALE_TIME_STRING = {
  selector:
    "CallExpression > MemberExpression.callee[property.name='toLocaleTimeString']",
  message:
    "Use formatNZTime/formatNZDateTime from @/lib/nzst-date, or a module-level Intl.DateTimeFormat pinned to APP_LOCALE + APP_TIME_ZONE. A bare toLocaleTimeString renders in the viewer's zone and locale (#2256, #2264).",
};

const NO_BARE_TO_LOCALE_STRING = {
  selector:
    "CallExpression > MemberExpression.callee[property.name='toLocaleString']",
  message:
    "Use formatNZDateTime/formatNZDate from @/lib/nzst-date, or a module-level Intl.DateTimeFormat pinned to APP_LOCALE + APP_TIME_ZONE. A bare toLocaleString on a Date renders in the viewer's zone and locale (#2256, #2264). Formatting a NUMBER? Add the file to the Number-formatting block in this config with a one-line reason.",
};

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
      ],
    },
  },
  {
    // The helpers themselves, and the one documented format exclusion.
    files: [
      "src/lib/nzst-date.ts",
      "src/lib/date-only.ts",
      "src/lib/email-templates.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
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
      ],
    },
  },
  {
    // Test expectation builders mirror the component format under test.
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
