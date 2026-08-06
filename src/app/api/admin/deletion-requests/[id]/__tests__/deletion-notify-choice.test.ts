import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level gating for the admin member-email choice on account-deletion
// review (#1788, mirroring #1705/#1769a): the REJECT path honours
// `notifyMember` (absent = notify, false = suppress + audited), while the
// APPROVE path always sends its final privacy receipt regardless of the flag.
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  logAudit: vi.fn(),
  isFullAdmin: vi.fn(),
  memberHoldsPrivilegedRole: vi.fn(),
  wouldRemoveLastFullAdmin: vi.fn(),
  cancelBooking: vi.fn(),
  sendAccountDeletionApprovedEmail: vi.fn(),
  sendAccountDeletionRejectedEmail: vi.fn(),
  sendAdminPartnerShareSweptAlert: vi.fn(),
  enqueueHostingCoverageReevaluationForMember: vi.fn(),
  settleHostingCoverageAfterCommit: vi.fn(),
  acquireFuturePartnerSharedAllocationLocks: vi.fn(),
  lockHostingCoverageMemberLifecycleTarget: vi.fn(),
  sweepFuturePartnerSharedAllocationsWithLocksHeld: vi.fn(),
  prisma: {
    deletionRequest: { findUnique: vi.fn(), update: vi.fn() },
    booking: { findMany: vi.fn() },
    // #2255: `findMany` reads who the anonymisation is about to detach and
    // `updateMany` sweeps their inheritance pointers, so club email stops being
    // aimed at the @deleted.invalid address the route has just written.
    member: {
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    familyGroupMember: { deleteMany: vi.fn() },
    bookingGuest: { updateMany: vi.fn() },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/booking-cancel", () => ({ cancelBooking: h.cancelBooking }));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember:
    h.enqueueHostingCoverageReevaluationForMember,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: h.settleHostingCoverageAfterCommit,
}));
vi.mock("@/lib/adult-member-hosting-queue-participants", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/adult-member-hosting-queue-participants")
  >("@/lib/adult-member-hosting-queue-participants");
  return {
    ...actual,
    lockHostingCoverageMemberLifecycleTarget:
      h.lockHostingCoverageMemberLifecycleTarget,
  };
});
vi.mock("@/lib/access-roles", () => ({
  isFullAdmin: h.isFullAdmin,
  memberHoldsPrivilegedRole: h.memberHoldsPrivilegedRole,
}));
vi.mock("@/lib/admin-account-guards", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin-account-guards")>(
    "@/lib/admin-account-guards",
  );
  return { ...actual, wouldRemoveLastFullAdmin: h.wouldRemoveLastFullAdmin };
});
vi.mock("@/lib/access-role-definitions", () => ({ MEMBER_ACCESS_ROLE_SELECT: {} }));
vi.mock("@/lib/email", () => ({
  sendAccountDeletionApprovedEmail: h.sendAccountDeletionApprovedEmail,
  sendAccountDeletionRejectedEmail: h.sendAccountDeletionRejectedEmail,
  sendAdminPartnerShareSweptAlert: h.sendAdminPartnerShareSweptAlert,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  describePartnerSharedSweepReason: vi.fn().mockReturnValue("reason"),
  partnerShareSweepCounterpartNames: vi.fn().mockReturnValue(""),
  partnerShareSweepNights: vi.fn().mockReturnValue(0),
  acquireFuturePartnerSharedAllocationLocks:
    h.acquireFuturePartnerSharedAllocationLocks,
  sweepFuturePartnerSharedAllocationsWithLocksHeld:
    h.sweepFuturePartnerSharedAllocationsWithLocksHeld,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/deletion-requests/[id]/route";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";

const member = {
  id: "m1",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  role: "MEMBER",
  financeAccessLevel: "NONE",
  active: true,
  accessRoles: [],
};

function req(body: unknown) {
  return new NextRequest("http://localhost/api/admin/deletion-requests/req-1", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "req-1" });

function deletionRejectedMetadata() {
  return h.logAudit.mock.calls.find(
    (c) => c[0]?.action === "member.deletion_rejected",
  )?.[0]?.metadata;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
  });
  h.prisma.deletionRequest.findUnique.mockResolvedValue({
    id: "req-1",
    status: "PENDING",
    member,
  });
  h.prisma.deletionRequest.update.mockResolvedValue({});
  h.prisma.booking.findMany.mockResolvedValue([]);
  h.prisma.member.update.mockResolvedValue({});
  h.prisma.familyGroupMember.deleteMany.mockResolvedValue({ count: 0 });
  h.prisma.bookingGuest.updateMany.mockResolvedValue({ count: 0 });
  h.prisma.$transaction.mockImplementation(
    async (cb: (tx: typeof h.prisma) => Promise<unknown>) => cb(h.prisma),
  );
  h.isFullAdmin.mockReturnValue(true);
  h.memberHoldsPrivilegedRole.mockReturnValue(false);
  h.wouldRemoveLastFullAdmin.mockResolvedValue(false);
  h.acquireFuturePartnerSharedAllocationLocks.mockResolvedValue(undefined);
  h.lockHostingCoverageMemberLifecycleTarget.mockResolvedValue(undefined);
  h.sweepFuturePartnerSharedAllocationsWithLocksHeld.mockResolvedValue([]);
  h.enqueueHostingCoverageReevaluationForMember.mockResolvedValue(0);
  h.settleHostingCoverageAfterCommit.mockResolvedValue({});
  h.sendAccountDeletionApprovedEmail.mockResolvedValue(undefined);
  h.sendAccountDeletionRejectedEmail.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/admin/deletion-requests/[id] reject notify choice (#1788)", () => {
  it("emails the member and records no notify field on a default reject", async () => {
    const res = await POST(req({ action: "reject" }), { params });

    expect(res.status).toBe(200);
    expect(h.sendAccountDeletionRejectedEmail).toHaveBeenCalledTimes(1);
    expect(deletionRejectedMetadata()).toBeUndefined();
  });

  it("suppresses the email and audits the choice when notifyMember is false; rejection still applied", async () => {
    const res = await POST(req({ action: "reject", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
    expect(deletionRejectedMetadata()).toMatchObject({ notifyMember: false });
    // The request is still marked REJECTED regardless of the notify choice.
    expect(h.prisma.deletionRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED" }) }),
    );
  });

  it("emails and records no notify field when notifyMember is true", async () => {
    const res = await POST(req({ action: "reject", notifyMember: true }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.sendAccountDeletionRejectedEmail).toHaveBeenCalledTimes(1);
    expect(deletionRejectedMetadata()).toBeUndefined();
  });

  it("rejects a non-boolean notifyMember with 400 and does not touch the request", async () => {
    const res = await POST(req({ action: "reject", notifyMember: "false" }), {
      params,
    });

    expect(res.status).toBe(400);
    expect(h.prisma.deletionRequest.update).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/deletion-requests/[id] approve carve-out (#1788)", () => {
  it("reports earlier cancellations truthfully when a later participant fence contends", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }, { id: "booking-2" }]);
    h.cancelBooking
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce(new HostingCoverageParticipantRetryError());

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      cancelledBookings: 1,
      cancellationPending: true,
      retryBookingId: "booking-2",
      memberDataAnonymised: false,
    });
    expect(h.cancelBooking).toHaveBeenCalledTimes(2);
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
    expect(h.prisma.member.update).not.toHaveBeenCalled();
  });

  it("always sends the approval receipt and ignores a notifyMember suppression", async () => {
    const res = await POST(req({ action: "approve", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    // The final privacy receipt sends regardless of any notify param.
    expect(h.sendAccountDeletionApprovedEmail).toHaveBeenCalledTimes(1);
    expect(h.sendAccountDeletionApprovedEmail).toHaveBeenCalledWith(
      member.email,
      member.firstName,
    );
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
    expect(h.acquireFuturePartnerSharedAllocationLocks).toHaveBeenCalledWith(
      h.prisma,
      [member.id],
    );
    const acquireOrder =
      h.acquireFuturePartnerSharedAllocationLocks.mock.invocationCallOrder[0];
    const memberLockOrder = h.prisma.$executeRaw.mock.invocationCallOrder[0];
    const targetLockOrder =
      h.lockHostingCoverageMemberLifecycleTarget.mock.invocationCallOrder[0];
    const heldSweepOrder =
      h.sweepFuturePartnerSharedAllocationsWithLocksHeld.mock.invocationCallOrder[0];
    const hostingEnqueueOrder =
      h.enqueueHostingCoverageReevaluationForMember.mock.invocationCallOrder[0];
    const anonymiseOrder = h.prisma.member.update.mock.invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(memberLockOrder);
    expect(memberLockOrder).toBeLessThan(targetLockOrder);
    expect(targetLockOrder).toBeLessThan(heldSweepOrder);
    expect(heldSweepOrder).toBeLessThan(hostingEnqueueOrder);
    expect(hostingEnqueueOrder).toBeLessThan(anonymiseOrder);
    expect(h.enqueueHostingCoverageReevaluationForMember).toHaveBeenCalledWith(
      member.id,
      h.prisma,
      { cause: "SYSTEM_CHANGE", actorMemberId: "admin-1" },
    );
    const receiptOrder = h.sendAccountDeletionApprovedEmail.mock.invocationCallOrder[0];
    expect(anonymiseOrder).toBeLessThan(receiptOrder);
    expect(receiptOrder).toBeLessThan(
      h.settleHostingCoverageAfterCommit.mock.invocationCallOrder[0],
    );
  });

  it("returns the fixed retry and performs no anonymisation when the target row disappeared", async () => {
    h.lockHostingCoverageMemberLifecycleTarget.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      cancelledBookings: 0,
      cancellationPending: false,
      memberDataAnonymised: false,
      approvalReceiptSent: false,
    });
    expect(
      h.enqueueHostingCoverageReevaluationForMember,
    ).not.toHaveBeenCalled();
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.prisma.bookingGuest.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.deletionRequest.update).not.toHaveBeenCalled();
  });

  it("rolls back anonymisation and reports completed earlier work when hosting participants changed", async () => {
    h.enqueueHostingCoverageReevaluationForMember.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      cancelledBookings: 0,
      cancellationPending: false,
      memberDataAnonymised: false,
      approvalReceiptSent: false,
    });
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.prisma.bookingGuest.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.deletionRequest.update).not.toHaveBeenCalled();
    expect(h.settleHostingCoverageAfterCommit).not.toHaveBeenCalled();
  });

  // F32 (#1888): booking.checkIn is @db.Date (NZ calendar date at UTC midnight).
  // The future-paid and future-cancellable guards must key off the NZ calendar
  // date, not a raw instant, or a stay checking in today drops out of both
  // guards for the first ~13h of the NZ day.
  it("scopes the future-booking guards to the NZ calendar date, not the raw instant", async () => {
    // NZ 2026-07-16 08:00 (NZST +12); the UTC day (Jul 15) trails the NZ day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T20:00:00.000Z"));
    try {
      const res = await POST(req({ action: "approve" }), { params });
      expect(res.status).toBe(200);

      const firstWhere = h.prisma.booking.findMany.mock.calls[0][0].where;
      expect(firstWhere.checkIn.gte.toISOString()).toBe(
        "2026-07-16T00:00:00.000Z",
      );
      // The raw-instant version would have used Date.now(); the fix must not.
      expect(firstWhere.checkIn.gte.getTime()).not.toBe(Date.now());

      // Both guards share the same date-only boundary.
      const secondWhere = h.prisma.booking.findMany.mock.calls[1][0].where;
      expect(secondWhere.checkIn.gte.toISOString()).toBe(
        "2026-07-16T00:00:00.000Z",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
