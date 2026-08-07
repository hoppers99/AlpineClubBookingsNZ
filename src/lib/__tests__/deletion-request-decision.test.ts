import { describe, expect, it, vi } from "vitest";

import {
  claimDeletionRequestApproval,
  claimDeletionRequestDecision,
  DELETION_REQUEST_ALREADY_REVIEWED_CODE,
  DELETION_REQUEST_CLAIM_NOT_HELD_CODE,
  OPEN_DELETION_REQUEST_STATUSES,
  releaseDeletionRequestApprovalClaim,
} from "@/lib/deletion-request-decision";

describe("deletion request approval ownership claim (#2597)", () => {
  it("moves PENDING to APPROVAL_IN_PROGRESS with one guarded mutation", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn();

    await expect(
      claimDeletionRequestApproval(
        { deletionRequest: { updateMany, findUnique } as never },
        { id: "request-1", reviewedBy: "admin-1", adminNote: "agreed" },
      ),
    ).resolves.toBe("CLAIMED");

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "request-1", status: "PENDING" },
      data: {
        status: "APPROVAL_IN_PROGRESS",
        adminNote: "agreed",
        reviewedBy: "admin-1",
        // Not a decision yet: the request is owned, not finished, so it must
        // not carry a reviewed timestamp that would read as a final outcome.
        reviewedAt: null,
      },
    });
    // The winning path costs exactly one round trip.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("resumes its own in-progress claim instead of failing the retry", async () => {
    // The claim is idempotent by design: an approval that crashed after
    // cancelling bookings must be completable, not permanently stuck.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi
      .fn()
      .mockResolvedValue({ status: "APPROVAL_IN_PROGRESS" });

    await expect(
      claimDeletionRequestApproval(
        { deletionRequest: { updateMany, findUnique } as never },
        { id: "request-1", reviewedBy: "admin-2", adminNote: null },
      ),
    ).resolves.toBe("RESUMED");

    // Resuming must not overwrite the original claim's attribution.
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(["APPROVED", "REJECTED", undefined] as const)(
    "refuses to start an approval once the request is %s",
    async (status) => {
      const updateMany = vi.fn().mockResolvedValue({ count: 0 });
      const findUnique = vi
        .fn()
        .mockResolvedValue(status ? { status } : null);

      await expect(
        claimDeletionRequestApproval(
          { deletionRequest: { updateMany, findUnique } as never },
          { id: "request-1", reviewedBy: "admin-2", adminNote: null },
        ),
      ).rejects.toMatchObject({
        code: DELETION_REQUEST_ALREADY_REVIEWED_CODE,
        statusCode: 409,
      });
    },
  );
});

