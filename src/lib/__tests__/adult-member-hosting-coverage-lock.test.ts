// #2576 §9 — the per-OWNER advisory lock that makes same-owner coverage
// deterministic.
//
// WHY THIS FILE EXISTS AT ALL. The lane's first design argued no new lock was
// needed, on the claim that "every path that can confirm a booking and every path
// that can remove exact-night attendance already takes the per-lodge capacity lock".
// When #2576 introduced the owner key, cancellation and confirmed creation used
// different global/lodge tiers, so the named race remained open. #2593 later made
// the allocation-participating create/cancel paths compose global → lodge, but the
// owner key remains authoritative because the cross-booking participant/member/queue
// writers do not all share those tiers. §9 forbids commit-order-dependent coverage.
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

/**
 * The whole body of a top-level function, from its declaration to its own closing
 * brace — not a fixed number of characters from the declaration.
 *
 * A CHARACTER WINDOW IS NOT THE CONSTRUCT THESE ASSERTIONS MEAN TO PIN, and #2623
 * proved it: a comment added inside `enqueueHostingCoverageReevaluationForMember`
 * explaining WHY a neighbouring lock is deliberately ungated pushed the
 * `lockHostingCoverageOwner` call past `start + 4000`, and the test failed on a
 * change that moved no code at all. The failure mode in the other direction is
 * worse and silent: shrink a function and the window spills into the NEXT one, so
 * the assertion passes on a call that has been hoisted out of the guarded path
 * entirely — exactly the mutation this file exists to catch.
 *
 * Every source file here is prettier-formatted, so a top-level function ends at
 * the first line that is exactly `}` in column 0 after its declaration; nothing
 * inside the body is unindented. That makes the boundary exact without a parser.
 * The "line that is exactly `}`" part is load-bearing rather than pedantic:
 * `evaluateBookingAdultMemberHosting` returns a multi-line inline object type
 * whose own brace closes in column 0 as `}>`, so a bare search for a column-0 `}`
 * would end the body inside the signature and never reach a single statement.
 */
