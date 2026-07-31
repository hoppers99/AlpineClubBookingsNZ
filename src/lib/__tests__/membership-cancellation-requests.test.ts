import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  participantFindMany: vi.fn(),
  participantFindUnique: vi.fn(),
  participantFindUniqueOrThrow: vi.fn(),
  participantUpdate: vi.fn(),
  participantUpdateMany: vi.fn(),
  requestCreate: vi.fn(),
  requestFindMany: vi.fn(),
  requestFindUnique: vi.fn(),
  sendAdminRequestAlert: vi.fn(),
  sendConfirmationEmail: vi.fn(),
  sendSubmittedEmail: vi.fn(),
  issueActionToken: vi.fn(),
  hashActionToken: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const prismaClient = {
    accessRoleDefinition: {
      // Empty definitions: resolution falls back to legacy bundles.
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      findUnique: mocks.memberFindUnique,
      findMany: mocks.memberFindMany,
    },
    membershipCancellationRequest: {
      create: mocks.requestCreate,
      findMany: mocks.requestFindMany,
      findUnique: mocks.requestFindUnique,
    },
    membershipCancellationRequestParticipant: {
      findMany: mocks.participantFindMany,
      findUnique: mocks.participantFindUnique,
      findUniqueOrThrow: mocks.participantFindUniqueOrThrow,
      update: mocks.participantUpdate,
      updateMany: mocks.participantUpdateMany,
    },
    $transaction: (
      callback: (tx: unknown) => Promise<unknown>,
    ) => callback(prismaClient),
  };
  return { prisma: prismaClient };
});

vi.mock("@/lib/email", () => ({
  sendAdminMembershipCancellationRequestAlert: mocks.sendAdminRequestAlert,
  sendMembershipCancellationConfirmationEmail: mocks.sendConfirmationEmail,
  sendMembershipCancellationSubmittedEmail: mocks.sendSubmittedEmail,
}));

vi.mock("@/lib/action-tokens", () => ({
  issueActionToken: mocks.issueActionToken,
  hashActionToken: mocks.hashActionToken,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  MembershipCancellationRequestError,
  createAdminMembershipCancellationRequest,
  createMembershipCancellationRequest,
  getMembershipCancellationConfirmationDetails,
  reissueParticipantConfirmationToken,
  respondToMembershipCancellationConfirmation,
} from "@/lib/membership-cancellation-requests";

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    email: "member@example.org",
    firstName: "Alice",
    lastName: "Smith",
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    role: "USER",
    accessRoles: [{ role: "USER" }],
    cancelledAt: null,
    parentMemberId: null,
    secondaryParentId: null,
    familyGroupMemberships: [
      {
        familyGroupId: "family-1",
        familyGroup: { id: "family-1", name: "Smith Family" },
      },
    ],
    ...overrides,
  };
}

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: "participant-1",
    requestId: "request-1",
    memberId: "adult-login",
    status: "PENDING_CONFIRMATION",
    confirmationTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    confirmedAt: null,
    declinedAt: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    member: member({
      id: "adult-login",
      email: "adult@example.org",
      firstName: "Bob",
      canLogin: true,
    }),
    request: {
      id: "request-1",
      requestedByMemberId: "member-1",
      status: "REQUESTED",
      reason: "Moving away",
      submittedAt: new Date("2026-05-24T00:00:00.000Z"),
      reviewedAt: null,
      completedAt: null,
      requestedBy: {
        id: "member-1",
        firstName: "Alice",
        lastName: "Smith",
        email: "member@example.org",
      },
      participants: [],
    },
    ...overrides,
  };
}

