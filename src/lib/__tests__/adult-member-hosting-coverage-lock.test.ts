// #2576 §9 — the per-OWNER advisory lock that makes same-owner coverage
// deterministic.
//
// WHY THIS FILE EXISTS AT ALL. The lane's first design argued no new lock was
// needed, on the claim that "every path that can confirm a booking and every path
// that can remove exact-night attendance already takes the per-lodge capacity lock".
// That claim is measurably false in both directions — `booking-cancel.ts`'s claim
// transactions take `pg_advisory_xact_lock(1)` and never the lodge lock, while
// `booking-create.ts` and the guest-add route take the lodge lock and never
// `lock(1)` — so a cancel removing the last qualifying adult could interleave with a
// create that had just read that adult as cover, and which booking won depended on
// commit order. §9 forbids exactly that non-determinism.
//
// A unit test cannot prove two Postgres transactions serialise. What it CAN pin is
// everything that would silently disable the lock: the SQL shape, the namespace, the
// sorted acquisition order that keeps composition deadlock-free, and the fact that
// the coverage reads and writes call it at all. Each of those is a mutation that
// leaves every other test in the tree green.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("server-only", () => ({}));

import {
  HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS,
  lockHostingCoverageOwner,
  lockHostingCoverageOwners,
} from "@/lib/adult-member-hosting-coverage-lock";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/** A client that records the tagged-template SQL it was handed. */
function recordingClient() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return 1;
    }),
  };
}

describe("the per-owner coverage lock (#2576 §9)", () => {
  it("takes a transaction-scoped advisory lock in its own namespace", () => {
    const db = recordingClient();
    return lockHostingCoverageOwner(db, "owner-1").then(() => {
      expect(db.calls).toHaveLength(1);
      const [call] = db.calls;
      // TRANSACTION-scoped, not session-scoped: a session lock would outlive the
      // transaction and never be released by a pooled connection.
      expect(call.sql).toContain("pg_advisory_xact_lock");
      expect(call.sql).not.toContain("pg_advisory_lock(");
      // Two-argument form, keyed in its own namespace, so it can never collide with
      // `pg_advisory_xact_lock(1)`, the per-lodge key, the member-night key or the
      // credit-ledger key.
      expect(call.values).toEqual([
        HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS,
        "owner-1",
      ]);
      expect(HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS).toBe(
        "hosting-coverage-owner",
      );
    });
  });

  it("acquires several owners in sorted order, so composing can never deadlock", async () => {
    // The same discipline `lockBookingMemberNights` uses. Two transactions that each
    // need the same two owner keys must request them in the same order or they can
    // hold one and wait for the other forever.
    const db = recordingClient();
    await lockHostingCoverageOwners(db, ["owner-z", "owner-a", "owner-m"]);
    expect(db.calls.map((call) => call.values[1])).toEqual([
      "owner-a",
      "owner-m",
      "owner-z",
    ]);
  });

  it("de-duplicates and ignores absent owners", async () => {
    const db = recordingClient();
    await lockHostingCoverageOwners(db, ["owner-1", "owner-1", null, undefined, ""]);
    expect(db.calls).toHaveLength(1);
    const empty = recordingClient();
    await lockHostingCoverageOwners(empty, [null, undefined]);
    expect(empty.calls).toHaveLength(0);
  });

  it("is a no-op on a client that cannot run raw SQL, rather than throwing", async () => {
    // The hosting modules accept a narrow delegate-only client so they can be driven
    // by an in-memory store in tests. Throwing here would make the policy untestable
    // without a live Postgres; in production the client is always a real transaction
    // client, so the lock is always taken.
    await expect(lockHostingCoverageOwner({}, "owner-1")).resolves.toBeUndefined();
    await expect(lockHostingCoverageOwner(null, "owner-1")).resolves.toBeUndefined();
  });

  it("is taken by every reader and writer of same-owner cover", () => {
    // The mutation this catches is the quiet one: deleting a single
    // `lockHostingCoverageOwner` call leaves the whole tree green, because no unit
    // test can observe a missing lock. Three sites, and all three are load-bearing —
    // the evaluator (which READS another booking as cover), the settle step (which
    // reads the DEPENDENTS), and the enqueue-only seam the confirming paths use
    // instead of evaluating.
    const review = readRepoFile("src/lib/adult-member-hosting-review.ts");
    expect(
      (review.match(/await lockHostingCoverageOwner\(/g)?.length ?? 0) +
        (review.match(/await lockHostingCoverageOwners\(/g)?.length ?? 0),
    ).toBeGreaterThanOrEqual(4);
    for (const holder of [
      "evaluateBookingAdultMemberHosting",
      "settleSameOwnerDependentCoverage",
      "enqueueOwnHostingCoverageReevaluation",
      "enqueueHostingCoverageReevaluationForMember",
    ]) {
      const start = review.indexOf(`function ${holder}(`);
      expect(start, holder).toBeGreaterThan(-1);
      // The lock must appear inside the function body, before the next top-level
      // declaration. A generous window rather than a parser: the point is that the
      // call has not been deleted or hoisted out of the guarded path.
      const body = review.slice(start, start + 4000);
      expect(body, holder).toContain("lockHostingCoverageOwner");
    }
  });

  it("is documented as the last key in the tree's acquisition order", () => {
    // Deadlock-freedom is an ordering property, and an ordering property that is not
    // written down is one the next lane breaks. `global -> lodge -> member-night ->
    // coverage-owner` has to be stated where the other keys are stated.
    const doc = readRepoFile("docs/CONCURRENCY_AND_LOCKING.md");
    expect(doc).toContain("hosting-coverage-owner");
  });

  it("pins policy reconciliation to policy-set then Member KEY SHARE then coverage-owner", () => {
    const review = readRepoFile("src/lib/adult-member-hosting-review.ts");
    const start = review.indexOf(
      "function reconcileSameOwnerCoverageIncident(",
    );
    expect(start).toBeGreaterThan(-1);
    const body = review.slice(start, start + 7500);
    const policyLock = body.indexOf("lockAdultMemberHostingPolicySet(db)");
    const actorLock = body.indexOf("FOR KEY SHARE");
    const ownerReconciliation = body.indexOf(
      "reconcileAdultMemberHostingReview(params.bookingId",
    );
    expect(policyLock).toBeGreaterThan(-1);
    expect(actorLock).toBeGreaterThan(policyLock);
    expect(ownerReconciliation).toBeGreaterThan(actorLock);
    expect(body).toContain(
      "policy-set -> Member KEY SHARE -> coverage-owner",
    );

    const doc = readRepoFile("docs/CONCURRENCY_AND_LOCKING.md");
    expect(doc).toContain("policy-set → Member KEY SHARE → coverage-owner");
    expect(doc).toContain("no queue tuple");
  });

  it("keeps queued reconciliation in a real transaction and email after it", () => {
    const drain = readRepoFile("src/lib/adult-member-hosting-coverage-drain.ts");
    const itemTransaction = drain.indexOf("await db.$transaction((tx) =>");
    const reconciliation = drain.indexOf(
      "processHostingCoverageReevaluation(item, tx)",
      itemTransaction,
    );
    const notification = drain.indexOf(
      "await notifyOwnerOfLostCoverage(",
      reconciliation,
    );
    expect(itemTransaction).toBeGreaterThan(-1);
    expect(reconciliation).toBeGreaterThan(itemTransaction);
    expect(notification).toBeGreaterThan(reconciliation);
  });
});
