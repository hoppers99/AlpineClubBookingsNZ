import { describe, expect, it, vi } from "vitest";

import { enqueueHostingCoverageReevaluation } from "@/lib/adult-member-hosting-coverage-queue";
import { tryLockHostingCoverageOwners } from "@/lib/adult-member-hosting-coverage-lock";
import { buildMemberMergeHostingCoveragePlan } from "@/lib/adult-member-hosting-review";
import {
  acquireHostingCoverageQueueParticipantProof,
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_BODY,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantFenceUnavailableError,
  HostingCoverageParticipantRetryError,
  isPostgresLockNotAvailable,
  isHostingCoverageParticipantRetry,
  lockActiveBookingRequestLinkedMembers,
  lockHostingCoverageMemberLifecycleTarget,
  lockMemberMergeHostingCoverageParticipants,
  type HostingCoverageQueueParticipantProof,
} from "@/lib/adult-member-hosting-queue-participants";

const SOURCE = {
  bookingId: "booking-1",
  ownerMemberId: "owner-1",
  lodgeId: "lodge-1",
} as const;

function makeDb(
  foundIds = ["actor-1", "owner-1"],
  source: {
    bookingId: string;
    ownerMemberId: string;
    lodgeId: string;
  } = SOURCE,
) {
  return {
    // PostgreSQL adapters may report 0 for SELECT ... FOR KEY SHARE. The
    // authoritative identity proof is the typed Member read below.
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi
      .fn()
      .mockResolvedValue(foundIds.slice().sort().map((id) => ({ id }))),
    member: {
      findMany: vi
        .fn()
        .mockResolvedValue(foundIds.slice().sort().map((id) => ({ id }))),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: source.bookingId,
          memberId: source.ownerMemberId,
          lodgeId: source.lodgeId,
        },
      ]),
    },
    hostingCoverageReevaluation: {
      create: vi.fn().mockResolvedValue({ id: "queue-1" }),
    },
  };
}

