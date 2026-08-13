import path from "path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * #2685 — the money cents-conversion lint rule, exercised through the REAL
 * `eslint.config.mjs`.
 *
 * This runs the actual config rather than a copy of the selectors, so it also
 * proves the file-block resolution: which paths the rule reaches, and which two
 * modules it is deliberately lifted from. A selector list copied into a test
 * would pass happily while the config that ships had dropped the rule.
 *
 * ENFORCES INV-MONEY-003 (`docs/invariants/money.md`), which names this rule and
 * this file as its enforcement arms. Every failure message below repeats the id.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Where a fixture is pretended to live. Never a real file. */
const ORDINARY_SRC_FILE = path.join(REPO_ROOT, "src/lib/money-guard-fixture.ts");
const XERO_MODULE_FILE = path.join(REPO_ROOT, "src/lib/xero-money-guard-fixture.ts");
const FINANCE_MODULE_FILE = path.join(
  REPO_ROOT,
  "src/lib/finance-money-guard-fixture.ts",
);
const THEME_FILE = path.join(REPO_ROOT, "src/lib/theme/money-guard-fixture.ts");
const SCRIPTS_FILE = path.join(REPO_ROOT, "scripts/money-guard-fixture.ts");
const XERO_ADMIN_SCREEN_FILE = path.join(
  REPO_ROOT,
  "src/app/(admin)/admin/xero/_components/money-guard-fixture.tsx",
);
const HELPER_TEXT_FILE = path.join(REPO_ROOT, "src/lib/money-input.ts");
const HELPER_PROVIDER_FILE = path.join(REPO_ROOT, "src/lib/money-provider-amount.ts");

const MONEY_RULE_ID = "INV-MONEY-003";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT, warnIgnored: false });
});

async function moneyErrorsIn(code: string, filePath: string): Promise<number> {
  const results = await eslint.lintText(code, { filePath });
  const messages = results.flatMap((result) => result.messages);
  return messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      typeof message.message === "string" &&
      message.message.startsWith(MONEY_RULE_ID),
  ).length;
}

describe("money cents-conversion guard: positive fixtures", () => {
  /*
    Alternate spellings and compositions of the SAME mistake. Banning
    `parseFloat` by name would catch only the first two of these; the rule
    matches the composition, which is what the owner's 9 Aug 2026 decision asked
    for after a bare-`parseFloat` ban was measured and rejected.
  */
  it.each([
    ["parseFloat", "const c = Math.round(parseFloat(raw) * 100);"],
    ["Number.parseFloat", "const c = Math.round(Number.parseFloat(raw) * 100);"],
    ["Number", "const c = Math.round(Number(raw) * 100);"],
    ["parseInt", "const c = Math.round(parseInt(raw) * 100);"],
    ["Number.parseInt", "const c = Math.round(Number.parseInt(raw) * 100);"],
    ["a defaulted parse", "const c = Math.round((parseFloat(raw) || 0) * 100);"],
    ["a summed parse", "const c = Math.round((Number(raw) + Number(raw)) * 100);"],
    ["a hand-rolled parser", "const c = Number(d) * 100 + Number(cts);"],
    ["a unary + coercion", "const c = Math.round(+raw * 100);"],
    ["the operands reversed", "const c = Math.round(100 * parseFloat(raw));"],
    ["a nested parse", "const c = Math.round(Math.max(0, Number(raw)) * 100);"],
    ["a ternary parse", "const c = Math.round((raw ? Number(raw) : 0) * 100);"],
  ])("catches %s", async (_label, body) => {
    const code = `export function f(raw: string, d: string, cts: string) {\n  ${body}\n  return c;\n}\n`;
    await expect(moneyErrorsIn(code, ORDINARY_SRC_FILE)).resolves.toBeGreaterThan(0);
  });

  it.each([
    ["a const declaration", "const amountCents = Math.round(dollars * 100);"],
    ["a let reassignment", "let totalCents = 0; totalCents = Math.round(dollars * 100);"],
    ["an object property", "const p = { valueCents: Math.round(dollars * 100) };"],
    [
      "a member assignment",
      "const p: Record<string, number> = {}; p.amountCents = Math.round(dollars * 100);",
    ],
  ])("catches a plain variable scaled into %s", async (_label, body) => {
    const code = `export function f(dollars: number) {\n  ${body}\n  return 1;\n}\n`;
    await expect(moneyErrorsIn(code, ORDINARY_SRC_FILE)).resolves.toBeGreaterThan(0);
  });

  it.each([
    ["a Xero module", XERO_MODULE_FILE],
    ["a finance module", FINANCE_MODULE_FILE],
  ])("catches a bare `x * 100` inside %s", async (_label, filePath) => {
    const code = "export function f(total: number) {\n  return Math.round(total * 100);\n}\n";
    await expect(moneyErrorsIn(code, filePath)).resolves.toBeGreaterThan(0);
  });

  it("reaches scripts/, where the money-adjacent backfills live", async () => {
    const code = "export function f(raw: string) {\n  return Math.round(parseFloat(raw) * 100);\n}\n";
    await expect(moneyErrorsIn(code, SCRIPTS_FILE)).resolves.toBeGreaterThan(0);
  });

  it("names both canonical helpers in its message", async () => {
    const code = "export const c = Math.round(parseFloat('1') * 100);\n";
    const results = await eslint.lintText(code, { filePath: ORDINARY_SRC_FILE });
    const message = results
      .flatMap((result) => result.messages)
      .find((entry) => entry.message?.startsWith(MONEY_RULE_ID))?.message;

    expect(message).toBeDefined();
    expect(message).toContain("parseDecimalDollarsToCents");
    expect(message).toContain("@/lib/money-input");
    expect(message).toContain("providerAmountToCents");
    expect(message).toContain("@/lib/money-provider-amount");
  });
});

