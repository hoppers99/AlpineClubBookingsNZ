import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Census: every loader that feeds an in-progress edit must select the column
 * that says what a night was SOLD for (#2744).
 *
 * `buildInProgressGuestRangePlan` credits a night given back at the price
 * recorded on its `BookingGuestNight` row, and falls back to the CURRENT season
 * rate for a night whose price it cannot see (INV-MOD-005). It cannot tell "this
 * night has no stored price" from "this query did not ask for it": both arrive
 * as a row with no `priceCents`, and both take the fallback.
 *
 * So the whole money fix rests on two Prisma selects saying
 * `nights: { select: { stayDate: true, priceCents: true } }`, and the failure
 * mode if one stops is the worst kind. Nothing throws, nothing fails to
 * type-check — `priceCents` is optional on the plan's night type so that a
 * caller holding a bare `Date` still compiles — and no unit test notices,
 * because the plan-level suites build guests by hand and
 * `calculate-modified-pricing-capacity.test.ts` mocks the database. The only
 * symptom is a member being refunded at today's price list again.
 *
 * Roughly twenty other sites in the tree load `nights: { select: { stayDate:
 * true } }`, because they only need to know which nights a guest holds. A new
 * edit path copying the cheaper one, or somebody trimming a select for
 * performance, is exactly how this comes back. This file makes the inventory
 * mechanical, in the style of `guest-stay-expansion-census.test.ts` and
 * `night-occupancy-census.test.ts`: a new caller of the in-progress plan has to
 * be classified here, and a declared loader has to keep asking for the price.
 *
 * ## What this census does and does not guarantee
 *
 * It is a SOURCE-TEXT census over `src/`. It guarantees that no production call
 * to `buildInProgressGuestRangePlan` or `calculateModifiedPricing` can appear
 * without being declared, and that every `nights: { select: … }` inside a
 * declared LOADER asks for `priceCents`. It cannot follow a booking loaded in
 * one file and passed through three others, which is why the table records the
 * route from loader to plan in prose and why `booking-modify-plan.ts` is
 * declared as a `plan-builder` that loads nothing: the check that matters for
 * that file is that its two callers are both on this list.
 */

const SRC_ROOT = path.resolve(process.cwd(), "src");

function allSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : allSourceFiles(absolute);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

function repoRelative(absolute: string): string {
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

/**
 * A CALL to either entry point into the in-progress plan.
 *
 * The lookbehind drops the two declarations (`export function
 * buildInProgressGuestRangePlan(`, `export async function
 * calculateModifiedPricing(`) so a definition is not mistaken for a caller. A
 * bare import or re-export has no `(` after the name and never matches, which is
 * deliberate: importing the symbol is not what puts a booking through the plan.
 */
const PLAN_CALL =
  /(?<!function\s)\b(?:buildInProgressGuestRangePlan|calculateModifiedPricing)\s*\(/g;

/** `nights: { select: { … } }`, with the selected fields captured. */
const NIGHTS_SELECT = /nights:\s*\{\s*select:\s*\{([^}]*)\}/g;

/**
 * Every production file that puts a booking through the in-progress plan.
 *
 *  - `loader` — reads the booking from the database and hands it to the plan.
 *    Its `nights` select is load-bearing and is checked below.
 *  - `plan-builder` — receives an already-loaded booking and builds the plan
 *    from it. Loads nothing itself, so there is no select to check; it is on the
 *    list so that a THIRD caller of it has to be declared.
 *
 * `calls` is declared rather than counted so that a second call added to a file
 * already here fails the census instead of hiding behind the first.
 */
const PLAN_CALL_SITES = [
  {
    file: "src/lib/booking-batch-modification-service.ts",
    kind: "loader",
    calls: 1,
    what: "the APPLY path: re-reads the booking under the lodge capacity lock, then prices the edit through calculateModifiedPricing",
    nightsSelects: 1,
  },
  {
    file: "src/app/api/bookings/[id]/modify-quote/route.ts",
    kind: "loader",
    calls: 1,
    what: "the QUOTE path: previews the same edit, and must reach the same numbers as the apply path or the member is quoted one price and charged another",
    nightsSelects: 1,
  },
  {
    file: "src/lib/booking-modify-plan.ts",
    kind: "plan-builder",
    calls: 1,
    what: "calculateModifiedPricing — builds the plan from the booking its caller loaded",
    nightsSelects: 0,
  },
] as const;

describe("in-progress edit sold-price census (#2744)", () => {
  it("declares every production caller of the in-progress plan", () => {
    const found = allSourceFiles(SRC_ROOT)
      .filter(
        (absolute) =>
          [...fs.readFileSync(absolute, "utf8").matchAll(PLAN_CALL)].length > 0,
      )
      .map(repoRelative)
      .sort();

    expect(found).toEqual(
      PLAN_CALL_SITES.map((site) => site.file as string).sort(),
    );
  });

  it("counts the calls in each declared file, so a second one cannot hide", () => {
    for (const site of PLAN_CALL_SITES) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), site.file),
        "utf8",
      );
      expect([...source.matchAll(PLAN_CALL)].length, site.file).toBe(site.calls);
    }
  });

  it("keeps every loader asking for what each night was sold for", () => {
    for (const site of PLAN_CALL_SITES) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), site.file),
        "utf8",
      );
      const selects = [...source.matchAll(NIGHTS_SELECT)].map((match) =>
        match[1].trim(),
      );

      expect(selects.length, `${site.file} nights selects`).toBe(
        site.nightsSelects,
      );
      for (const select of selects) {
        // INV-MOD-005: without `priceCents` the plan has no sold price to
        // recover and credits the night back at TODAY's season rate instead —
        // silently, with nothing else in the tree going red.
        expect(
          select,
          `${site.file} must select priceCents on the nights relation (INV-MOD-005, #2744)`,
        ).toContain("priceCents");
      }
    }
  });
});
