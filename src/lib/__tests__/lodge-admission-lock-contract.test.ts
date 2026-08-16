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
    expectOrdered(body, [
      "await acquireConfigImportLock(tx);",
      "await acquireLodgeCapacityLock(tx, parsedParams.data.id);",
      "const lockedExisting = await tx.lodge.findUnique(",
      "const otherActive = await tx.lodge.count(",
      "const [futureBookings, waitlistEntries, hutLeaderAssignments, kioskBindings] =",
      "const lodge = await tx.lodge.update(",
    ]);
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
