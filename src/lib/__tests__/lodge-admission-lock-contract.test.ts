import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function expectOrdered(body: string, markers: string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    const next = body.indexOf(marker, cursor + 1);
    expect(next, `missing or misordered production marker: ${marker}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

/**
 * The slice for ONE transaction, bounded by the next one's opening line (#2887).
 *
 * This used to be `body.slice(body.indexOf(start))` — unbounded, to end of
 * file. For every transaction but the last that made the ordering assertion
 * unfalsifiable: markers belonging to a LATER transaction satisfied it. Moving
 * `acquireLodgeCapacityLock` in `createDraftBooking` to after
 * `resolveBookingLodgeId` and `assertMemberMayBookLodge` — reintroducing the
 * pre-#2701 race exactly — left all four assertions green, because the third
 * transaction's correctly-ordered markers were still downstream in the slice.
 * Only `createWaitlistedBooking` was genuinely pinned, and only because nothing
 * follows it.
 */
function transactionSlices(body: string, starts: readonly string[]): string[] {
  const offsets = starts.map((start) => {
    const at = body.indexOf(start);
    expect(at, `missing transaction opener: ${start}`).toBeGreaterThan(-1);
    return at;
  });
  // Bounds are only bounds if the openers appear in the order given; a source
  // reorder must fail loudly rather than silently widen a slice.
  for (let i = 1; i < offsets.length; i += 1) {
    expect(
      offsets[i],
      `transaction openers are out of source order at index ${i}`,
    ).toBeGreaterThan(offsets[i - 1]);
  }
  return offsets.map((from, i) =>
    body.slice(from, i + 1 < offsets.length ? offsets[i + 1] : body.length),
  );
}

describe("lodge admission and assignment lock topology (#2701)", () => {
  it("keeps every booking admission path behind the lodge key and post-lock scope reads", () => {
    const body = source("src/lib/booking-create.ts");
    const lock = "await acquireLodgeCapacityLock(tx, lodgeId);";
    const resolve = "const bookingLodgeId = await resolveBookingLodgeId(";

    expect(body.split(lock)).toHaveLength(4);
    expect(body.split(resolve)).toHaveLength(3);

    const slices = transactionSlices(body, [
      "const newBooking = await prisma.$transaction(async (tx) => {",
      "booking = await withOptionalTransaction(input.tx, async (tx) => {",
      "const { newBooking, position } = await prisma.$transaction(async (tx) => {",
    ]);
    for (const transaction of slices) {
      expectOrdered(transaction, [
        lock,
        "resolveBookingLodgeId(",
        "await assertMemberMayBookLodge(tx,",
      ]);
      // Each slice must carry its OWN lock — with the old unbounded slice a
      // transaction that had lost its lock entirely still found a later one's.
      expect(
        transaction.split(lock).length - 1,
        "a booking-admission transaction takes the lodge key exactly once",
      ).toBe(1);
    }
  });

  it("keeps lodge deactivation in config-to-capacity order with post-lock predicates", () => {
    const body = source("src/app/api/admin/lodges/[id]/route.ts");
    // The deactivation predicate itself moved into `lodge-deactivation-guard`
    // (#2887) because the route held two hand-copied versions of it, one either
    // side of the lock. What this case pins is unchanged: both locks, then the
    // re-read, then the predicate, then the write — in that order.
    expectOrdered(body, [
      "await acquireConfigImportLock(tx);",
      "await acquireLodgeCapacityLock(tx, parsedParams.data.id);",
      "const lockedExisting = await tx.lodge.findUnique(",
      "const lockedRefusal = await findLodgeDeactivationRefusal(tx, {",
      "const lodge = await tx.lodge.update(",
    ]);
    // …and the route no longer carries a second copy that could drift from it.
    expect(body).not.toContain("tx.memberLodgeAccess.count(");
    expect(body).not.toContain("prisma.memberLodgeAccess.count(");
  });

  it("puts EVERY HutLeaderAssignment writer behind the lodge key (#2887)", () => {
    // The doc in CONCURRENCY_AND_LOCKING claims one lodge cannot end up with
    // two overlapping hut leaders. Nothing enforces that in the database, so
    // the claim is only as true as the writer census: all three must decide
    // overlap under the key. Two of them did not until #2887.
    const put = source("src/app/api/admin/hut-leaders/[id]/route.ts");
    expectOrdered(put, [
      "await prisma.$transaction(async (tx) => {",
      "await acquireLodgeCapacityLock(tx, finalLodgeId);",
      "const potentialOverlaps = await tx.hutLeaderAssignment.findMany(",
      "await tx.hutLeaderAssignment.update(",
    ]);
    // …and no unlocked writer or unlocked overlap read survives beside it.
    expect(put).not.toContain("await prisma.hutLeaderAssignment.update(");
    expect(put).not.toContain("await prisma.hutLeaderAssignment.findMany(");

    const cron = source("src/lib/cron-hut-leader-auto-assign.ts");
    expectOrdered(cron, [
      "await prisma.$transaction(async (tx) => {",
      "await acquireLodgeCapacityLock(tx, lodgeId);",
      "const potentialOverlaps = await tx.hutLeaderAssignment.findMany(",
      "await tx.hutLeaderAssignment.create(",
    ]);
    expect(cron).not.toContain("await prisma.hutLeaderAssignment.create(");
    expect(cron).not.toContain("await prisma.hutLeaderAssignment.findMany(");
    // The cron's overlap read used to scan every lodge, which both raced the
    // interactive routes and suppressed valid auto-assignments elsewhere.
    expect(cron).toContain("...lodgeNullTolerantScope(lodgeId),");
  });

  it("asks the deactivation predicate the same question before and under the lock", () => {
    // One predicate, two callers. A dependency class added to a copy rather
    // than to the shared helper is what this refuses to allow back.
    const body = source("src/app/api/admin/lodges/[id]/route.ts");
    expectOrdered(body, [
      "await findLodgeDeactivationRefusal(prisma, {",
      "await findLodgeDeactivationRefusal(tx, {",
    ]);

    const guard = source("src/lib/lodge-deactivation-guard.ts");
    for (const dependency of [
      "db.booking.count(",
      "db.hutLeaderAssignment.count(",
      "db.memberLodgeAccess.count(",
      "db.lodge.count(",
    ]) {
      expect(guard, `guard stopped reading ${dependency}`).toContain(dependency);
    }
    // The last-active-lodge rule and the dependency census are both refusals
    // the guard owns, not things a caller can forget to ask for.
    expect(guard).toContain("At least one lodge must remain active.");
    expect(guard).toContain("LODGE_HAS_DEPENDENCIES");
  });

  it("serializes role-only and bed-holding hut-leader assignments before authoritative reads", () => {
    const body = source("src/app/api/admin/hut-leaders/route.ts");
    expect(body).not.toContain("role-only assignment changes no capacity");
    expectOrdered(body, [
      "const created = await prisma.$transaction(async (tx) => {",
      "await acquireLodgeCapacityLock(tx, parsed.data.lodgeId);",
      "const lockedLodgeId = await resolveOptionalActiveLodgeId(",
      "const lockedMember = await tx.member.findUnique(",
      "const lockedOverlaps = await tx.hutLeaderAssignment.findMany(",
      "if (bedId) {",
      "await validateCustodianBedHold(",
      "const assignment = await tx.hutLeaderAssignment.create(",
    ]);
    expectOrdered(body, [
      "const { assignment } = created;",
      "await sendHutLeaderAssignmentEmail(",
    ]);
  });
});
