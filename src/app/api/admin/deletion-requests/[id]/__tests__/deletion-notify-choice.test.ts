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
  sweepFuturePartnerSharedAllocationsWithLocksHeld: vi.fn(),
  prisma: {
    deletionRequest: { findUnique: vi.fn(), updateMany: vi.fn() },
    booking: { findMany: vi.fn(), findUnique: vi.fn() },
    xeroSyncOperation: { findFirst: vi.fn() },
    xeroObjectLink: { updateMany: vi.fn() },
    // #2255: `findMany` reads who the anonymisation is about to detach and
    // `updateMany` sweeps their inheritance pointers, so club email stops being
    // aimed at the @deleted.invalid address the route has just written.
    member: {
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    familyGroupMember: { deleteMany: vi.fn() },
    bookingGuest: { updateMany: vi.fn() },
    // #2620: anonymisation revokes every outstanding credential artefact in the
    // same commit, because each of these is independently sufficient to
    // authenticate and deletion used to leave them all live.
    magicLinkToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    passwordResetToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    emailChangeToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    twoFactorEmailCode: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    twoFactorRecoveryCode: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    twoFactorSessionChallenge: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
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
  h.prisma.deletionRequest.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.booking.findMany.mockResolvedValue([]);
  h.prisma.booking.findUnique.mockResolvedValue({ status: "PENDING" });
  h.prisma.xeroSyncOperation.findFirst.mockResolvedValue(null);
  h.prisma.member.update.mockResolvedValue({});
  h.prisma.member.findUnique.mockResolvedValue({
    id: member.id,
    email: member.email,
    passwordHash: null,
    xeroContactId: null,
  });
  h.prisma.familyGroupMember.deleteMany.mockResolvedValue({ count: 0 });
  h.prisma.bookingGuest.updateMany.mockResolvedValue({ count: 0 });
  h.prisma.xeroObjectLink.updateMany.mockResolvedValue({ count: 0 });
  h.prisma.$transaction.mockImplementation(
    async (cb: (tx: typeof h.prisma) => Promise<unknown>) => cb(h.prisma),
  );
  h.isFullAdmin.mockReturnValue(true);
  h.memberHoldsPrivilegedRole.mockReturnValue(false);
  h.wouldRemoveLastFullAdmin.mockResolvedValue(false);
  h.acquireFuturePartnerSharedAllocationLocks.mockResolvedValue(undefined);
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
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-1", status: "PENDING" },
        data: expect.objectContaining({ status: "REJECTED" }),
      }),
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

  it("re-reads and reports an authoritative rejected decision without offering cleanup retry", async () => {
    h.prisma.deletionRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({ id: "req-1", status: "PENDING", member })
      .mockResolvedValueOnce({
        id: "req-1",
        status: "REJECTED",
        member,
      });

    const response = await POST(req({ action: "reject" }), { params });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      decisionFinal: true,
      finalDecision: "REJECTED",
      cancelledBookings: 0,
      memberAnonymised: false,
      memberDataAnonymised: false,
      retryAllowed: false,
    });
    expect(body).not.toHaveProperty("remainingCleanupPending");
    expect(body).not.toHaveProperty("approvalReceiptSent");
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean notifyMember with 400 and does not touch the request", async () => {
    const res = await POST(req({ action: "reject", notifyMember: "false" }), {
      params,
    });

    expect(res.status).toBe(400);
    expect(h.prisma.deletionRequest.updateMany).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionRejectedEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/deletion-requests/[id] approve carve-out (#1788)", () => {
  /**
   * #2597: approve now takes TWO guarded `deletionRequest.updateMany` calls —
   * the durable PENDING -> APPROVAL_IN_PROGRESS claim before any booking
   * cancellation commits, then APPROVAL_IN_PROGRESS -> APPROVED inside the
   * anonymisation transaction. Tests that mean "another admin won the final
   * decision" must let the first succeed and only the second lose, otherwise
   * the approval never starts and no cancellation is attempted at all.
   */
  function finalDecisionClaimLoses() {
    h.prisma.deletionRequest.updateMany.mockImplementation(
      async ({ where }: { where: { status: string } }) =>
        where.status === "PENDING" ? { count: 1 } : { count: 0 },
    );
  }

  it("reports the winning approval and anonymisation after earlier cancellations without an unsafe retry", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    h.cancelBooking.mockResolvedValueOnce({ status: 200, data: {} });
    finalDecisionClaimLoses();
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({ id: "req-1", status: "PENDING", member })
      .mockResolvedValueOnce({
        id: "req-1",
        status: "APPROVED",
        member: {
          ...member,
          firstName: "Deleted",
          lastName: "Member",
          email: "deleted-m1@deleted.invalid",
          active: false,
        },
      });

    const response = await POST(req({ action: "approve" }), { params });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      decisionFinal: true,
      finalDecision: "APPROVED",
      cancelledBookings: 1,
      memberAnonymised: true,
      memberDataAnonymised: true,
      retryAllowed: false,
    });
    expect(body).not.toHaveProperty("remainingCleanupPending");
    expect(body).not.toHaveProperty("approvalReceiptSent");
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
  });

  it("suppresses retry when the winning decision cannot be authoritatively re-read", async () => {
    finalDecisionClaimLoses();
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({ id: "req-1", status: "PENDING", member })
      .mockRejectedValueOnce(new Error("private database detail"));

    const response = await POST(req({ action: "approve" }), { params });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "DELETION_REQUEST_DECISION_STATUS_UNCONFIRMED",
      error:
        "Another administrator claimed this deletion request, but its final state could not be confirmed. Reload the deletion queue; do not retry the deletion action.",
      decisionStatusUnconfirmed: true,
      cancelledBookings: 0,
      retryAllowed: false,
    });
    expect(JSON.stringify(body)).not.toContain("private database detail");
  });
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
      remainingCleanupPending: true,
      memberAnonymised: false,
      memberDataAnonymised: false,
      approvalReceiptSent: false,
    });
    expect(h.cancelBooking).toHaveBeenCalledTimes(2);
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
    expect(h.prisma.member.update).not.toHaveBeenCalled();
  });

  it("returns stable partial-cleanup facts after an ordinary later cancellation error", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }, { id: "booking-2" }]);
    h.cancelBooking
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce(new Error("private database detail"));
    h.prisma.booking.findUnique.mockResolvedValue({ status: "CANCELLED" });

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "DELETION_CLEANUP_PARTIAL",
      error:
        "Account deletion cleanup is incomplete. The member was not anonymised and no approval receipt was sent. Retry only the remaining cleanup.",
      cancelledBookings: 2,
      cancellationPending: false,
      retryBookingId: null,
      cancellationPostProcessingUnconfirmed: true,
      reviewBookingId: "booking-2",
      remainingCleanupPending: true,
      memberAnonymised: false,
      memberDataAnonymised: false,
      approvalReceiptSent: false,
    });
    expect(h.cancelBooking).toHaveBeenCalledTimes(2);
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
  });

  it("reports status-unconfirmed instead of inventing a pending cancellation when the authoritative re-read fails", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    h.cancelBooking.mockRejectedValueOnce(new Error("post-cancel failure"));
    h.prisma.booking.findUnique.mockRejectedValueOnce(
      new Error("authoritative read unavailable"),
    );

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "DELETION_CLEANUP_PARTIAL",
      cancelledBookings: 0,
      cancellationPending: false,
      cancellationStatusUnconfirmed: true,
      retryBookingId: null,
      reviewBookingId: "booking-1",
      memberDataAnonymised: false,
      approvalReceiptSent: false,
    });
  });

  it("keeps completed cancellations when the locked last-full-admin guard later blocks anonymisation", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    h.cancelBooking.mockResolvedValueOnce({ status: 200, data: {} });
    h.wouldRemoveLastFullAdmin
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const response = await POST(req({ action: "approve" }), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "DELETION_CLEANUP_PARTIAL",
      cancelledBookings: 1,
      cancellationPending: false,
      retryBookingId: null,
      remainingCleanupPending: true,
      memberDataAnonymised: false,
      approvalReceiptSent: false,
      blocker: {
        code: "LAST_FULL_ADMIN_GUARD",
        message: expect.stringContaining("last Full Admin"),
        remedy: expect.stringContaining("another active account Full Admin access"),
      },
    });
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
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
    const heldSweepOrder =
      h.sweepFuturePartnerSharedAllocationsWithLocksHeld.mock.invocationCallOrder[0];
    const hostingEnqueueOrder =
      h.enqueueHostingCoverageReevaluationForMember.mock.invocationCallOrder[0];
    const anonymiseOrder = h.prisma.member.update.mock.invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(memberLockOrder);
    expect(memberLockOrder).toBeLessThan(heldSweepOrder);
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

  it("rolls back anonymisation when the shared standing-fanout fence retries", async () => {
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
      retryBookingId: null,
      remainingCleanupPending: true,
      memberAnonymised: false,
      memberDataAnonymised: false,
      approvalReceiptSent: false,
    });
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.prisma.bookingGuest.updateMany).not.toHaveBeenCalled();
    // #2597: finalisation is guarded on the durable claim, not on PENDING —
    // a rejection can no longer overtake an approval that has already begun.
    expect(h.prisma.deletionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-1", status: "APPROVAL_IN_PROGRESS" },
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
    expect(h.settleHostingCoverageAfterCommit).not.toHaveBeenCalled();
  });

  it("owns the approval durably before the first booking cancellation commits", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    h.cancelBooking.mockResolvedValueOnce({ status: 200, data: {} });

    const res = await POST(req({ action: "approve" }), { params });
    expect(res.status).toBe(200);

    // The claim is what makes the cleanup recoverable and un-rejectable, so it
    // must be written before any irreversible cancellation, not after.
    const claimCall = h.prisma.deletionRequest.updateMany.mock.calls.find(
      (c) => c[0]?.data?.status === "APPROVAL_IN_PROGRESS",
    );
    expect(claimCall?.[0]).toMatchObject({
      where: { id: "req-1", status: "PENDING" },
      data: { reviewedBy: "admin-1", reviewedAt: null },
    });
    const claimOrder =
      h.prisma.deletionRequest.updateMany.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(h.cancelBooking.mock.invocationCallOrder[0]);
  });

  it("refuses to start an approval a rejection already won, cancelling nothing", async () => {
    h.prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "booking-1" }]);
    // The opening claim loses: the request is no longer PENDING.
    h.prisma.deletionRequest.updateMany.mockResolvedValue({ count: 0 });
    h.prisma.deletionRequest.findUnique
      .mockResolvedValueOnce({ id: "req-1", status: "PENDING", member })
      .mockResolvedValueOnce({ id: "req-1", status: "REJECTED", member })
      .mockResolvedValueOnce({ id: "req-1", status: "REJECTED", member });

    const response = await POST(req({ action: "approve" }), { params });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      decisionFinal: true,
      finalDecision: "REJECTED",
      cancelledBookings: 0,
      retryAllowed: false,
    });
    // The whole point of claiming first: nothing destructive happened.
    expect(h.cancelBooking).not.toHaveBeenCalled();
    expect(h.prisma.member.update).not.toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
  });

  it("resumes an interrupted approval instead of refusing the retry", async () => {
    // The admin returns to a request left in APPROVAL_IN_PROGRESS by a crashed
    // or disconnected earlier attempt; the remaining cleanup must complete.
    h.prisma.deletionRequest.findUnique.mockResolvedValue({
      id: "req-1",
      status: "APPROVAL_IN_PROGRESS",
      member,
    });
    h.prisma.deletionRequest.updateMany.mockImplementation(
      async ({ where }: { where: { status: string } }) =>
        // The opening claim finds no PENDING row and falls back to the
        // findUnique resume check; finalisation then wins from the claim.
        where.status === "PENDING" ? { count: 0 } : { count: 1 },
    );

    const res = await POST(req({ action: "approve" }), { params });

    expect(res.status).toBe(200);
    expect(h.prisma.member.update).toHaveBeenCalled();
    expect(h.sendAccountDeletionApprovedEmail).toHaveBeenCalledTimes(1);
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
