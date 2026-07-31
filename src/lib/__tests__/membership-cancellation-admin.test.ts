import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    member: {
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      // #2255: the approval reads who it is about to detach — dependants and
      // email inheritors — before the link sweep nulls those columns, so the
      // admin can be told. Defaults to "nobody", which most fixtures want.
      findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
      count: vi.fn(),
    },
    familyGroupMember: {
      deleteMany: vi.fn(),
    },
    membershipCancellationRequestParticipant: {
      update: vi.fn(),
      findMany: vi.fn(),
    },
    membershipCancellationRequest: {
      update: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(async (callback: (txArg: typeof tx) => unknown) =>
      callback(tx),
    ),
    participantFindUnique: vi.fn(),
    requestFindUnique: vi.fn(),
    requestFindMany: vi.fn(),
    requestCount: vi.fn(),
    bookingFindMany: vi.fn(),
    bookingGuestFindMany: vi.fn(),
    createAuditLog: vi.fn(),
    sendApprovedEmail: vi.fn(),
    sendRejectedEmail: vi.fn(),
    loadSettings: vi.fn(),
    queueCancellationXeroOperations: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    booking: {
      findMany: mocks.bookingFindMany,
    },
    bookingGuest: {
      findMany: mocks.bookingGuestFindMany,
    },
    membershipCancellationRequest: {
      findUnique: mocks.requestFindUnique,
      findMany: mocks.requestFindMany,
      count: mocks.requestCount,
    },
    membershipCancellationRequestParticipant: {
      findUnique: mocks.participantFindUnique,
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/email", () => ({
  sendMembershipCancellationApprovedEmail: mocks.sendApprovedEmail,
  sendMembershipCancellationRejectedEmail: mocks.sendRejectedEmail,
}));

vi.mock("@/lib/membership-cancellation-settings", () => ({
  loadMembershipCancellationSettings: mocks.loadSettings,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  queueApprovedMembershipCancellationXeroOperations:
    mocks.queueCancellationXeroOperations,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  MembershipCancellationAdminError,
  reviewMembershipCancellationParticipant,
} from "@/lib/membership-cancellation-admin";
import {
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
} from "@/lib/admin-account-guards";

const ADMIN_ACCESS_ROLES = [
  { role: "ADMIN", roleDefinitionId: null, roleDefinition: null },
];

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@example.org",
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    cancelledAt: null,
    cancelledReason: null,
    cancelledViaRequestId: null,
    ...overrides,
  };
}

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: "participant-1",
    requestId: "request-1",
    memberId: "member-1",
    status: "REQUESTED",
    reason: null,
    adminNote: null,
    confirmationTokenHash: null,
    confirmationTokenExpiresAt: null,
    confirmedAt: new Date("2026-05-24T00:00:00.000Z"),
    declinedAt: null,
    cancelledAt: null,
    reviewedByMemberId: null,
    reviewedAt: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    member: member(),
    request: {
      id: "request-1",
      status: "REQUESTED",
      reason: "Moving away",
      requestedByMemberId: "requester-1",
    },
    ...overrides,
  };
}

function adminRequest(participantOverrides: Record<string, unknown> = {}) {
  const baseParticipant = {
    ...participant(participantOverrides),
    reviewedBy: null,
    member: member(participantOverrides.member as Record<string, unknown> | undefined),
  };

  return {
    id: "request-1",
    requestedByMemberId: "requester-1",
    status: "REQUESTED",
    reason: "Moving away",
    adminNote: null,
    submittedAt: new Date("2026-05-24T00:00:00.000Z"),
    reviewedByMemberId: null,
    reviewedAt: null,
    completedAt: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    requestedBy: member({
      id: "requester-1",
      firstName: "Rae",
      lastName: "Requester",
      email: "rae@example.org",
    }),
    reviewedBy: null,
    participants: [baseParticipant],
  };
}