describe("membership cancellation request workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberFindUnique.mockResolvedValue(member());
    mocks.memberFindMany.mockResolvedValue([
      member(),
      member({
        id: "child-1",
        firstName: "Charlie",
        ageTier: "CHILD",
        canLogin: false,
        parentMemberId: "member-1",
        email: "member@example.org",
      }),
      member({
        id: "adult-login",
        firstName: "Bob",
        email: "adult@example.org",
        canLogin: true,
      }),
    ]);
    mocks.participantFindMany.mockResolvedValue([]);
    mocks.issueActionToken.mockReturnValue({
      token: "raw-confirmation-token",
      tokenHash: "hashed-confirmation-token",
    });
    mocks.hashActionToken.mockImplementation((token: string) => `hash:${token}`);
    mocks.sendAdminRequestAlert.mockResolvedValue(undefined);
    mocks.sendConfirmationEmail.mockResolvedValue(undefined);
    mocks.sendSubmittedEmail.mockResolvedValue(undefined);
    mocks.participantUpdateMany.mockResolvedValue({ count: 0 });
    mocks.requestCreate.mockImplementation(async (args) => ({
      id: "request-1",
      status: "REQUESTED",
      reason: args.data.reason,
      submittedAt: new Date("2026-05-24T00:00:00.000Z"),
      reviewedAt: null,
      completedAt: null,
      requestedBy: {
        id: "member-1",
        firstName: "Alice",
        lastName: "Smith",
        email: "member@example.org",
      },
      participants: args.data.participants.create.map(
        (create: Record<string, unknown>, index: number) => {
          const isOwnLoginAdult = create.memberId === "adult-login";
          return {
            id: `participant-${index + 1}`,
            memberId: create.memberId,
            status: create.status,
            confirmationTokenExpiresAt: create.confirmationTokenExpiresAt ?? null,
            confirmedAt: create.confirmedAt ?? null,
            declinedAt: null,
            createdAt: new Date("2026-05-24T00:00:00.000Z"),
            member: isOwnLoginAdult
              ? member({
                  id: "adult-login",
                  firstName: "Bob",
                  email: "adult@example.org",
                  canLogin: true,
                })
              : member({
                  id: String(create.memberId),
                  firstName:
                    create.memberId === "child-1" ? "Charlie" : "Alice",
                  email: "member@example.org",
                  canLogin: create.memberId !== "child-1",
                  ageTier: create.memberId === "child-1" ? "CHILD" : "ADULT",
                }),
          };
        },
      ),
    }));
  });

  it("creates a request and tokenizes own-login adult confirmations", async () => {
    const result = await createMembershipCancellationRequest({
      requesterMemberId: "member-1",
      participantMemberIds: ["member-1", "child-1", "adult-login"],
      reason: "Moving away",
      acknowledgedWarning: true,
      ipAddress: "203.0.113.1",
    });

    expect(result.request.participants).toHaveLength(3);
    expect(mocks.requestCreate).toHaveBeenCalledTimes(1);

    const createArgs = mocks.requestCreate.mock.calls[0][0];
    expect(createArgs.data.participants.create).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: "member-1",
          status: "REQUESTED",
          confirmationTokenHash: null,
        }),
        expect.objectContaining({
          memberId: "child-1",
          status: "REQUESTED",
          confirmationTokenHash: null,
        }),
        expect.objectContaining({
          memberId: "adult-login",
          status: "PENDING_CONFIRMATION",
          confirmationTokenHash: "hashed-confirmation-token",
        }),
      ]),
    );
    expect(JSON.stringify(createArgs)).not.toContain("raw-confirmation-token");
    expect(mocks.sendConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "adult@example.org",
        token: "raw-confirmation-token",
        requesterName: "Alice Smith",
        participantName: "Bob Smith",
      }),
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.requested",
        entityType: "MembershipCancellationRequest",
      }),
    );
  });

  it("rejects selected members with an open cancellation participant", async () => {
    mocks.participantFindMany.mockResolvedValue([
      {
        memberId: "child-1",
        status: "REQUESTED",
        request: {
          id: "request-open",
          status: "REQUESTED",
          submittedAt: new Date("2026-05-24T00:00:00.000Z"),
        },
      },
    ]);

    await expect(
      createMembershipCancellationRequest({
        requesterMemberId: "member-1",
        participantMemberIds: ["child-1"],
        acknowledgedWarning: true,
      }),
    ).rejects.toMatchObject({
      message:
        "One or more selected memberships are not eligible for cancellation requests",
      statusCode: 422,
    } satisfies Partial<MembershipCancellationRequestError>);
    expect(mocks.requestCreate).not.toHaveBeenCalled();
  });

  it("re-checks open participant rows inside the create transaction", async () => {
    // Candidate load sees no conflict, but a concurrent submission
    // creates an open participant before this transaction runs the
    // findMany guard. The transaction-time check should fail with 409.
    mocks.participantFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { memberId: "child-1" },
      ]);

    await expect(
      createMembershipCancellationRequest({
        requesterMemberId: "member-1",
        participantMemberIds: ["child-1"],
        acknowledgedWarning: true,
      }),
    ).rejects.toMatchObject({
      message:
        "One or more selected memberships already have an open cancellation request",
      statusCode: 409,
    } satisfies Partial<MembershipCancellationRequestError>);
    expect(mocks.requestCreate).not.toHaveBeenCalled();
  });

  it("confirms a pending participant by hashed token and clears the token hash", async () => {
    const current = participant();
    mocks.participantFindUnique.mockResolvedValue(current);
    mocks.participantUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.participantFindUniqueOrThrow.mockResolvedValue({
      ...current,
      status: "REQUESTED",
      confirmedAt: new Date("2026-05-24T01:00:00.000Z"),
      confirmationTokenHash: null,
      confirmationTokenExpiresAt: null,
      request: {
        ...current.request,
        participants: [
          {
            ...current,
            status: "REQUESTED",
            confirmedAt: new Date("2026-05-24T01:00:00.000Z"),
          },
        ],
      },
    });

    const response = await respondToMembershipCancellationConfirmation({
      token: "raw-confirmation-token",
      memberId: "adult-login",
      decision: "confirm",
      ipAddress: "203.0.113.1",
    });

    expect(mocks.participantFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { confirmationTokenHash: "hash:raw-confirmation-token" },
      }),
    );
    expect(mocks.participantUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "participant-1",
          confirmationTokenHash: "hash:raw-confirmation-token",
          status: "PENDING_CONFIRMATION",
          confirmationTokenExpiresAt: { gt: expect.any(Date) },
        }),
        data: expect.objectContaining({
          status: "REQUESTED",
          confirmedAt: expect.any(Date),
          confirmationTokenHash: null,
          confirmationTokenExpiresAt: null,
        }),
      }),
    );
    expect(response.message).toMatch(/confirmation has been recorded/i);
  });

  it("declines a pending participant without cancelling the membership", async () => {
    const current = participant();
    mocks.participantFindUnique.mockResolvedValue(current);
    mocks.participantUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.participantFindUniqueOrThrow.mockResolvedValue({
      ...current,
      status: "DECLINED",
      declinedAt: new Date("2026-05-24T01:00:00.000Z"),
      request: {
        ...current.request,
        participants: [
          {
            ...current,
            status: "DECLINED",
            declinedAt: new Date("2026-05-24T01:00:00.000Z"),
          },
        ],
      },
    });

    const response = await respondToMembershipCancellationConfirmation({
      token: "raw-confirmation-token",
      memberId: "adult-login",
      decision: "decline",
    });

    expect(mocks.participantUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DECLINED",
          declinedAt: expect.any(Date),
          confirmationTokenHash: null,
          confirmationTokenExpiresAt: null,
        }),
      }),
    );
    expect(response.message).toMatch(/membership remains active/i);
  });

  it("returns 409 when the atomic claim loses to a concurrent confirm", async () => {
    const current = participant();
    mocks.participantFindUnique.mockResolvedValue(current);
    // First call is the atomic claim - simulate the loser by returning 0.
    mocks.participantUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      respondToMembershipCancellationConfirmation({
        token: "raw-confirmation-token",
        memberId: "adult-login",
        decision: "confirm",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<MembershipCancellationRequestError>);
  });

  it("invalidates any other open PENDING_CONFIRMATION rows for the same member", async () => {
    const current = participant();
    mocks.participantFindUnique.mockResolvedValue(current);
    // First updateMany is the atomic claim; second is the defence-in-depth
    // sweep of stray PENDING_CONFIRMATION rows for the same member.
    mocks.participantUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mocks.participantFindUniqueOrThrow.mockResolvedValue({
      ...current,
      status: "REQUESTED",
      confirmedAt: new Date("2026-05-24T01:00:00.000Z"),
      confirmationTokenHash: null,
      confirmationTokenExpiresAt: null,
      request: {
        ...current.request,
        participants: [
          {
            ...current,
            status: "REQUESTED",
            confirmedAt: new Date("2026-05-24T01:00:00.000Z"),
          },
        ],
      },
    });

    await respondToMembershipCancellationConfirmation({
      token: "raw-confirmation-token",
      memberId: "adult-login",
      decision: "confirm",
    });

    expect(mocks.participantUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberId: "adult-login",
          status: "PENDING_CONFIRMATION",
          id: { not: "participant-1" },
        },
        data: {
          confirmationTokenHash: null,
          confirmationTokenExpiresAt: null,
        },
      }),
    );
  });

  it("reissues a participant confirmation token and resends the confirmation email", async () => {
    mocks.participantFindUnique.mockResolvedValue(participant());
    mocks.issueActionToken.mockReturnValue({
      token: "fresh-token",
      tokenHash: "fresh-token-hash",
    });
    mocks.sendConfirmationEmail.mockResolvedValue(undefined);
    mocks.requestFindUnique.mockResolvedValue({
      id: "request-1",
      requestedByMemberId: "member-1",
      status: "REQUESTED",
      reason: "Moving away",
      submittedAt: new Date("2026-05-24T00:00:00.000Z"),
      reviewedAt: null,
      completedAt: null,
      requestedBy: {
        id: "member-1",
        firstName: "Alice",
        lastName: "Smith",
        email: "member@example.org",
      },
      participants: [],
    });

    const result = await reissueParticipantConfirmationToken({
      requestId: "request-1",
      participantId: "participant-1",
      adminMemberId: "admin-9",
      ipAddress: "127.0.0.1",
    });

    expect(result.emailWarnings).toEqual([]);
    expect(mocks.participantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "participant-1" },
        data: expect.objectContaining({
          confirmationTokenHash: "fresh-token-hash",
        }),
      }),
    );
    expect(mocks.sendConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "adult@example.org",
        token: "fresh-token",
      }),
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "membership_cancellation.confirmation_token_reissued",
        actorMemberId: "admin-9",
        subjectMemberId: "adult-login",
        entityId: "participant-1",
      }),
    );
  });

  it("returns an email warning when the resent confirmation email fails", async () => {
    mocks.participantFindUnique.mockResolvedValue(participant());
    mocks.issueActionToken.mockReturnValue({
      token: "fresh-token",
      tokenHash: "fresh-token-hash",
    });
    mocks.sendConfirmationEmail.mockRejectedValueOnce(new Error("SES down"));
    mocks.requestFindUnique.mockResolvedValue({
      id: "request-1",
      requestedByMemberId: "member-1",
      status: "REQUESTED",
      reason: null,
      submittedAt: new Date("2026-05-24T00:00:00.000Z"),
      reviewedAt: null,
      completedAt: null,
      requestedBy: {
        id: "member-1",
        firstName: "Alice",
        lastName: "Smith",
        email: "member@example.org",
      },
      participants: [],
    });

    const result = await reissueParticipantConfirmationToken({
      requestId: "request-1",
      participantId: "participant-1",
      adminMemberId: "admin-9",
    });

    expect(result.emailWarnings).toHaveLength(1);
    expect(result.emailWarnings[0]).toContain("Confirmation email could not be sent");
    expect(mocks.participantUpdate).toHaveBeenCalled();
  });

  it("rejects reissue for a participant that has already confirmed", async () => {
    mocks.participantFindUnique.mockResolvedValue(
      participant({
        status: "REQUESTED",
        confirmedAt: new Date("2026-05-24T01:00:00.000Z"),
      }),
    );

    await expect(
      reissueParticipantConfirmationToken({
        requestId: "request-1",
        participantId: "participant-1",
        adminMemberId: "admin-9",
      }),
    ).rejects.toBeInstanceOf(MembershipCancellationRequestError);
    expect(mocks.participantUpdate).not.toHaveBeenCalled();
    expect(mocks.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it("rejects reissue for a participant whose cancellation request is no longer open", async () => {
    mocks.participantFindUnique.mockResolvedValue(
      participant({
        request: {
          ...participant().request,
          status: "APPROVED",
        },
      }),
    );

    await expect(
      reissueParticipantConfirmationToken({
        requestId: "request-1",
        participantId: "participant-1",
        adminMemberId: "admin-9",
      }),
    ).rejects.toBeInstanceOf(MembershipCancellationRequestError);
    expect(mocks.participantUpdate).not.toHaveBeenCalled();
  });

  it("rejects reissue when the participant belongs to a different request", async () => {
    mocks.participantFindUnique.mockResolvedValue(
      participant({ requestId: "other-request" }),
    );

    await expect(
      reissueParticipantConfirmationToken({
        requestId: "request-1",
        participantId: "participant-1",
        adminMemberId: "admin-9",
      }),
    ).rejects.toBeInstanceOf(MembershipCancellationRequestError);
  });

  describe("createAdminMembershipCancellationRequest", () => {
    function targetMember(overrides: Record<string, unknown> = {}) {
      return {
        id: "target-1",
        email: "target@example.org",
        firstName: "Target",
        lastName: "Member",
        ageTier: "ADULT",
        active: true,
        canLogin: true,
        role: "USER",
        accessRoles: [{ role: "USER" }],
        cancelledAt: null,
        archivedAt: null,
        ...overrides,
      };
    }

    function createdRequest(participantStatus = "REQUESTED") {
      return {
        id: "request-2",
        status: "REQUESTED",
        reason: "Member can no longer be reached",
        submittedAt: new Date("2026-05-25T00:00:00.000Z"),
        reviewedAt: null,
        completedAt: null,
        requestedBy: {
          id: "admin-1",
          firstName: "Admin",
          lastName: "User",
          email: "admin@example.org",
        },
        participants: [
          {
            id: "participant-admin-1",
            memberId: "target-1",
            status: participantStatus,
            confirmationTokenExpiresAt: null,
            confirmedAt: new Date("2026-05-25T00:00:00.000Z"),
            declinedAt: null,
            createdAt: new Date("2026-05-25T00:00:00.000Z"),
            member: {
              id: "target-1",
              firstName: "Target",
              lastName: "Member",
              email: "target@example.org",
              ageTier: "ADULT",
              canLogin: true,
              active: true,
            },
          },
        ],
      };
    }

    beforeEach(() => {
      mocks.memberFindUnique.mockResolvedValue(targetMember());
      mocks.participantFindMany.mockResolvedValue([]);
      mocks.requestCreate.mockResolvedValue(createdRequest());
    });

    it("creates an admin-initiated request that is reviewable immediately", async () => {
      const result = await createAdminMembershipCancellationRequest({
        targetMemberId: "target-1",
        adminMemberId: "admin-1",
        reason: "Member can no longer be reached",
        ipAddress: "203.0.113.5",
      });

      expect(result.request.id).toBe("request-2");
      expect(mocks.requestCreate).toHaveBeenCalledTimes(1);

      const createArgs = mocks.requestCreate.mock.calls[0][0];
      expect(createArgs.data).toMatchObject({
        requestedByMemberId: "admin-1",
        status: "REQUESTED",
        reason: "Member can no longer be reached",
      });
      const participants = createArgs.data.participants.create;
      expect(participants).toHaveLength(1);
      expect(participants[0]).toMatchObject({
        memberId: "target-1",
        status: "REQUESTED",
        confirmationTokenHash: null,
        confirmationTokenExpiresAt: null,
      });
      expect(participants[0].confirmedAt).toBeInstanceOf(Date);

      expect(mocks.logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "membership_cancellation.admin_requested",
          actorMemberId: "admin-1",
          subjectMemberId: "target-1",
          metadata: expect.objectContaining({ adminInitiated: true }),
        }),
      );
      expect(mocks.sendAdminRequestAlert).toHaveBeenCalled();
      expect(mocks.sendConfirmationEmail).not.toHaveBeenCalled();
      expect(mocks.sendSubmittedEmail).not.toHaveBeenCalled();
    });

    it("rejects an admin request when the target is missing", async () => {
      mocks.memberFindUnique.mockResolvedValue(null);

      await expect(
        createAdminMembershipCancellationRequest({
          targetMemberId: "missing",
          adminMemberId: "admin-1",
          reason: "Test",
        }),
      ).rejects.toMatchObject({
        statusCode: 404,
      } satisfies Partial<MembershipCancellationRequestError>);
      expect(mocks.requestCreate).not.toHaveBeenCalled();
    });

    it("rejects an admin request when the target is already cancelled", async () => {
      mocks.memberFindUnique.mockResolvedValue(
        targetMember({ cancelledAt: new Date("2025-01-01T00:00:00.000Z") }),
      );

      await expect(
        createAdminMembershipCancellationRequest({
          targetMemberId: "target-1",
          adminMemberId: "admin-1",
          reason: "Test",
        }),
      ).rejects.toMatchObject({
        message: "This membership is already cancelled",
        statusCode: 409,
      } satisfies Partial<MembershipCancellationRequestError>);
      expect(mocks.requestCreate).not.toHaveBeenCalled();
    });

    it("rejects an admin request when the target is archived", async () => {
      mocks.memberFindUnique.mockResolvedValue(
        targetMember({ archivedAt: new Date("2025-01-01T00:00:00.000Z") }),
      );

      await expect(
        createAdminMembershipCancellationRequest({
          targetMemberId: "target-1",
          adminMemberId: "admin-1",
          reason: "Test",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
      } satisfies Partial<MembershipCancellationRequestError>);
      expect(mocks.requestCreate).not.toHaveBeenCalled();
    });

    it("rejects an admin request when the target is inactive", async () => {
      mocks.memberFindUnique.mockResolvedValue(
        targetMember({ active: false }),
      );

      await expect(
        createAdminMembershipCancellationRequest({
          targetMemberId: "target-1",
          adminMemberId: "admin-1",
          reason: "Test",
        }),
      ).rejects.toMatchObject({
        message: "This membership is not active",
        statusCode: 409,
      } satisfies Partial<MembershipCancellationRequestError>);
      expect(mocks.requestCreate).not.toHaveBeenCalled();
    });

    // #2383: the account classes that may be cancelled, and the two that may
    // not. The rule used to be legacy role === "USER", which refused Full
    // Admins and organisations while quietly accepting every scoped admin.
    describe("which account classes may be cancelled (#2383)", () => {
      const accepted: Array<[string, Record<string, unknown>]> = [
        ["an ordinary member", {}],
        [
          "a dependant with no login",
          { canLogin: false, accessRoles: [] },
        ],
        [
          "a Full Admin",
          { role: "ADMIN", accessRoles: [{ role: "ADMIN" }, { role: "USER" }] },
        ],
        // Accepted under the OLD rule too (a scoped admin stores legacy role
        // USER): here as a regression pin that widening the rule did not
        // narrow it anywhere, not as evidence the widening works.
        [
          "a scoped-role admin (Membership Officer), as before",
          { role: "USER", accessRoles: [{ role: "ADMIN_MEMBERSHIP" }] },
        ],
        // The rest each require something the gate could plausibly get wrong,
        // and each fails if it does — see the mutation notes below.
        [
          // Fails unless the LODGE row is judged against the whole
          // classification rather than its mere presence (#2383 review).
          "a Booking Officer who also runs the lodge screen",
          {
            role: "USER",
            accessRoles: [{ role: "ADMIN_BOOKINGS" }, { role: "LODGE" }],
          },
        ],
        [
          // Fails unless `roleDefinitionId` is selected and read: the row's
          // `role` is null, so dropping it leaves only the LODGE row and the
          // record classifies as the kiosk device.
          "a custom definition-backed role holder who also holds lodge access",
          {
            role: "USER",
            accessRoles: [
              { role: null, roleDefinitionId: "def-lodge-ops" },
              { role: "LODGE" },
            ],
          },
        ],
        [
          // Fails unless the legacy finance column is selected and read.
          "a Treasurer recorded only by the legacy finance column",
          {
            role: "USER",
            financeAccessLevel: "MANAGER",
            accessRoles: [{ role: "LODGE" }],
          },
        ],
        [
          "an organisation account",
          { role: "SCHOOL", accessRoles: [{ role: "ORG" }] },
        ],
      ];

      for (const [label, overrides] of accepted) {
        it(`accepts ${label}`, async () => {
          mocks.memberFindUnique.mockResolvedValue(targetMember(overrides));

          const result = await createAdminMembershipCancellationRequest({
            targetMemberId: "target-1",
            adminMemberId: "admin-1",
            reason: "Test",
          });

          expect(result.request.id).toBe("request-2");
          expect(mocks.requestCreate).toHaveBeenCalled();
        });
      }

      const refused: Array<[string, Record<string, unknown>]> = [
        ["the lodge kiosk device login", { role: "LODGE", accessRoles: [] }],
        [
          "a kiosk carrying only a LODGE access-role row",
          { role: "USER", accessRoles: [{ role: "LODGE" }] },
        ],
        [
          // The legacy role alone still identifies the device, even if a stray
          // USER row is present: LODGE is the record's whole classification.
          "a kiosk whose legacy role is LODGE and holds a USER row",
          { role: "LODGE", accessRoles: [{ role: "USER" }] },
        ],
        [
          "a booking-request guest record",
          { role: "NON_MEMBER", canLogin: false, accessRoles: [] },
        ],
        [
          "a school booking-request contact or teacher record",
          { role: "SCHOOL", canLogin: false, accessRoles: [] },
        ],
      ];

      for (const [label, overrides] of refused) {
        it(`refuses ${label}`, async () => {
          mocks.memberFindUnique.mockResolvedValue(targetMember(overrides));

          await expect(
            createAdminMembershipCancellationRequest({
              targetMemberId: "target-1",
              adminMemberId: "admin-1",
              reason: "Test",
            }),
          ).rejects.toMatchObject({
            message:
              "Lodge kiosk logins and booking-request contact records hold no membership to cancel",
            statusCode: 422,
          } satisfies Partial<MembershipCancellationRequestError>);
          expect(mocks.requestCreate).not.toHaveBeenCalled();
        });
      }

      it("selects every field the eligibility rule reads", async () => {
        // Prisma is mocked here, so the cases above would still pass if the
        // query stopped selecting a field the rule depends on — in production
        // the field would simply arrive undefined and the record would be
        // misclassified as the kiosk device. Assert the query itself.
        mocks.memberFindUnique.mockResolvedValue(targetMember());

        await createAdminMembershipCancellationRequest({
          targetMemberId: "target-1",
          adminMemberId: "admin-1",
          reason: "Test",
        });

        const [[query]] = mocks.memberFindUnique.mock.calls as [
          [{ select: Record<string, unknown> }],
        ];
        expect(query.select).toMatchObject({
          role: true,
          canLogin: true,
          financeAccessLevel: true,
          accessRoles: { select: { role: true, roleDefinitionId: true } },
        });
      });
    });

    it("rejects an admin request when an open participant already exists", async () => {
      mocks.participantFindMany.mockResolvedValueOnce([
        {
          memberId: "target-1",
          status: "REQUESTED",
        },
      ]);

      await expect(
        createAdminMembershipCancellationRequest({
          targetMemberId: "target-1",
          adminMemberId: "admin-1",
          reason: "Test",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
      } satisfies Partial<MembershipCancellationRequestError>);
      expect(mocks.requestCreate).not.toHaveBeenCalled();
    });

    it("still returns the request when the admin alert email fails", async () => {
      mocks.sendAdminRequestAlert.mockRejectedValueOnce(new Error("SES down"));

      const result = await createAdminMembershipCancellationRequest({
        targetMemberId: "target-1",
        adminMemberId: "admin-1",
        reason: "Member can no longer be reached",
      });

      expect(result.request.id).toBe("request-2");
      expect(result.emailWarnings).toEqual([
        "Admin review alert could not be sent",
      ]);
    });
  });

  describe("getMembershipCancellationConfirmationDetails", () => {
    it("points an invalid link at admin reissue recovery", async () => {
      mocks.participantFindUnique.mockResolvedValue(null);

      const details = await getMembershipCancellationConfirmationDetails(
        "raw-confirmation-token",
        "adult-login",
      );

      expect(details.tokenStatus).toBe("invalid");
      expect(details.canRespond).toBe(false);
      expect(details.message).toMatch(
        /contact the club office — an administrator can send you a fresh confirmation link/i,
      );
    });

    it("points an expired link at admin reissue recovery", async () => {
      mocks.participantFindUnique.mockResolvedValue(
        participant({
          confirmationTokenExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
        }),
      );

      const details = await getMembershipCancellationConfirmationDetails(
        "raw-confirmation-token",
        "adult-login",
      );

      expect(details.tokenStatus).toBe("expired");
      expect(details.canRespond).toBe(false);
      expect(details.message).toMatch(
        /contact the club office — an administrator can send you a fresh confirmation link/i,
      );
    });
  });
});