describe("hosting coverage queue participant fence (#2597)", () => {
  it("locks a lifecycle target with exact FOR UPDATE NOWAIT and rejects a missing row", async () => {
    const db = {
      $executeRaw: vi.fn().mockResolvedValue(1),
    };

    await expect(
      lockHostingCoverageMemberLifecycleTarget(db as never, "target-1"),
    ).resolves.toBeUndefined();
    const query = db.$executeRaw.mock.calls[0][0] as {
      strings?: readonly string[];
      values?: readonly unknown[];
    };
    expect(query.strings?.join("?")).toMatch(
      /FROM "Member"\s+WHERE "id" = \?\s+FOR UPDATE NOWAIT\s*$/,
    );
    expect(query.strings?.join("?")).not.toContain("FOR NO KEY UPDATE");
    expect(query.values).toEqual(["target-1"]);

    db.$executeRaw.mockResolvedValueOnce(0);
    await expect(
      lockHostingCoverageMemberLifecycleTarget(db as never, "target-1"),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
  });

  it("maps direct and wrapped lifecycle-target 55P03 errors to the stable retry", async () => {
    const db = {
      $executeRaw: vi
        .fn()
        .mockRejectedValueOnce({ code: "55P03" })
        .mockRejectedValueOnce({
          driverAdapterError: { cause: { originalCode: "55P03" } },
        })
        .mockRejectedValueOnce(new Error("connection lost")),
    };

    await expect(
      lockHostingCoverageMemberLifecycleTarget(db as never, "target-1"),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
    await expect(
      lockHostingCoverageMemberLifecycleTarget(db as never, "target-1"),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
    await expect(
      lockHostingCoverageMemberLifecycleTarget(db as never, "target-1"),
    ).rejects.toThrow("connection lost");
  });

  it("locks and re-reads exact sorted linked members as active and unarchived", async () => {
    const db = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      member: {
        findMany: vi.fn().mockResolvedValue([
          { id: "member-a", active: true, archivedAt: null },
          { id: "member-b", active: true, archivedAt: null },
        ]),
      },
    };

    await expect(
      lockActiveBookingRequestLinkedMembers(
        db as never,
        ["member-b", "member-a", "member-b"],
      ),
    ).resolves.toBeUndefined();

    const query = db.$executeRaw.mock.calls[0][0] as {
      strings?: readonly string[];
      values?: readonly unknown[];
    };
    expect(query.strings?.join("?")).toMatch(
      /FROM "Member"\s+WHERE "id" IN \(\?,\?\)\s+ORDER BY "id"\s+FOR KEY SHARE\s*$/,
    );
    expect(query.values).toEqual(["member-a", "member-b"]);
    expect(db.member.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["member-a", "member-b"] } },
      orderBy: { id: "asc" },
      select: { id: true, active: true, archivedAt: true },
    });
  });

  it("maps linked-member row-lock 55P03 without running the eligibility read", async () => {
    const db = {
      $executeRaw: vi.fn().mockRejectedValue({ code: "55P03" }),
      member: { findMany: vi.fn() },
    };

    await expect(
      lockActiveBookingRequestLinkedMembers(db as never, ["member-a"]),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
    expect(db.member.findMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      members: [{ id: "member-a", active: false, archivedAt: null }],
      state: "inactive",
    },
    {
      members: [{ id: "member-a", active: true, archivedAt: new Date() }],
      state: "archived",
    },
    { members: [], state: "missing" },
  ])("rejects a $state linked member after the row lock", async ({ members }) => {
    const db = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      member: { findMany: vi.fn().mockResolvedValue(members) },
    };

    await expect(
      lockActiveBookingRequestLinkedMembers(db as never, ["member-a"]),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
  });

  it("locks the sorted de-duplicated owner and actor in one NOWAIT statement", async () => {
    const db = makeDb();
    const proof = await acquireHostingCoverageQueueParticipantProof(
      { sources: [SOURCE, SOURCE], actorMemberId: "actor-1" },
      db as never,
    );

    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(
      (db.$executeRaw.mock.calls[0][0] as { values?: unknown[] }).values,
    ).toEqual(["actor-1", "owner-1"]);
    expect(
      (
        db.$executeRaw.mock.calls[0][0] as {
          strings?: readonly string[];
        }
      ).strings?.join("?"),
    ).toMatch(/ORDER BY "id"\s+FOR KEY SHARE NOWAIT/);
    expect(db.member.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["actor-1", "owner-1"] } },
      orderBy: { id: "asc" },
      select: { id: true },
    });

    await expect(
      enqueueHostingCoverageReevaluation(
        {
          memberId: "owner-1",
          lodgeId: "lodge-1",
          nights: ["2026-08-01"],
          cause: "SYSTEM_CHANGE",
          actorMemberId: "actor-1",
          sourceBookingId: "booking-1",
        },
        proof,
        db as never,
      ),
    ).resolves.toBe("queue-1");
  });

  it("rejects a forged proof and performs no queue write", async () => {
    const db = makeDb();
    // Structurally valid on purpose: this only fails because the capability was
    // not issued by the participant-lock helper. An empty cast would still
    // explode later if the WeakSet guard were deleted and would not kill that
    // security-relevant mutation.
    const forged = Object.freeze({
      lockedMemberIds: Object.freeze(["owner-1"]),
      sources: Object.freeze([SOURCE]),
    }) as HostingCoverageQueueParticipantProof;

    await expect(
      enqueueHostingCoverageReevaluation(
        {
          memberId: "owner-1",
          lodgeId: "lodge-1",
          nights: ["2026-08-01"],
          cause: "SYSTEM_CHANGE",
          sourceBookingId: "booking-1",
        },
        forged,
        db as never,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: HOSTING_COVERAGE_RETRY_CODE,
      message: HOSTING_COVERAGE_RETRY_MESSAGE,
    });
    expect(db.hostingCoverageReevaluation.create).not.toHaveBeenCalled();
  });

  it("rejects a final actor or owner absent from the exact locked set", async () => {
    const db = makeDb(["owner-1"]);
    const proof = await acquireHostingCoverageQueueParticipantProof(
      { sources: [SOURCE] },
      db as never,
    );

    await expect(
      enqueueHostingCoverageReevaluation(
        {
          memberId: "owner-1",
          lodgeId: "lodge-1",
          nights: ["2026-08-01"],
          cause: "OFFICER_OVERRIDE",
          actorMemberId: "actor-late",
          reason: "Approved",
          sourceBookingId: "booking-1",
        },
        proof,
        db as never,
      ),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
    expect(db.hostingCoverageReevaluation.create).not.toHaveBeenCalled();
  });

  it("maps direct and recursively wrapped 55P03 without parsing messages", async () => {
    expect(isPostgresLockNotAvailable({ code: "55P03" })).toBe(true);
    expect(
      isPostgresLockNotAvailable({
        meta: {
          cause: {
            driverAdapterError: {
              cause: { cause: { originalCode: "55P03" } },
            },
          },
        },
      }),
    ).toBe(true);
    expect(isPostgresLockNotAvailable({ message: "55P03" })).toBe(false);

    for (const error of [
      { code: "55P03" },
      {
        meta: {
          cause: {
            driverAdapterError: {
              cause: { cause: { originalCode: "55P03" } },
            },
          },
        },
      },
    ]) {
      const db = makeDb();
      db.$executeRaw.mockRejectedValueOnce(error);
      await expect(
        acquireHostingCoverageQueueParticipantProof(
          { sources: [SOURCE] },
          db as never,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: HOSTING_COVERAGE_RETRY_CODE,
      });
      expect(db.member.findMany).not.toHaveBeenCalled();
      expect(db.hostingCoverageReevaluation.create).not.toHaveBeenCalled();
    }
  });

  it("recognises only the stable retry code through retained service causes", () => {
    const direct = new HostingCoverageParticipantRetryError();
    expect(isHostingCoverageParticipantRetry(direct)).toBe(true);
    expect(
      isHostingCoverageParticipantRetry({ cause: { error: direct } }),
    ).toBe(true);
    expect(
      isHostingCoverageParticipantRetry({
        message: HOSTING_COVERAGE_RETRY_MESSAGE,
      }),
    ).toBe(false);
    expect(HOSTING_COVERAGE_RETRY_BODY).toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
    });
  });

  it("refuses missing typed identities after the raw lock", async () => {
    const db = makeDb(["owner-1"]);
    await expect(
      acquireHostingCoverageQueueParticipantProof(
        { sources: [SOURCE], actorMemberId: "actor-gone" },
        db as never,
      ),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
  });

  it("ignores a zero raw SELECT result and trusts the exact typed identity read", async () => {
    const db = makeDb(["actor-1", "owner-1"]);

    await expect(
      acquireHostingCoverageQueueParticipantProof(
        { sources: [SOURCE], actorMemberId: "actor-1" },
        db as never,
      ),
    ).resolves.toBeDefined();
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.member.findMany).toHaveBeenCalledTimes(1);
  });

  it("refuses a merge participant set when the typed read omits a locked id", async () => {
    const db = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      member: {
        findMany: vi.fn().mockResolvedValue([
          { id: "master-1" },
          { id: "owner-1" },
        ]),
      },
    };

    await expect(
      lockMemberMergeHostingCoverageParticipants(db as never, {
        masterId: "master-1",
        loserId: "loser-1",
        ownerMemberIds: ["owner-1"],
      }),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
  });

  it("refuses source owner or lodge drift after the participant lock", async () => {
    const ownerDriftDb = makeDb(["owner-1"], {
      ...SOURCE,
      ownerMemberId: "owner-moved",
    });
    await expect(
      acquireHostingCoverageQueueParticipantProof(
        { sources: [SOURCE] },
        ownerDriftDb as never,
      ),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);

    const lodgeDriftDb = makeDb(["owner-1"], {
      ...SOURCE,
      lodgeId: "lodge-moved",
    });
    await expect(
      acquireHostingCoverageQueueParticipantProof(
        { sources: [SOURCE] },
        lodgeDriftDb as never,
      ),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
  });

  it("tries sorted coverage-owner keys and fails without waiting on a later key", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ locked: false }]);
    await expect(
      tryLockHostingCoverageOwners(
        { $queryRaw: queryRaw },
        ["owner-b", "owner-a", "owner-a"],
      ),
    ).resolves.toBe(false);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("fails loudly when the coverage try-lock returns an unverified shape", async () => {
    await expect(
      tryLockHostingCoverageOwners(
        {
          $queryRaw: vi.fn().mockResolvedValue([{ held: true }]),
        },
        ["owner-1"],
      ),
    ).rejects.toThrow(/hosting coverage owner try-lock/);
  });

  it("plans merge SYSTEM_CHANGE rows actorless and names applicable owner keys", async () => {
    const booking = {
      id: "booking-1",
      memberId: "owner-1",
      lodgeId: "lodge-1",
      checkIn: new Date("2026-08-01T00:00:00Z"),
      checkOut: new Date("2026-08-03T00:00:00Z"),
    };
    const db = {
      booking: {
        findMany: vi.fn(({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            "guests" in where || "id" in where ? [booking] : [],
          ),
        ),
      },
      adultMemberHostingPolicy: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "policy-1",
            scopeKey: "club-wide",
            lodgeId: null,
            mode: "ENFORCED",
            capacityMode: "NO_HOLD",
            version: 1,
            hostScopeSameBooking: true,
            hostScopeSameBookingOwner: true,
          },
        ]),
      },
    };
    const plan = await buildMemberMergeHostingCoveragePlan(
      {
        masterId: "master-1",
        capturedLoserOwnedBookingIds: ["booking-1"],
      },
      db as never,
    );
    expect(plan.coverageOwnerIds).toEqual(["owner-1"]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      memberId: "owner-1",
      sourceBookingId: "booking-1",
      cause: "SYSTEM_CHANGE",
      actorMemberId: null,
    });
  });
});

