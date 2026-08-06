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
    expect(text).toContain(
      "for (const primaryKeyChunk of chunkValues(primaryKeys))",
    );
    for (const token of [
      "for (const lockIdChunk of lockIds)",
      "Prisma.join(lockIdChunk)",
      "chunkBedAllocationRemovalIds(selectedIds)",
      "chunkBedAllocationRemovalIds(siblingIds)",
    ]) {
      expect(apply).toContain(token);
    }
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

  it("rebuilds the board auto-allocation plan only after global then lodge", () => {
    const autoRun = between(
      source("src/lib/admin-bed-allocation.ts"),
      "export async function runAutoBedAllocation(",
      "async function assertGuestAndBedForAllocation(",
    );
    expectInOrder(autoRun, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock(tx, lodgeId)",
      "getBedAllocationDashboard",
      "suggestedAllocations.map",
      "bedAllocation.createMany",
    ]);
  });

  it("locks global exactly once then lodge before each school conversion", () => {
    const school = source("src/lib/school-booking-request.ts");
    const conversions = [
      between(
        school,
        "export async function approveSchoolBookingRequest(",
        "export type MemberWholeLodgeApprovalOverride",
      ),
      school.slice(
        school.indexOf(
          "export async function approveMemberWholeLodgeRequest(",
        ),
      ),
    ];

    for (const conversion of conversions) {
      expect(conversion.match(/pg_advisory_xact_lock\(1\)/g) ?? []).toHaveLength(
        1,
      );
      expectInOrder(conversion, [
        "pg_advisory_xact_lock(1)",
        "acquireLodgeCapacityLock",
        "reconcileBedAllocationsForBookingWithLodgeLockHeld",
      ]);
    }
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

  it("locks partner-share lodges then the member before the member-detail write and held sweep", () => {
    const memberDetail = source("src/lib/admin-member-detail-service.ts");
    const transaction = between(
      memberDetail,
      "const updated = await prisma.$transaction(async (tx) => {",
      "    if (\n      existing.active !== updated.active",
    );
    expectInOrder(transaction, [
      "acquireFuturePartnerSharedAllocationLocks(tx, [id])",
      "acquireMemberLifecycleLocks(tx, [id])",
      "const updatedMember = await tx.member.update",
      "sweepFuturePartnerSharedAllocationsWithLocksHeld",
    ]);
  });

  it("locks partner-share lodges then every member before the bulk write and held sweep", () => {
    const bulkUpdate = source("src/app/api/admin/members/bulk-update/route.ts");
    const transaction = between(
      bulkUpdate,
      "const result = await prisma.$transaction(async (tx) => {",
      "    for (const { memberId, reason, swept } of sweptSharesByMember)",
    );
    expectInOrder(transaction, [
      "acquireFuturePartnerSharedAllocationLocks(tx, sweepLockMemberIds)",
      "acquireMemberLifecycleLocks(tx, sweepLockMemberIds)",
      "await tx.member.updateMany",
      "sweepFuturePartnerSharedAllocationsWithLocksHeld",
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
