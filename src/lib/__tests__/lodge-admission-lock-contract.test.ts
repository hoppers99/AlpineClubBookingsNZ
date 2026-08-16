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

describe("lodge admission and assignment lock topology (#2701)", () => {
  it("keeps every booking admission path behind the lodge key and post-lock scope reads", () => {
    const body = source("src/lib/booking-create.ts");
    const lock = "await acquireLodgeCapacityLock(tx, lodgeId);";
    const resolve = "const bookingLodgeId = await resolveBookingLodgeId(";

    expect(body.split(lock)).toHaveLength(4);
    expect(body.split(resolve)).toHaveLength(3);

    for (const transactionStart of [
      "const newBooking = await prisma.$transaction(async (tx) => {",
      "booking = await withOptionalTransaction(input.tx, async (tx) => {",
      "const { newBooking, position } = await prisma.$transaction(async (tx) => {",
    ]) {
      const transaction = body.slice(body.indexOf(transactionStart));
      expectOrdered(transaction, [
        lock,
        "resolveBookingLodgeId(",
        "await assertMemberMayBookLodge(tx,",
      ]);
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
