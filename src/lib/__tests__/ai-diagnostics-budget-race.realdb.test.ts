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
 * ## The proof is FORCED, not raced (#2532)
 *
 * The first test does not hope the interleaving happens. A third connection
 * takes the SAME per-month advisory lock and holds it open; the two reservers
 * are then started and the test waits on a BARRIER — `pg_locks` reporting both
 * of them blocked on exactly that advisory key — before asserting that NEITHER
 * has been able to insert a reservation. Only then is the holder released. No
 * `setTimeout` stands in for the interleaving, so the test neither flakes when
 * CI is slow nor passes vacuously when it is fast.
 *
 * That barrier is what makes the suite a real regression gate. Both ways of
 * losing the protection were reproduced against a throwaway PostgreSQL (three
 * runs each, no flaky pass) before this was committed:
 *   - DELETE the `pg_advisory_xact_lock` line from `reserveDiagnosticsBudget`
 *     and the reservers never queue, so the barrier times out with a named
 *     diagnostic naming the lock and the invariant it protects.
 *   - MOVE it to after the budget reads and the barrier is satisfied (they do
 *     queue) but both reservers then win — 2 x 40c admitted against a 50c
 *     budget, caught by the one-winner assertion.
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
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

/**
 * The first advisory-lock key `reserveDiagnosticsBudget` (and
 * `settleDiagnosticsRoundtrip`) hashes, per docs/CONCURRENCY_AND_LOCKING.md.
 * The second key is the billing month, so different months never contend.
 * Kept as a constant because the barrier below has to look for THIS key in
 * `pg_locks` — a lock taken on some other key would not serialise reservers.
 */
const BUDGET_LOCK_NAME = "diagnostics-budget-reserve";

/**
 * How long the lock barrier waits for the reservers to queue before giving up
 * with its own named diagnostic — far more useful than Vitest's generic test
 * timeout, and comfortably inside Prisma's 5s interactive-transaction timeout
 * so the barrier reports the failure rather than the reservers timing out first.
 *
 * Measured with `process.hrtime.bigint()` via `realElapsedMs`, never
 * `Date.now()`: since #2481 every test file runs with `Date` frozen, so a
 * `Date.now()` deadline can never expire and the poller would spin until the
 * test was killed with no lock named.
 */
const LOCK_POLL_TIMEOUT_MS = 4_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
/**
 * Two SEPARATE single-connection clients, each on its own PostgreSQL backend
 * (the same idiom as `concurrency-lock-races.realdb.test.ts`):
 *
 * - `lockHolderClient` holds the per-month advisory lock open inside a real
 *   transaction, which is what pins the reservers in a known state.
 * - `observerClient` polls `pg_locks`. It is deliberately NOT the application
 *   singleton: the two blocked reservers are holding singleton pool
 *   connections, and the barrier must never be able to starve behind them.
 */
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

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

    /** Every reservation row for the test month, live or expired. */
    async function reservationRowCount(): Promise<number> {
      return prisma.diagnosticsBudgetReservation.count({ where: { month } });
    }

    /**
     * How many sessions are currently WAITING (granted = false) for the
     * per-month diagnostics budget advisory lock.
     *
     * `pg_advisory_xact_lock(int4, int4)` stores its two keys in `pg_locks` as
     * `classid`/`objid`, with `objsubid = 2` marking the two-key form. Those
     * columns are `oid` (unsigned) while `hashtext()` is a signed `int4` that is
     * routinely negative, so both sides are compared as UNSIGNED 32-bit
     * `bigint`s. Comparing them raw would silently match nothing and the barrier
     * would time out even with a perfectly correct lock.
     */
    async function pendingBudgetLockWaiters(): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND objsubid = 2
          AND granted = false
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid::bigint =
            ((hashtext(${BUDGET_LOCK_NAME})::bigint + 4294967296) % 4294967296)
          AND objid::bigint =
            ((hashtext(${month})::bigint + 4294967296) % 4294967296)
      `;
      return rows[0]?.count ?? 0;
    }

    /**
     * The BARRIER. Blocks until PostgreSQL itself reports `expected` sessions
     * queued on the per-month budget key — the only honest signal that the
     * reservers really reached the lock and really could not proceed. Polling
     * `pg_locks` is not "sleep-based racing": nothing here stands in for the
     * interleaving, the interleaving is held open by `lockHolderClient` and this
     * only detects when it is fully established.
     */
    async function waitForBudgetLockWaiters(expected: number): Promise<void> {
      const startedAt = process.hrtime.bigint();
      let seen = 0;
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        seen = await pendingBudgetLockWaiters();
        if (seen >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `Timed out waiting for ${expected} reserver(s) to queue on ` +
          `pg_advisory_xact_lock(hashtext('${BUDGET_LOCK_NAME}'), hashtext('${month}')) — saw ${seen}. ` +
          "reserveDiagnosticsBudget no longer serialises on the per-month budget lock, " +
          "so concurrent reservers can read the same under-budget snapshot and overspend " +
          "the monthly budget (docs/CONCURRENCY_AND_LOCKING.md).",
      );
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

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([
          import("@prisma/client"),
          import("@/lib/prisma-adapter"),
        ]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({
          adapter: createPrismaPgAdapter(url.toString()),
        });
      };
      lockHolderClient = createSeparateClient("race-2532-lock-holder");
      observerClient = createSeparateClient("race-2532-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      await clearMonth();
    }, 60_000);

    afterAll(async () => {
      await Promise.all(
        [lockHolderClient, observerClient].map((client) =>
          client ? client.$disconnect().catch(() => {}) : Promise.resolve(),
        ),
      );
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

    it("FORCES the overspend interleaving: two reservers queue on the per-month lock, neither can insert while it is held, and exactly one claims the budget", async () => {
      // 50c budget, two 40c reserves: either alone fits, both together do not.
      const reserveCents = 40;
      const budgetCents = 50;
      await setBudget(budgetCents);
      await clearMonth();

      const lockHeld = deferred();
      const releaseLock = deferred();

      // A THIRD connection takes the production lock's exact key and parks on
      // it. Reserve is now guaranteed to block, whatever the machine's timing.
      const holder = lockHolderClient.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BUDGET_LOCK_NAME}), hashtext(${month}))`;
          lockHeld.resolve();
          await releaseLock.promise;
        },
        { maxWait: 20_000, timeout: 30_000 },
      );
      await lockHeld.promise;

      // Start both reservers. Neither can get past its first statement.
      const reserveA = reserveDiagnosticsBudget({ reserveCents, now: RACE_NOW });
      const reserveB = reserveDiagnosticsBudget({ reserveCents, now: RACE_NOW });

      await waitForBudgetLockWaiters(2);

      // THE load-bearing assertion. Both reservers are inside their
      // transactions and both are stopped dead at the lock, so neither has run
      // its read-check-insert. Remove the `pg_advisory_xact_lock` line from
      // `reserveDiagnosticsBudget` and this is 2 — 80c reserved against a 50c
      // budget — with the barrier above having already failed first.
      expect(await reservationRowCount()).toBe(0);

      releaseLock.resolve();
      await holder;

      // Released together, they serialise: the first inserts 40c, the second
      // re-reads it as a live reservation and is denied.
      const [a, b] = await Promise.all([reserveA, reserveB]);
      expect([a, b].filter((result) => result.ok)).toHaveLength(1);
      const loser = [a, b].find((result) => !result.ok);
      expect(loser?.ok === false && loser.reason).toBe("over_budget");
      expect(await liveReservedCents()).toBe(reserveCents);
      expect(await liveReservedCents()).toBeLessThanOrEqual(budgetCents);
    });

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
