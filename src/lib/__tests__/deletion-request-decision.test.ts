import { describe, expect, it, vi } from "vitest";

import {
  claimDeletionRequestApproval,
  claimDeletionRequestDecision,
  DELETION_REQUEST_ALREADY_REVIEWED_CODE,
  DELETION_REQUEST_CLAIM_NOT_HELD_CODE,
  deletionApprovalWasReleased,
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
  function releaseTx(
    overrides: {
      locked?: number;
      current?: {
        status: string;
        reviewedBy: string | null;
        adminNote: string | null;
      } | null;
      count?: number;
    } = {},
  ) {
    const executeRaw = vi.fn().mockResolvedValue(overrides.locked ?? 1);
    const findUnique = vi.fn().mockResolvedValue(
      overrides.current === undefined
        ? {
            status: "APPROVAL_IN_PROGRESS",
            reviewedBy: "admin-9",
            adminNote: "starting approval",
          }
        : overrides.current,
    );
    const updateMany = vi
      .fn()
      .mockResolvedValue({ count: overrides.count ?? 1 });
    return {
      executeRaw,
      findUnique,
      updateMany,
      tx: {
        $executeRaw: executeRaw,
        deletionRequest: { findUnique, updateMany },
      } as never,
    };
  }

  it("returns the claim to PENDING, marks the release, and reports the attribution it destroyed", async () => {
    const { tx, executeRaw, findUnique, updateMany } = releaseTx();

    const released = await releaseDeletionRequestApprovalClaim(tx, {
      id: "request-1",
      adminNote: "blocker will never clear",
    });

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
        // ...but NOT a null timestamp. `PENDING` + `reviewedAt` + no reviewer is
        // the durable marker that an approval was started and released here, and
        // it is what stops the next decider rejecting the request without being
        // told the member's stays may already be cancelled. Written by the same
        // guarded mutation as the transition, so it cannot go missing.
        reviewedAt: released.releasedAt,
      },
    });
    expect(deletionApprovalWasReleased({
      status: "PENDING",
      reviewedBy: null,
      reviewedAt: released.releasedAt,
    })).toBe(true);

    // The attribution comes from a read taken under this row's own lock, inside
    // the caller's transaction — not from an earlier unguarded read that an
    // ABA interleaving could have made stale.
    expect(released).toEqual({
      releasedAt: expect.any(Date),
      previousClaimHeldBy: "admin-9",
      previousAdminNote: "starting approval",
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "request-1" },
      select: { status: true, reviewedBy: true, adminNote: true },
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    // Lock raw, read typed (#2289): the lock selects a CONSTANT — never columns —
    // and the data comes back through the Prisma model under it. The id travels
    // as a bound parameter.
    const [lockStrings, lockValue] = executeRaw.mock.calls[0] as [
      readonly string[],
      string,
    ];
    expect(lockStrings.join("?")).toMatch(
      /SELECT\s+1\s+FROM\s+"DeletionRequest"\s+WHERE\s+"id" = \?\s+FOR UPDATE\s*$/,
    );
    expect(lockValue).toBe("request-1");

    // Lock, then read, then transition — in that order, or the attribution is a
    // guess and the transition is unprotected.
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findUnique.mock.invocationCallOrder[0],
    );
    expect(findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      updateMany.mock.invocationCallOrder[0],
    );
  });

  it("refuses when the row it locked no longer holds the claim, mutating nothing", async () => {
    const { tx, updateMany } = releaseTx({
      current: { status: "APPROVED", reviewedBy: "admin-9", adminNote: "won" },
    });

    await expect(
      releaseDeletionRequestApprovalClaim(tx, {
        id: "request-1",
        adminNote: "too late",
      }),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_CLAIM_NOT_HELD_CODE,
      statusCode: 409,
    });
    // A finalisation that committed while this release waited on the row lock
    // must not be overwritten.
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses when the request itself is gone, so the lock matched nothing", async () => {
    // A member hard delete cascades the request away. Zero locked rows is
    // emphatically not a held claim, and the follow-up model read would take a
    // FRESH statement snapshot with no lock held (#2289's zero-match exception).
    const { tx, findUnique, updateMany } = releaseTx({ locked: 0 });

    await expect(
      releaseDeletionRequestApprovalClaim(tx, {
        id: "request-1",
        adminNote: "gone",
      }),
    ).rejects.toMatchObject({ code: DELETION_REQUEST_CLAIM_NOT_HELD_CODE });
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("still fails closed if the guarded transition itself matches nothing", async () => {
    // Unreachable while the caller holds the row lock, which is the point: the
    // guard, not the lock, is the protocol every transition on this row shares,
    // so a caller that forgets the transaction cannot get a silent false
    // success.
    const { tx } = releaseTx({ count: 0 });

    await expect(
      releaseDeletionRequestApprovalClaim(tx, {
        id: "request-1",
        adminNote: "no transaction",
      }),
    ).rejects.toMatchObject({
      code: DELETION_REQUEST_CLAIM_NOT_HELD_CODE,
      statusCode: 409,
    });
  });
});

describe("the released-approval marker (#2627)", () => {
  // The marker has no column of its own: it is the (status, reviewedBy,
  // reviewedAt) combination that NO other writer of this row can produce. That
  // claim is the whole reason the predicate is trustworthy, so pin every writer's
  // output against it — a future change to any of them fails here.
  it.each([
    {
      writer: "the member's own create",
      row: { status: "PENDING", reviewedBy: null, reviewedAt: null },
      released: false,
    },
    {
      writer: "claimDeletionRequestApproval",
      row: {
        status: "APPROVAL_IN_PROGRESS",
        reviewedBy: "admin-1",
        reviewedAt: null,
      },
      released: false,
    },
    {
      writer: "claimDeletionRequestDecision (approved)",
      row: {
        status: "APPROVED",
        reviewedBy: "admin-1",
        reviewedAt: new Date("2026-08-01T00:00:00Z"),
      },
      released: false,
    },
    {
      writer: "claimDeletionRequestDecision (rejected)",
      row: {
        status: "REJECTED",
        reviewedBy: "admin-1",
        reviewedAt: new Date("2026-08-01T00:00:00Z"),
      },
      released: false,
    },
    {
      writer: "releaseDeletionRequestApprovalClaim",
      row: {
        status: "PENDING",
        reviewedBy: null,
        reviewedAt: new Date("2026-08-01T00:00:00Z"),
      },
      released: true,
    },
  ])("reads $writer as released=$released", ({ row, released }) => {
    expect(deletionApprovalWasReleased(row)).toBe(released);
  });

  it("reads the marker off the JSON the admin queue is served", () => {
    // The admin client derives the row warning from the same predicate over the
    // API's serialised shape, where a Date has become an ISO string.
    expect(
      deletionApprovalWasReleased({
        status: "PENDING",
        reviewedBy: null,
        reviewedAt: "2026-08-01T00:00:00.000Z",
      }),
    ).toBe(true);
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