describe("deletion request final decision claim", () => {
  it("finalises an approval only from its durable APPROVAL_IN_PROGRESS claim", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "APPROVED",
          reviewedBy: "admin-1",
          adminNote: "agreed",
        },
      ),
    ).resolves.toBeUndefined();

    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      id: "request-1",
      status: "APPROVAL_IN_PROGRESS",
    });
    expect(call.data.status).toBe("APPROVED");
    expect(call.data.reviewedAt).toBeInstanceOf(Date);
    // Attribution was written when the claim was taken; finalisation must not
    // silently re-stamp it to whoever happened to finish the cleanup.
    expect(call.data.reviewedBy).toBeUndefined();
    expect(call.data.adminNote).toBeUndefined();
  });

  it("finalises from PENDING when the approval never needed a claim", async () => {
    // #2627: an approval with no future bookings to cancel takes no claim, so
    // its single guarded transition is PENDING -> APPROVED. Defaulting to
    // APPROVAL_IN_PROGRESS there would match zero rows and refuse a perfectly
    // ordinary approval.
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "APPROVED",
          reviewedBy: "admin-1",
          adminNote: "agreed",
          approvalFrom: "PENDING",
        },
      ),
    ).resolves.toBeUndefined();

    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: "request-1",
      status: "PENDING",
    });
  });

  it("still defaults an approval to its durable claim when no origin is named", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await claimDeletionRequestDecision(
      { deletionRequest: { updateMany } as never },
      {
        id: "request-1",
        decision: "APPROVED",
        reviewedBy: "admin-1",
        adminNote: null,
      },
    );

    expect(updateMany.mock.calls[0][0].where.status).toBe(
      "APPROVAL_IN_PROGRESS",
    );
  });

  it("ignores an approval origin on the rejection path", async () => {
    // Rejection's guard is not negotiable: it may only ever claim PENDING.
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await claimDeletionRequestDecision(
      { deletionRequest: { updateMany } as never },
      {
        id: "request-1",
        decision: "REJECTED",
        reviewedBy: "admin-2",
        adminNote: null,
        approvalFrom: "APPROVAL_IN_PROGRESS",
      },
    );

    expect(updateMany.mock.calls[0][0].where.status).toBe("PENDING");
  });

  it("lets a rejection claim only a still-PENDING request", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "REJECTED",
          reviewedBy: "admin-2",
          adminNote: "not yet",
        },
      ),
    ).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "request-1", status: "PENDING" },
      data: expect.objectContaining({
        status: "REJECTED",
        reviewedBy: "admin-2",
        adminNote: "not yet",
      }),
    });
  });

  it("cannot reject a request whose approval already began", async () => {
    // The invariant that makes the whole intermediate state worth having: an
    // approval that has already committed booking cancellations can never be
    // overtaken by a final REJECTED. The guarded where-clause is what enforces
    // it, so a losing rejection matches zero rows.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "REJECTED",
          reviewedBy: "admin-2",
          adminNote: "late",
        },
      ),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_ALREADY_REVIEWED_CODE,
      statusCode: 409,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where.status).toBe("PENDING");
  });

  it("reports a lost approval without a second mutation", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });

    await expect(
      claimDeletionRequestDecision(
        { deletionRequest: { updateMany } as never },
        {
          id: "request-1",
          decision: "APPROVED",
          reviewedBy: "admin-1",
          adminNote: null,
        },
      ),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_ALREADY_REVIEWED_CODE,
      statusCode: 409,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("releasing a started approval (#2627)", () => {
  it("returns the claim to PENDING and clears the abandoned attribution", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await expect(
      releaseDeletionRequestApprovalClaim(
        { deletionRequest: { updateMany } as never },
        { id: "request-1", adminNote: "blocker will never clear" },
      ),
    ).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenCalledWith({
      // The guard is the whole race protection: a release that arrives while a
      // finalisation is committing waits on this row's write lock and then
      // matches nothing, and a release that commits first makes the
      // finalisation match nothing.
      where: { id: "request-1", status: "APPROVAL_IN_PROGRESS" },
      data: {
        status: "PENDING",
        adminNote: "blocker will never clear",
        // A PENDING request has no reviewer: the claim being abandoned must not
        // leave attribution behind that reads as a decision.
        reviewedBy: null,
        reviewedAt: null,
      },
    });
  });

  it("refuses when the request no longer holds the claim", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });

    await expect(
      releaseDeletionRequestApprovalClaim(
        { deletionRequest: { updateMany } as never },
        { id: "request-1", adminNote: "too late" },
      ),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_CLAIM_NOT_HELD_CODE,
      statusCode: 409,
    });
    // One guarded mutation, no second-guessing read: the row is the authority.
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("open deletion request statuses", () => {
  it("treats a mid-approval request as still open", () => {
    // Every "does this member have an outstanding deletion request?" reader
    // shares this list. Dropping APPROVAL_IN_PROGRESS would hide a request
    // that has already cancelled bookings from the admin queue, the pending
    // counts, the merge blocker and the member's own re-request guard.
    expect(OPEN_DELETION_REQUEST_STATUSES).toEqual([
      "PENDING",
      "APPROVAL_IN_PROGRESS",
    ]);
  });

  it("is a mutable array Prisma's `in` filter accepts", () => {
    expect(Array.isArray(OPEN_DELETION_REQUEST_STATUSES)).toBe(true);
  });
});