describe("membership cancellation admin review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.participantFindUnique.mockResolvedValue(participant());
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.bookingGuestFindMany.mockResolvedValue([]);
    // Admin-account guard defaults (#1604/#1622): a plain, non-privileged
    // target with no admins to strand, so neither guard trips.
    mocks.tx.member.findUnique.mockResolvedValue({
      role: "USER",
      financeAccessLevel: "NONE",
      accessRoles: [],
    });
    mocks.tx.member.count.mockResolvedValue(0);
    // #2255: re-seeded per test because `vi.clearAllMocks()` clears calls but
    // NOT implementations, so a fixture that stubs the detached-links reads
    // would otherwise leak into every test that follows it.
    mocks.tx.member.findMany.mockImplementation(async () => []);
    mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
      { status: "CANCELLED" },
    ]);
    mocks.requestFindUnique.mockResolvedValue(
      adminRequest({ status: "CANCELLED", cancelledAt: new Date("2026-05-24T01:00:00.000Z") }),
    );
    mocks.loadSettings.mockResolvedValue({
      rejoinProcessText: "Contact the club secretary before rejoining.",
    });
    mocks.sendApprovedEmail.mockResolvedValue(undefined);
    mocks.sendRejectedEmail.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.queueCancellationXeroOperations.mockResolvedValue({
      seasonYear: 2026,
      results: [],
    });
  });

  it("approves a confirmed participant and locally cancels the membership", async () => {
    const result = await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "approve",
      adminMemberId: "admin-1",
      adminNote: "Approved by committee",
      ipAddress: "203.0.113.1",
    });

    expect(result.request.participants[0].status).toBe("CANCELLED");
    expect(mocks.tx.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: expect.objectContaining({
        active: false,
        canLogin: false,
        cancelledAt: expect.any(Date),
        cancelledReason: "Moving away",
        cancelledViaRequestId: "request-1",
        familyGroupId: null,
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
      }),
    });
    expect(mocks.tx.familyGroupMember.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(mocks.tx.membershipCancellationRequestParticipant.update).toHaveBeenCalledWith({
      where: { id: "participant-1" },
      data: expect.objectContaining({
        status: "CANCELLED",
        adminNote: "Approved by committee",
        reviewedByMemberId: "admin-1",
        confirmationTokenHash: null,
      }),
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.participant_cancelled",
        outcome: "success",
        metadata: expect.objectContaining({ xeroCancellationDeferred: true }),
      }),
      mocks.tx,
    );
    expect(mocks.queueCancellationXeroOperations).toHaveBeenCalledWith({
      memberId: "member-1",
      requestId: "request-1",
      participantId: "participant-1",
      createdByMemberId: "admin-1",
    });
    expect(mocks.sendApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "alice@example.org",
        participantName: "Alice Smith",
        rejoinProcessText: "Contact the club secretary before rejoining.",
      }),
    );
  });

  /**
   * #2255 (D9). Approving a cancellation clears ONE level of family links: the
   * member's own parent links, and every link pointing at them. With chains of
   * up to four generations the member being cancelled is often a MIDDLE
   * generation, so that sweep silently detaches their own dependants from the
   * family and leaves anyone inheriting their address with no mailbox.
   *
   * The decided outcome is "detached and DECLARED": grandchildren are NOT
   * re-parented onto the grandparent, because who is responsible for a member
   * is a real-world fact and promoting it because someone left the club would
   * record a relationship nobody asserted — but the admin is told exactly who
   * was affected, in the response and in the audit trail.
   */
  describe("orphaned family links (#2255)", () => {
    function detaching(
      dependants: Array<{ id: string; firstName: string; lastName: string; email: string }>,
      inheritors: Array<{ id: string; firstName: string; lastName: string; email: string }> = [],
    ) {
      mocks.tx.member.findMany.mockImplementation(async ({ where }: any) =>
        where?.inheritEmailFromId ? inheritors : dependants,
      );
    }

    it("names the dependants whose parent link was cleared", async () => {
      detaching([
        { id: "grandchild-1", firstName: "Ana", lastName: "Smith", email: "ana@example.org" },
        { id: "grandchild-2", firstName: "Ben", lastName: "Smith", email: "ben@example.org" },
      ]);

      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      });

      expect(result.orphanedLinks.dependants).toEqual([
        { id: "grandchild-1", name: "Ana Smith", email: "ana@example.org" },
        { id: "grandchild-2", name: "Ben Smith", email: "ben@example.org" },
      ]);
    });

    it("names the members left without an inherited mailbox", async () => {
      detaching(
        [],
        [{ id: "kid-1", firstName: "Cai", lastName: "Smith", email: "cai@example.org" }],
      );

      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      });

      expect(result.orphanedLinks.emailInheritors).toEqual([
        { id: "kid-1", name: "Cai Smith", email: "cai@example.org" },
      ]);
    });

    it("does NOT re-parent the detached dependants onto a grandparent", async () => {
      detaching([
        { id: "grandchild-1", firstName: "Ana", lastName: "Smith", email: "ana@example.org" },
      ]);

      await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      });

      // Every write to the dependants' parent columns clears them; none sets a
      // new parent. Promoting a grandparent into the parent slot would change
      // who is legally responsible for a child, silently, as a side effect of
      // someone else's cancellation.
      const parentColumnWrites = mocks.tx.member.updateMany.mock.calls
        .map((call: unknown[]) => (call[0] as { data?: Record<string, unknown> })?.data ?? {})
        .filter(
          (data: any) =>
            "parentMemberId" in data || "secondaryParentId" in data,
        );
      expect(parentColumnWrites.length).toBeGreaterThan(0);
      for (const data of parentColumnWrites) {
        expect(Object.values(data)).toEqual([null]);
      }
    });

    it("records the detached members in the audit trail as well as the response", async () => {
      detaching(
        [{ id: "grandchild-1", firstName: "Ana", lastName: "Smith", email: "ana@example.org" }],
        [{ id: "kid-1", firstName: "Cai", lastName: "Smith", email: "cai@example.org" }],
      );

      await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      });

      expect(mocks.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "membership_cancellation.participant_cancelled",
          metadata: expect.objectContaining({
            detachedDependantIds: ["grandchild-1"],
            detachedEmailInheritorIds: ["kid-1"],
          }),
        }),
        mocks.tx,
      );
    });

    it("reports empty lists rather than omitting them when nothing was linked", async () => {
      // A caller must not have to distinguish "no key" from "nothing detached".
      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      });

      expect(result.orphanedLinks).toEqual({
        dependants: [],
        emailInheritors: [],
      });
    });
  });

  it("blocks approval when future bookings remain", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "booking-1",
        memberId: "member-1",
        checkIn: new Date("2099-01-01T00:00:00.000Z"),
        checkOut: new Date("2099-01-03T00:00:00.000Z"),
        status: "PAID",
      },
    ]);

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.approval_blocked",
        outcome: "blocked",
        metadata: {
          blockers: [
            expect.objectContaining({
              type: "owned_booking",
              bookingId: "booking-1",
            }),
          ],
        },
      }),
    );
  });

  it("blocks approval when future guest appearances remain", async () => {
    mocks.bookingGuestFindMany.mockResolvedValue([
      {
        id: "guest-1",
        memberId: "member-1",
        stayStart: new Date("2099-02-01T00:00:00.000Z"),
        stayEnd: new Date("2099-02-02T00:00:00.000Z"),
        booking: {
          id: "booking-2",
          checkIn: new Date("2099-02-01T00:00:00.000Z"),
          checkOut: new Date("2099-02-02T00:00:00.000Z"),
          status: "CONFIRMED",
        },
      },
    ]);

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.approval_blocked",
        outcome: "blocked",
        metadata: {
          blockers: [
            expect.objectContaining({
              type: "guest_appearance",
              bookingId: "booking-2",
              guestAppearanceId: "guest-1",
            }),
          ],
        },
      }),
    );
  });

  it("prevents an admin from approving a cancellation request they initiated", async () => {
    mocks.participantFindUnique.mockResolvedValue(
      participant({
        request: {
          id: "request-1",
          status: "REQUESTED",
          reason: "Moving away",
          requestedByMemberId: "admin-1",
        },
      }),
    );

    await expect(
      reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
    } satisfies Partial<MembershipCancellationAdminError>);

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a pending confirmation participant without cancelling the member", async () => {
    mocks.participantFindUnique.mockResolvedValue(
      participant({
        status: "PENDING_CONFIRMATION",
        confirmedAt: null,
        confirmationTokenHash: "hashed-token",
      }),
    );
    mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
      { status: "REJECTED" },
    ]);
    mocks.requestFindUnique.mockResolvedValue(adminRequest({ status: "REJECTED" }));

    await reviewMembershipCancellationParticipant({
      requestId: "request-1",
      participantId: "participant-1",
      action: "reject",
      adminMemberId: "admin-1",
      adminNote: "Request withdrawn",
    });

    expect(mocks.tx.member.update).not.toHaveBeenCalled();
    expect(mocks.tx.membershipCancellationRequestParticipant.update).toHaveBeenCalledWith({
      where: { id: "participant-1" },
      data: expect.objectContaining({
        status: "REJECTED",
        adminNote: "Request withdrawn",
        confirmationTokenHash: null,
        confirmationTokenExpiresAt: null,
      }),
    });
    expect(mocks.sendRejectedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "alice@example.org",
        participantName: "Alice Smith",
        adminNote: "Request withdrawn",
      }),
    );
  });

  describe("admin-account guards (#1604/#1622)", () => {
    it("blocks a scoped admin from cancelling an account holding a privileged role", async () => {
      // Target holds ADMIN; the acting admin is not a Full Admin
      // (actorIsFullAdmin count → 0), so the privileged-target guard trips.
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      mocks.tx.member.count.mockResolvedValue(0);

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "officer-1",
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: PRIVILEGED_TARGET_GUARD_MESSAGE,
      } satisfies Partial<MembershipCancellationAdminError>);

      expect(mocks.tx.member.update).not.toHaveBeenCalled();
    });

    it("blocks cancelling the last active Full Admin even for a Full Admin actor", async () => {
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      // actorIsFullAdmin → 1 (privileged-target passes); wouldRemoveLastFullAdmin
      // → target is an active Full Admin (1) with no other survivor (0).
      mocks.tx.member.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-2",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: LAST_FULL_ADMIN_GUARD_MESSAGE,
      } satisfies Partial<MembershipCancellationAdminError>);

      expect(mocks.tx.member.update).not.toHaveBeenCalled();
    });

    it("allows a Full Admin to cancel an admin-holding account when another Full Admin survives", async () => {
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      // actorIsFullAdmin → 1; target is an active Full Admin (1) but another
      // survives (1), so wouldRemoveLastFullAdmin is false.
      mocks.tx.member.count.mockResolvedValue(1);

      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-2",
      });

      expect(result.request.participants[0].status).toBe("CANCELLED");
      expect(mocks.tx.member.update).toHaveBeenCalledWith({
        where: { id: "member-1" },
        data: expect.objectContaining({ active: false, canLogin: false }),
      });
    });

    // #2383 made these guards reachable for a Full Admin target by the front
    // door: an admin's membership is now cancellable without first destroying
    // their access. The guards are the whole safety story for that, so they
    // are pinned from the widened path's point of view, not just #1604's.
    it("cannot strand the club with no Full Admin, whoever raised the request", async () => {
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      // actorIsFullAdmin → 1; target IS an active Full Admin (1); no other
      // active Full Admin survives (0).
      mocks.tx.member.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-2",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: LAST_FULL_ADMIN_GUARD_MESSAGE,
      } satisfies Partial<MembershipCancellationAdminError>);

      // The invariant is end-state, not intent: nothing was written, and no
      // Xero cancellation was queued off the back of a rolled-back approval.
      expect(mocks.tx.member.update).not.toHaveBeenCalled();
      expect(mocks.queueCancellationXeroOperations).not.toHaveBeenCalled();
    });

    it("leaves the cancelled member's access-role rows in place", async () => {
      // Deliberate (#2383): cancellation is a lifecycle terminal, not a role
      // edit. What makes that safe is `active: false` — `requireAdmin`
      // (src/lib/session-guards.ts) refuses an inactive member, and every
      // server guard re-reads `active`. NOT `canLogin: false`: that guard does
      // not even select `canLogin`, and `getAdminPermissionMatrix` zeroes the
      // matrix only on an explicit `canLogin === false`, so retained rows read
      // without that field still resolve to the full bundle. The dormant rows
      // keep the member inside the #1604 privileged-target guard for any later
      // archive. Archive and deletion approval leave them in place too, so this
      // is the house rule, not a special case — and the reason nothing may
      // reactivate a cancelled member without dealing with the rows first.
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      mocks.tx.member.count.mockResolvedValue(1);

      await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-2",
      });

      const [[update]] = mocks.tx.member.update.mock.calls as [
        [{ data: Record<string, unknown> }],
      ];
      expect(update.data).not.toHaveProperty("accessRoles");
      expect(update.data).not.toHaveProperty("role");
      expect(update.data).not.toHaveProperty("financeAccessLevel");
    });
  });

  // #2383: an admin cancelling their OWN membership was previously unreachable
  // — the role gate refused an admin target, and the member-edit screen refuses
  // to demote yourself. It is now reachable through the front door, so the
  // separation-of-duties rule has to hold on it.
  describe("self-cancellation (#2383)", () => {
    function selfRequest(adminId: string) {
      // The admin raised the request against their own membership: they are
      // both `requestedByMemberId` and the participant member.
      mocks.participantFindUnique.mockResolvedValue(
        participant({
          memberId: adminId,
          member: member({ id: adminId }),
          request: {
            id: "request-1",
            status: "REQUESTED",
            reason: "Leaving the club",
            requestedByMemberId: adminId,
          },
        }),
      );
    }

    it("refuses to let the requester approve their own cancellation", async () => {
      selfRequest("admin-1");

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-1",
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: "Cancellation requests must be approved by a different admin.",
      } satisfies Partial<MembershipCancellationAdminError>);

      expect(mocks.tx.member.update).not.toHaveBeenCalled();
    });

    it("refuses a solo Full Admin's self-cancellation even with a second reviewer", async () => {
      // The realistic departing-solo-admin case: someone else approves, but
      // there is no other active Full Admin to inherit the club.
      selfRequest("admin-1");
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      mocks.tx.member.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      await expect(
        reviewMembershipCancellationParticipant({
          requestId: "request-1",
          participantId: "participant-1",
          action: "approve",
          adminMemberId: "admin-2",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: LAST_FULL_ADMIN_GUARD_MESSAGE,
      } satisfies Partial<MembershipCancellationAdminError>);
    });

    it("completes once a successor Full Admin exists and another admin approves", async () => {
      selfRequest("admin-1");
      mocks.tx.member.findUnique.mockResolvedValue({
        role: "ADMIN",
        financeAccessLevel: "NONE",
        accessRoles: ADMIN_ACCESS_ROLES,
      });
      // A successor survives the cancellation, so the invariant holds.
      mocks.tx.member.count.mockResolvedValue(1);

      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-2",
      });

      expect(result.request.participants[0].status).toBe("CANCELLED");
      expect(mocks.tx.member.update).toHaveBeenCalledWith({
        where: { id: "admin-1" },
        data: expect.objectContaining({ active: false, canLogin: false }),
      });
    });
  });

  describe("admin notify choice (#1787)", () => {
    it("approve + notifyMember false: suppresses the email, audits the choice, still cancels the membership", async () => {
      const result = await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
        adminNote: "Approved by committee",
        notifyMember: false,
      });

      // Membership state change still applied.
      expect(result.request.participants[0].status).toBe("CANCELLED");
      expect(mocks.tx.member.update).toHaveBeenCalledWith({
        where: { id: "member-1" },
        data: expect.objectContaining({ active: false, canLogin: false }),
      });
      // No outcome email.
      expect(mocks.sendApprovedEmail).not.toHaveBeenCalled();
      // Suppression audited on the participant_cancelled record.
      const call = mocks.createAuditLog.mock.calls.find(
        (c) => c[0].action === "membership_cancellation.participant_cancelled",
      )?.[0];
      expect(call?.metadata).toMatchObject({ notifyMember: false });
    });

    it("approve + notifyMember true: emails the member and records no notify field", async () => {
      await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "approve",
        adminMemberId: "admin-1",
        notifyMember: true,
      });

      expect(mocks.sendApprovedEmail).toHaveBeenCalledTimes(1);
      const call = mocks.createAuditLog.mock.calls.find(
        (c) => c[0].action === "membership_cancellation.participant_cancelled",
      )?.[0];
      expect(call?.metadata).not.toHaveProperty("notifyMember");
    });

    it("reject + notifyMember false: suppresses the email, audits the choice, leaves the membership active", async () => {
      mocks.tx.membershipCancellationRequestParticipant.findMany.mockResolvedValue([
        { status: "REJECTED" },
      ]);
      mocks.requestFindUnique.mockResolvedValue(
        adminRequest({ status: "REJECTED" }),
      );

      await reviewMembershipCancellationParticipant({
        requestId: "request-1",
        participantId: "participant-1",
        action: "reject",
        adminMemberId: "admin-1",
        adminNote: "Not this time",
        notifyMember: false,
      });

      // Reject never mutates the member.
      expect(mocks.tx.member.update).not.toHaveBeenCalled();
      expect(mocks.sendRejectedEmail).not.toHaveBeenCalled();
      const call = mocks.createAuditLog.mock.calls.find(
        (c) => c[0].action === "membership_cancellation.participant_rejected",
      )?.[0];
      expect(call?.metadata).toMatchObject({ notifyMember: false });
    });
  });
});