describe("money cents-conversion guard: negative fixtures", () => {
  /*
    Every one of these is a real shape from this tree that superficially looks
    like the banned composition. If any starts failing, the rule has widened onto
    legitimate arithmetic and the selector — not the code — is what to fix.
  */
  it.each([
    ["occupancy", "const pct = Math.round((beds / capacity) * 100);"],
    ["setup progress", "const pct = capacity > 0 ? Math.round((beds / capacity) * 100) : 0;"],
    ["a success rate", "const pct = Math.round((beds / Math.max(capacity, 1)) * 100);"],
    ["an API budget share", "const pct = Math.round(usagePercent * 100);"],
    ["a clamped share", "const pct = Math.min(100, usagePercent * 100);"],
    ["a formatted share", "const pct = (usagePercent * 100).toFixed(0);"],
    ["a calendar column width", "const w = (beds / 7) * 100;"],
    ["two-decimal rounding", "const r = Math.round(usagePercent * 100) / 100;"],
    ["three-decimal rounding", "const r = Math.round(usagePercent * 1000) / 1000;"],
    ["a packed date key", "const key = beds * 10_000 + capacity * 100 + beds;"],
    ["a ratio comparison", "const ok = beds * 100 <= capacity * 5;"],
    ["cents back to dollars", "const d = (beds / 100).toFixed(2);"],
    ["a percentage OF cents", "const c = Math.round((beds * capacity) / 100);"],
    ["a parse with no scaling", "const n = Math.round(Number.parseFloat(String(beds)));"],
    ["a parse divided by 100", "const n = Number.parseFloat(String(beds)) / 100;"],
  ])("does not flag %s", async (_label, body) => {
    const code = `export function f(beds: number, capacity: number, usagePercent: number) {\n  ${body}\n  return 1;\n}\n`;
    await expect(moneyErrorsIn(code, ORDINARY_SRC_FILE)).resolves.toBe(0);
  });

  it("does not flag the theme module's two-decimal roundings", async () => {
    const code = [
      "const round2 = (n: number) => Math.round(n * 100) / 100;",
      "const round3 = (n: number) => Math.round(n * 1000) / 1000;",
      "export const both = [round2, round3];",
      "",
    ].join("\n");
    await expect(moneyErrorsIn(code, THEME_FILE)).resolves.toBe(0);
  });

  it("does not reach the Xero ADMIN SCREENS, which render budget percentages", async () => {
    // The broad `x * 100` arm is scoped to `src/lib/` money modules precisely so
    // this stays legal: it is a percentage, and it is spelled the same way.
    const code = "export function f(usagePercent: number) {\n  return Math.round(usagePercent * 100);\n}\n";
    await expect(moneyErrorsIn(code, XERO_ADMIN_SCREEN_FILE)).resolves.toBe(0);
  });
});

