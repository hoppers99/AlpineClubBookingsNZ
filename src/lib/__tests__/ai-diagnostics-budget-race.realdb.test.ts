/**
 * Real-Postgres over-budget RACE regression for the AI Diagnostics monthly
 * budget reserve (AID-2, #2371; closes the #2532 carry-forward).
 *
 * `reserveDiagnosticsBudget` is a guarded spend claim: under a per-month advisory
 * lock it sweeps expired reservations, sums live reservations + settled spend,
 * and inserts a reservation ONLY if `settled + reserved + reserve <= budget`.
 * `decideReservation` is exhaustively unit/mutation-tested without a database and
 * the advisory-lock-first wiring is asserted in `ai-diagnostics-usage.test.ts`,
 * but the money-safety invariant that N GENUINELY CONCURRENT reservers can never
 * push spend over the budget can only be proven against a real PostgreSQL — an
 * in-process fake cannot reproduce `pg_advisory_xact_lock` mutual exclusion or a
 * READ COMMITTED snapshot. This suite drives the PRODUCTION function (not a
 * re-implementation) from two/three concurrent callers and asserts exactly the
 * budgeted number of reservations win and the live-reservation sum never exceeds
 * the budget.
 *
 * Like `concurrency-lock-races.realdb.test.ts`, it is OFF by default and a no-op
 * in ordinary CI/local runs:
 *   - The race describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`; otherwise
 *     it is `describe.skip`, so `npm test` never needs a live database.
 *   - It reads ONLY `CONCURRENCY_RACE_DATABASE_URL` and requires a loopback host,
 *     port 55442+, and the dedicated `concurrency_race_1881` database marker.
 *   - Hosted CI runs it by importing this file from that guarded harness (see the
 *     import in `concurrency-lock-races.realdb.test.ts`), which supplies the
 *     dedicated localhost database with every migration already deployed.
 *
 * To run it directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   npx vitest run src/lib/__tests__/ai-diagnostics-budget-race.realdb.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

/**
 * Guard: never run against a default/production Postgres. Require the dedicated
 * env URL, loopback, an unusual high port, and the shared race-harness database
 * marker — the same envelope as `assertSafeRaceDbUrl` in
 * `concurrency-lock-races.realdb.test.ts`, re-declared here so this file can be
 * run standalone without importing (and re-registering) that whole harness.
 */
export function assertSafeDiagnosticsRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Diagnostics budget race tests need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run diagnostics budget race tests against port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+ (never the default 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Diagnostics budget race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Diagnostics budget race DB name must contain the dedicated marker 'concurrency_race_1881'.",
    );
  }
}

let prisma: typeof import("@/lib/prisma")["prisma"];
let reserveDiagnosticsBudget: typeof import("@/lib/ai-diagnostics-usage")["reserveDiagnosticsBudget"];
let diagnosticsUsageMonthKey: typeof import("@/lib/ai-diagnostics-usage")["diagnosticsUsageMonthKey"];

// A fixed, far-future instant keeps the whole suite in one isolated billing
// month ("2099-03") that no other harness or real data touches. Passing it as
// `now` also makes each reservation's `expiresAt` deterministic (now + TTL), so
// the reservations stay "live" for the aggregate check and the crash-safety
// sweep never reclaims one mid-test.
const RACE_NOW = new Date("2099-03-15T00:00:00.000Z");

describe("diagnostics budget race DB safety guard (#2532)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeDiagnosticsRaceDbUrl(
        "postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881",
      ),
    ).not.toThrow();
  });

  it.each([
    "postgresql://user:pass@db.example.org:55442/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeDiagnosticsRaceDbUrl(url)).toThrow();
  });
});

