import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const ROUTE_MARKERS = [
  "acquireFuturePartnerSharedAllocationLocks(tx, [member.id])",
  "acquireMemberLifecycleLocks(tx, [member.id])",
  "lockHostingCoverageMemberLifecycleTarget(tx, member.id)",
  "enqueueHostingCoverageReevaluationForMember(member.id, tx,",
  "await tx.member.update({",
  "await tx.bookingGuest.updateMany({",
] as const;

function hasDeletionBarrierContract(
  route: string,
  participantHelper: string,
): boolean {
  const positions = ROUTE_MARKERS.map((marker) => route.indexOf(marker));
  const routeOrdered = positions.every(
    (position, index) =>
      position >= 0 && (index === 0 || position > positions[index - 1]),
  );
  const targetLock = participantHelper.match(
    /export async function lockHostingCoverageMemberLifecycleTarget[\s\S]*?SELECT 1[\s\S]*?FROM "Member"[\s\S]*?WHERE "id" = \$\{memberId\}[\s\S]*?FOR UPDATE[\s\S]*?if \(locked !== 1\)/,
  );
  return routeOrdered && targetLock !== null;
}

describe("account-deletion hosting target barrier (#2597)", () => {
  const route = readRepoFile(
    "src/app/api/admin/deletion-requests/[id]/route.ts",
  );
  const participantHelper = readRepoFile(
    "src/lib/adult-member-hosting-queue-participants.ts",
  );

  it("pins global/lodge -> lifecycle -> target FOR UPDATE -> fanout -> unlink", () => {
    expect(hasDeletionBarrierContract(route, participantHelper)).toBe(true);
    expect(participantHelper).not.toMatch(
      /lockHostingCoverageMemberLifecycleTarget[\s\S]*?FOR NO KEY UPDATE/,
    );
  });

  it("kills removal, downgrade, and post-fanout movement mutations", () => {
    const removed = route.replace(
      "await lockHostingCoverageMemberLifecycleTarget(tx, member.id);",
      "",
    );
    const downgraded = participantHelper.replace(
      /FOR UPDATE(\s*\n\s*`\);)/,
      "FOR NO KEY UPDATE$1",
    );
    const target =
      "await lockHostingCoverageMemberLifecycleTarget(tx, member.id);";
    const fanout =
      "await enqueueHostingCoverageReevaluationForMember(member.id, tx, {";
    const moved = route
      .replace(target, "")
      .replace(fanout, `${fanout}\n      ${target}`);

    expect(hasDeletionBarrierContract(removed, participantHelper)).toBe(false);
    expect(hasDeletionBarrierContract(route, downgraded)).toBe(false);
    expect(hasDeletionBarrierContract(moved, participantHelper)).toBe(false);
  });

  it("records the only live linked-guest counterwriter that omits lock(1)", () => {
    const quotes = readRepoFile("src/lib/booking-request-quotes.ts");
    const start = quotes.indexOf(
      "export async function holdBookingRequestSlots",
    );
    const hold = quotes.slice(start);
    const lodgeLock = hold.indexOf(
      "acquireLodgeCapacityLock(tx, bookingLodgeId)",
    );
    const create = hold.indexOf("const held = await tx.booking.create({");
    const activeStatus = hold.indexOf(
      "status: BookingStatus.AWAITING_REVIEW",
      create,
    );
    const reconcile = hold.indexOf(
      "reconcileAdultMemberHostingReviewWithSiblings(held.id, tx)",
      create,
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(lodgeLock).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(lodgeLock);
    expect(activeStatus).toBeGreaterThan(create);
    expect(reconcile).toBeGreaterThan(activeStatus);
    expect(hold.slice(0, reconcile)).not.toContain("pg_advisory_xact_lock(1)");
  });
});