describe("money cents-conversion guard: the approved helper modules", () => {
  it.each([
    ["the exact text parser", HELPER_TEXT_FILE],
    ["the provider boundary", HELPER_PROVIDER_FILE],
  ])("lifts the money rules inside %s", async (_label, filePath) => {
    const code = [
      "export function f(value: number, raw: string) {",
      "  const cents = Math.round(value * 100);",
      "  const parsed = Math.round(Number.parseFloat(raw) * 100);",
      "  return cents + parsed;",
      "}",
      "",
    ].join("\n");
    await expect(moneyErrorsIn(code, filePath)).resolves.toBe(0);
  });

  /*
    THE FLAT-CONFIG HAZARD, pinned.

    `no-restricted-syntax` does not merge across config blocks: a later block
    that sets its own restrictions REPLACES the earlier list wholesale. The
    money rules therefore have to be re-stated in every block that touches the
    rule, and the day somebody adds a block for an unrelated exemption is the
    day the money guard silently stops existing for those files — with lint
    still green. This test is what makes that fail instead.
  */
  it("is re-stated by every block that sets no-restricted-syntax", async () => {
    const { pathToFileURL } = await import("url");
    const configModule: { default: unknown } = await import(
      pathToFileURL(path.join(REPO_ROOT, "eslint.config.mjs")).href
    );
    const blocks = configModule.default as Array<{
      files?: string[];
      rules?: Record<string, unknown>;
    }>;

    const helperModules = new Set([
      "src/lib/money-input.ts",
      "src/lib/money-provider-amount.ts",
    ]);

    const setters = blocks.filter(
      (block) => block?.rules && "no-restricted-syntax" in block.rules,
    );
    // Four pre-existing blocks, the two this issue added, and the tests block.
    expect(setters.length).toBeGreaterThanOrEqual(7);

    const withoutMoneyRule: string[] = [];
    const withoutRawSqlRule: string[] = [];

    for (const block of setters) {
      const option = block.rules!["no-restricted-syntax"];
      const label = (block.files ?? ["<no files glob>"]).join(", ");

      if (option === "off") {
        // Only the test-file block may switch the rule off outright.
        expect(label).toContain("__tests__");
        continue;
      }

      const entries = (option as Array<string | { message?: string }>).slice(1);
      const messages = entries.map((entry) =>
        typeof entry === "string" ? entry : (entry.message ?? ""),
      );

      if (!messages.some((message) => message.startsWith(MONEY_RULE_ID))) {
        withoutMoneyRule.push(label);
      }
      if (!messages.some((message) => message.startsWith("INV-OPS-001"))) {
        withoutRawSqlRule.push(label);
      }
    }

    // The two canonical helpers are the ONLY blocks allowed to drop the money
    // restrictions, and even they keep the raw-SQL ones.
    expect(
      withoutMoneyRule.filter(
        (label) => !label.split(", ").every((file) => helperModules.has(file)),
      ),
    ).toEqual([]);
    expect(withoutRawSqlRule).toEqual([]);
  });

  it("carries no eslint-disable for this rule anywhere in the tree", async () => {
    // The escape hatch is the config's module list, with a stated reason — never
    // a disable comment (#2685). `npm run lint` reports an unused directive, so a
    // stale one cannot hide here either.
    const { execSync } = await import("child_process");
    const hits = execSync(
      'git grep -n --fixed-strings "eslint-disable" -- "src/**/*.ts" "src/**/*.tsx" "scripts/**/*.ts" || true',
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const moneyDisables = hits
      .split("\n")
      .filter((line) => line.includes("no-restricted-syntax"));
    expect(moneyDisables).toEqual([]);
  });
});