function topLevelFunctionBody(source: string, name: string): string | null {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const closing = /\n\}(?=\n|$)/.exec(source.slice(start));
  if (!closing) return source.slice(start);
  return source.slice(start, start + closing.index + 2);
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
      // The lock must appear inside the function's OWN body — the point is that
      // the call has not been deleted or hoisted out of the guarded path, so the
      // slice has to end where the function does rather than a fixed distance in.
      const body = topLevelFunctionBody(review, holder);
      expect(body, holder).not.toBeNull();
      expect(body ?? "", holder).toContain("lockHostingCoverageOwner");
    }
  });

  it("is documented as the last key in the tree's acquisition order", () => {
    // Deadlock-freedom is an ordering property, and an ordering property that is not
    // written down is one the next lane breaks. `global -> lodge -> member-night ->
    // coverage-owner` has to be stated where the other keys are stated.
    const doc = readRepoFile("docs/CONCURRENCY_AND_LOCKING.md");
    expect(doc).toContain("hosting-coverage-owner");
  });

  it("pins drain reconciliation to policy, lifecycle, Member row, refresh, then owner", () => {
    const drain = readRepoFile("src/lib/adult-member-hosting-coverage-drain.ts");
    const drainStart = drain.indexOf(
      "async function processHostingCoverageReevaluation(",
    );
    const drainBody = drain.slice(drainStart, drainStart + 9000);
    const drainPolicy = drainBody.indexOf("tryLockAdultMemberHostingPolicySet(db)");
    const policyDeferral = drainBody.indexOf('return { kind: "deferred" }');
    const lifecycleLock = drainBody.indexOf("member-lifecycle:${memberId}");
    const memberRowLock = drainBody.indexOf("FOR KEY SHARE");
    const exactRefresh = drainBody.indexOf(
      "loadClaimedHostingCoverageReevaluation(item, db)",
    );
    const identityStabilisation = drainBody.indexOf("refreshedMemberIds.some(");
    const sourceLifecycleRead = drainBody.indexOf(
      "isHostingCoverageSourceBookingTerminal(",
    );
    const dependentRead = drainBody.indexOf("loadSameOwnerCoverageDependentIds(");
    expect(drainPolicy).toBeGreaterThan(-1);
    expect(policyDeferral).toBeGreaterThan(drainPolicy);
    expect(policyDeferral).toBeLessThan(lifecycleLock);
    expect(lifecycleLock).toBeGreaterThan(drainPolicy);
    expect(memberRowLock).toBeGreaterThan(lifecycleLock);
    expect(exactRefresh).toBeGreaterThan(memberRowLock);
    expect(identityStabilisation).toBeGreaterThan(exactRefresh);
    expect(sourceLifecycleRead).toBeGreaterThan(identityStabilisation);
    expect(dependentRead).toBeGreaterThan(sourceLifecycleRead);

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
    expect(doc).toContain("policy-set → sorted member-lifecycle → sorted");
    expect(doc).toContain("Member KEY SHARE → exact queue re-read → coverage-owner");
    expect(doc).toContain("deliberately not a `FOR UPDATE`");

    const merge = readRepoFile("src/lib/member-merge.ts");
    const mergePolicyLock = merge.indexOf("lockAdultMemberHostingPolicySet(tx)");
    const mergeLifecycleLock = merge.indexOf("member-lifecycle:${lockA}");
    const relationMoves = merge.indexOf("const relationMoves = await applyMoves(");
    const mergeMemberRows = merge.indexOf(
      "lockMemberMergeHostingCoverageParticipants(tx,",
      relationMoves,
    );
    expect(mergePolicyLock).toBeGreaterThan(-1);
    expect(mergeLifecycleLock).toBeGreaterThan(mergePolicyLock);
    expect(relationMoves).toBeGreaterThan(mergeLifecycleLock);
    expect(mergeMemberRows).toBeGreaterThan(relationMoves);
    expect(
      readRepoFile("src/lib/adult-member-hosting-queue-participants.ts"),
    ).toMatch(/ORDER BY "id"\s+FOR UPDATE/);
  });

  it("keeps queued reconciliation in a real transaction and email after it", () => {
    const drain = readRepoFile("src/lib/adult-member-hosting-coverage-drain.ts");
    const itemTransaction = drain.indexOf("await db.$transaction((tx) =>");
    const reconciliation = drain.indexOf(
      "processHostingCoverageReevaluation(reconciliationItem, tx)",
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

  it("pins the merge participant re-plan, late sweeps, queue write and drain order", () => {
    const source = readRepoFile("src/lib/member-merge.ts");
    const executeStart = source.indexOf(
      "export async function executeMemberMerge(",
    );
    expect(executeStart).toBeGreaterThan(-1);
    const body = source.slice(executeStart, executeStart + 50_000);
    const markers = [
      "await lockAdultMemberHostingPolicySet(tx)",
      "member-lifecycle:${lockA}",
      "const relationMoves = await applyMoves(",
      "const hostingPlan = await buildMemberMergeHostingCoveragePlan(",
      "await lockMemberMergeHostingCoverageParticipants(tx,",
      "refreshedHostingPlan = await buildMemberMergeHostingCoveragePlan(",
      "memberMergeHostingCoveragePlanFingerprint(hostingPlan)",
      "hostingParticipantProof = proveMemberMergeHostingCoverageParticipants(",
      "const residualLoserOwnedBookings = await tx.booking.findMany(",
      "const residualLoserGuestRows = await tx.bookingGuest.findMany(",
      "await lockHostingCoverageOwners(",
      "await applyLateHostingCoverageMoves(",
      "await enqueueMemberMergeHostingCoveragePlan(",
      "await tx.member.delete({ where: { id: loserId } })",
      "await settleHostingCoverageAfterCommit({ limit: 50 }, client)",
    ];
    const positions = markers.map((marker) => body.indexOf(marker));
    expect(positions.every((position) => position >= 0), markers.join(" -> ")).toBe(
      true,
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(body).toMatch(
      /const residualLoserGuestRows = await tx\.bookingGuest\.findMany\([\s\S]*?where: \{ memberId: loserId \}[\s\S]*?driftFields: \["BookingGuest\.member"\]/,
    );
  });
});