/**
 * A2 (#2618 review): the fence must be impossible to disable by passing a
 * client that cannot lock. An issued proof is a capability — it enters the
 * module's WeakSet and therefore satisfies
 * assertHostingCoverageQueueParticipantsLocked at every downstream call site —
 * so issuing one without the lock would not merely skip a check here, it would
 * silently switch the check off everywhere the proof travels.
 */
describe("participant proof cannot exist without its lock", () => {
  it("refuses a client that cannot take the row lock instead of issuing a proof", async () => {
    const db = makeDb();
    const { $executeRaw: _omitted, ...withoutRawLock } = db;

    await expect(
      acquireHostingCoverageQueueParticipantProof(
        { sources: [SOURCE], actorMemberId: "actor-1" },
        withoutRawLock as never,
      ),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantFenceUnavailableError);
  });

  it("does not dress the wiring fault as retryable contention", async () => {
    // A 409 retry contract here would invite an endless client retry loop: no
    // amount of retrying grows the client a $executeRaw method.
    const db = makeDb();
    const { $executeRaw: _omitted, ...withoutRawLock } = db;

    const error = await acquireHostingCoverageQueueParticipantProof(
      { sources: [SOURCE], actorMemberId: "actor-1" },
      withoutRawLock as never,
    ).catch((err: unknown) => err);

    // It must have thrown at all — a returned proof here would mean the fence
    // was bypassed, which is the failure this whole describe block exists for.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HostingCoverageParticipantRetryError);
    expect(isHostingCoverageParticipantRetry(error)).toBe(false);
  });

  it("takes FOR KEY SHARE NOWAIT over the exact sorted participant set", async () => {
    const db = makeDb();

    await acquireHostingCoverageQueueParticipantProof(
      { sources: [SOURCE], actorMemberId: "actor-1" },
      db as never,
    );

    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = JSON.stringify(db.$executeRaw.mock.calls[0][0]);
    expect(sql).toContain("FOR KEY SHARE NOWAIT");
    // Sorted and deduplicated, so concurrent acquirers cannot deadlock.
    expect(db.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["actor-1", "owner-1"] } },
        orderBy: { id: "asc" },
      }),
    );
  });

  it("refuses when a locked participant row has vanished", async () => {
    // The lock proves nothing if the row set it protected is not the row set
    // that comes back.
    const db = makeDb(["owner-1"]);

    await expect(
      acquireHostingCoverageQueueParticipantProof(
        { sources: [SOURCE], actorMemberId: "actor-1" },
        db as never,
      ),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
  });

  it("refuses when the source booking's owner drifted under the lock", async () => {
    const db = makeDb();
    db.booking.findMany.mockResolvedValue([
      { id: SOURCE.bookingId, memberId: "someone-else", lodgeId: SOURCE.lodgeId },
    ]);

    await expect(
      acquireHostingCoverageQueueParticipantProof(
        { sources: [SOURCE], actorMemberId: "actor-1" },
        db as never,
      ),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
  });
});