// Run only when explicitly enabled; otherwise this is a pure no-op that never
// imports Prisma or connects to a database.
(RUN ? describe : describe.skip)(
  "diagnostics budget over-budget race — real PostgreSQL (#2371 / #2532)",
  () => {
    let month: string;

    async function clearMonth() {
      await prisma.diagnosticsBudgetReservation.deleteMany({ where: { month } });
      await prisma.diagnosticsUsageMonthly.deleteMany({ where: { month } });
    }

    async function setBudget(monthlyBudgetCents: number) {
      await prisma.diagnosticsSettings.upsert({
        where: { id: "default" },
        create: { id: "default", monthlyBudgetCents },
        update: { monthlyBudgetCents },
      });
    }

    /** Sum of the live (unexpired) reservations booked for the test month. */
    async function liveReservedCents(): Promise<number> {
      const agg = await prisma.diagnosticsBudgetReservation.aggregate({
        _sum: { reservedCents: true },
        where: { month, expiresAt: { gt: RACE_NOW } },
      });
      return agg._sum.reservedCents ?? 0;
    }

    beforeAll(async () => {
      // Guard the dedicated URL BEFORE importing Prisma or the metering module,
      // then point the app singleton at it — mirroring the sibling harness so
      // the skipped suite is a true no-op when the dedicated URL is absent.
      assertSafeDiagnosticsRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ reserveDiagnosticsBudget, diagnosticsUsageMonthKey } = await import(
        "@/lib/ai-diagnostics-usage"
      ));
      month = diagnosticsUsageMonthKey(RACE_NOW);
      await clearMonth();
    }, 60_000);

    afterAll(async () => {
      if (typeof prisma !== "undefined") {
        await prisma.diagnosticsBudgetReservation
          .deleteMany({ where: { month } })
          .catch(() => {});
        await prisma.diagnosticsUsageMonthly
          .deleteMany({ where: { month } })
          .catch(() => {});
        await prisma.diagnosticsSettings
          .deleteMany({ where: { id: "default" } })
          .catch(() => {});
        await prisma.$disconnect().catch(() => {});
      }
    }, 60_000);

    it("admits exactly one of two concurrent reserves that individually fit but together exceed the budget", async () => {
      // Budget fits exactly ONE 40c reserve; two would be 80c > 50c. Under the
      // per-month advisory lock the two reservers serialise: the winner inserts
      // 40c, the loser re-reads it as a live reservation and is denied. Without
      // mutual exclusion both would read 0 live and BOTH insert — 80c reserved
      // against a 50c budget, the overspend this test forbids.
      const reserveCents = 40;
      await setBudget(50);

      for (let i = 0; i < 25; i += 1) {
        await clearMonth();
        const [a, b] = await Promise.all([
          reserveDiagnosticsBudget({ reserveCents, now: RACE_NOW }),
          reserveDiagnosticsBudget({ reserveCents, now: RACE_NOW }),
        ]);

        const winners = [a, b].filter((r) => r.ok).length;
        expect(winners).toBe(1);
        const loser = [a, b].find((r) => !r.ok);
        expect(loser?.ok === false && loser.reason).toBe("over_budget");
        // The DB never holds more reserved than one roundtrip's worth, i.e. the
        // budget is never overspent by the concurrent pair.
        expect(await liveReservedCents()).toBe(reserveCents);
      }
    });

    it("admits exactly floor(budget/reserve) of a concurrent burst and never overspends", async () => {
      // A 100c budget admits exactly two 40c reserves (80c <= 100c); a third
      // (120c) is denied. Five concurrent reservers race; exactly two win and
      // the live-reservation sum never exceeds the budget.
      const reserveCents = 40;
      const budgetCents = 100;
      const burst = 5;
      const expectedWinners = Math.floor(budgetCents / reserveCents); // 2
      await setBudget(budgetCents);

      for (let i = 0; i < 15; i += 1) {
        await clearMonth();
        const results = await Promise.all(
          Array.from({ length: burst }, () =>
            reserveDiagnosticsBudget({ reserveCents, now: RACE_NOW }),
          ),
        );

        const winners = results.filter((r) => r.ok).length;
        expect(winners).toBe(expectedWinners);
        const reserved = await liveReservedCents();
        expect(reserved).toBe(expectedWinners * reserveCents);
        expect(reserved).toBeLessThanOrEqual(budgetCents);
      }
    });

    it("denies every reserve when the budget is zero (hard-off)", async () => {
      await setBudget(0);
      await clearMonth();

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          reserveDiagnosticsBudget({ reserveCents: 40, now: RACE_NOW }),
        ),
      );

      expect(results.every((r) => !r.ok)).toBe(true);
      for (const r of results) {
        expect(r.ok === false && r.reason).toBe("budget_not_set");
      }
      expect(await liveReservedCents()).toBe(0);
    });
  },
);
