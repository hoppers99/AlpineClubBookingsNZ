import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

function expectInOrder(text: string, tokens: readonly string[]): void {
  let cursor = -1;
  for (const token of tokens) {
    const next = text.indexOf(token, cursor + 1);
    expect(next, `Expected ${token} after offset ${cursor}`).toBeGreaterThan(
      cursor,
    );
    cursor = next;
  }
}

describe("bed allocation lock topology", () => {
  it("uses immutable sorted lodge keys and one lodge-narrowed selector for approval row locks and update", () => {
    const text = source("src/lib/admin-bed-allocation.ts");
    const selector = between(
      text,
      "function buildApproveBedAllocationsWhere",
      "export async function approveBedAllocationsWithLocksHeld",
    );
    expect(selector).toContain(
      "if (input.lodgeId) where.room = lodgeNullTolerantScope(input.lodgeId)",
    );
    const approval = text.slice(
      text.indexOf("export async function approveBedAllocations(input"),
    );
    expectInOrder(approval, [
      "const lockWhere = buildApproveBedAllocationsWhere(input)",
      "await prisma.lodge.findMany",
      'orderBy: { id: "asc" }',
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "where: lockWhere",
      "ORDER BY \"id\"",
      "FOR UPDATE",
      "approveBedAllocationsWithLocksHeld",
      "createAuditLog",
    ]);
  });

  it("serializes reviewed removal global then actual sorted lodges then rows", () => {
    const text = source("src/lib/bed-allocation-removal.ts");
    const apply = text.slice(
      text.indexOf("export async function applyBedAllocationRemoval"),
    );
    expectInOrder(apply, [
      "resolveImmutableLodgeKeys",
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "ORDER BY \"id\"",
      "FOR UPDATE",
      "deleteMany",
      "updateMany",
      "BED_ALLOCATION_REMOVAL_APPLIED",
      "BED_ALLOCATION_PARTNERS_PROMOTED",
    ]);
  });

  it("keeps the reviewed-removal PostgreSQL races on the guarded CI harness and production writer entrypoints", () => {
    const harness = source(
      "src/lib/__tests__/concurrency-lock-races.realdb.test.ts",
    );
    expect(harness).toContain(
      'import "./bed-allocation-removal-races.realdb.test"',
    );

    const races = source(
      "src/lib/__tests__/bed-allocation-removal-races.realdb.test.ts",
    );
    expect(races).toContain(
      'process.env.RUN_CONCURRENCY_RACE_TESTS === "1"',
    );
    expect(races).toContain("CONCURRENCY_RACE_DATABASE_URL");
    expect(races).toContain("concurrency_race_1881");
    for (const writer of [
      "applyBedAllocationRemoval",
      "moveBedAllocationsSameDate",
      "runAutoBedAllocation",
      "reconcileBedAllocationsForBooking",
      "cancelBooking",
    ]) {
      expect(races).toContain(writer);
    }
  });

  it("locks global then lodge before the school whole-lodge conversion", () => {
    const school = source("src/lib/school-booking-request.ts");
    const conversion = school.slice(
      school.lastIndexOf("conversion = await prisma.$transaction"),
    );
    expectInOrder(conversion, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);
  });

  it("locks global, lodge, then member credit for internet-banking expiry", () => {
    const release = between(
      source("src/lib/internet-banking-payment-cron.ts"),
      "function releaseOneHold",
      "export async function releaseExpiredInternetBankingHolds",
    );
    expectInOrder(release, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "lockMemberCreditLedger",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);
  });

  it.each([
    ["src/lib/group-settlement.ts", "const candidateChildren"],
    [
      "src/lib/cron-group-settlement-reaper.ts",
      "const candidateChildren",
    ],
  ])("pre-locks and re-reads the child lodge union in %s", (file, marker) => {
    const text = source(file);
    const start = text.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const block = text.slice(start);
    expectInOrder(block, [
      "const candidateChildren",
      "candidateChildren.map((child) => child.lodgeId)",
      "acquireLodgeCapacityLock",
      "const children = await tx.booking.findMany",
      "!lockedLodgeIds.has(child.lodgeId)",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);
  });

  it("takes the global cohort lock before a cancelled booking soft delete", () => {
    const softDelete = between(
      source("src/lib/booking-delete.ts"),
      "async function softDeleteCancelledBooking",
      "async function loadBookingForDelete",
    );
    expectInOrder(softDelete, [
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "loadBookingForDelete",
      "reconcileBedAllocationsForBookingWithGlobalLockHeld",
    ]);
  });

  it("status-guards every cross-lodge waitlist unwind before reconciliation", () => {
    const text = source("src/lib/waitlist-cross-lodge.ts");
    const revert = between(
      text,
      "async function revertOfferToWaitlisted",
      "const CROSS_LODGE_MINIMUM_STAY_ERROR",
    );
    expectInOrder(revert, [
      "booking.updateMany",
      "status: BookingStatus.WAITLIST_OFFERED",
      "reverted.count === 0",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);

    const priceUnwind = between(
      text,
      'if (newBooking.finalPriceCents !== quotedPriceCents)',
      "// Phase 3",
    );
    expectInOrder(priceUnwind, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "booking.updateMany",
      "status: newBooking.status",
      "cancelled.count === 0",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
      "status: BookingStatus.WAITLIST_OFFERED",
      "return refreshedOffer.count === 1",
      "!refreshedCurrentOffer",
    ]);

    const phaseThree = text.slice(text.indexOf("// Phase 3"));
    expectInOrder(phaseThree, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "booking.updateMany",
      "status: BookingStatus.WAITLIST_OFFERED",
      "updatedAt: entry.updatedAt",
      "waitlistOfferedAt: entry.waitlistOfferedAt",
      "waitlistOfferExpiresAt: entry.waitlistOfferExpiresAt",
      "waitlistOfferedLodgeId: entry.waitlistOfferedLodgeId",
      "waitlistOfferedPriceCents: entry.waitlistOfferedPriceCents",
      "cancelled.count === 0",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);
  });

  it.each([
    ["src/lib/cron-waitlist.ts", "BookingStatus.WAITLIST_OFFERED"],
    ["src/lib/cron-complete-bookings.ts", "BookingStatus.PAID"],
  ])("uses locks, a fresh read, and a status claim in %s", (file, status) => {
    const text = source(file);
    expectInOrder(text, [
      "const candidates",
      "for (const candidate of candidates)",
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "const key = await tx.booking.findUnique",
      "acquireLodgeCapacityLock",
      "const booking = await tx.booking.findUnique",
      "booking.updateMany",
      status,
      "claimed.count === 0",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);
  });
});
