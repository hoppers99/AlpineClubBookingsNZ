import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPrismaTransaction = vi.fn();
const mockTxMemberFindUnique = vi.fn();
const mockTxMemberUpdateMany = vi.fn();
const mockTxMemberFindMany = vi.fn();
const mockTxTokenDeleteMany = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockPrismaTransaction(...args),
    member: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ageTierSetting: {
      findMany: vi.fn(),
    },
    passwordResetToken: {
      create: vi.fn(),
    },
    emailLog: {
      findFirst: vi.fn(),
    },
    auditLog: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("../email", () => ({
  sendAgeUpInvitationEmail: vi.fn(),
  sendAgeUpParentEmailHandoffEmail: vi.fn(),
}));

vi.mock("../logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../utils", () => ({
  getSeasonYear: vi.fn(() => 2026),
}));

// Best-effort Xero contact-group trigger (E8, #1934): mocked so we can assert
// it fires after a durable tier flip and never for skipped/handoff members.
const mockTriggerGroupSync = vi.fn();
vi.mock("../xero-contact-groups", () => ({
  triggerMemberXeroContactGroupSync: (...args: unknown[]) =>
    mockTriggerGroupSync(...args),
}));

import { prisma } from "../prisma";
import {
  sendAgeUpInvitationEmail,
  sendAgeUpParentEmailHandoffEmail,
} from "../email";
import { AGE_TIER_DEFAULTS, invalidateAgeTierCache } from "../age-tier";
import { checkAgeUpMembers } from "../cron-age-up";

const mockedFindMany = vi.mocked(prisma.member.findMany);
const mockedMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockedMemberFindUnique = vi.mocked(prisma.member.findUnique);
const mockedUpdate = vi.mocked(prisma.member.update);
const mockedAgeTierSettingsFindMany = vi.mocked(prisma.ageTierSetting.findMany);
const mockedCreateToken = vi.mocked(prisma.passwordResetToken.create);
const mockedEmailLogFind = vi.mocked(prisma.emailLog.findFirst);
const mockedAuditLogFind = vi.mocked(prisma.auditLog.findFirst);
const mockedAuditLogCreate = vi.mocked(prisma.auditLog.create);
const mockedSendEmail = vi.mocked(sendAgeUpInvitationEmail);
const mockedSendHandoffEmail = vi.mocked(sendAgeUpParentEmailHandoffEmail);

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAgeTierCache();
  mockedAgeTierSettingsFindMany.mockResolvedValue(
    AGE_TIER_DEFAULTS.map((setting) => ({
      ...setting,
      xeroAcceptedContactGroups: [],
    })) as any
  );
  mockPrismaTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        member: {
          findUnique: mockTxMemberFindUnique,
          update: mockedUpdate,
          updateMany: mockTxMemberUpdateMany,
          // #2255: after clearing the aged-up member's own inheritance, the job
          // re-resolves their dependants' DERIVED pointers through them — those
          // pointers had walked PAST this member precisely because they had no
          // address. Defaulted to "no dependants", which is what most fixtures
          // here describe; the dedicated case below overrides it.
          findMany: mockTxMemberFindMany,
        },
        passwordResetToken: {
          create: mockedCreateToken,
          deleteMany: mockTxTokenDeleteMany,
        },
      })
  );
  mockedMemberFindFirst.mockResolvedValue(null);
  mockedMemberFindUnique.mockResolvedValue(null);
  mockedAuditLogFind.mockResolvedValue(null);
  mockedAuditLogCreate.mockResolvedValue({} as any);
  mockTxMemberFindUnique.mockResolvedValue({
    canLogin: false,
    ageTier: "YOUTH",
    inheritEmailFromId: null,
    inheritParentEmail: false,
    parentMemberId: null,
  });
  mockTxMemberUpdateMany.mockResolvedValue({ count: 1 });
  mockTxMemberFindMany.mockResolvedValue([]);
  mockTxTokenDeleteMany.mockResolvedValue({ count: 1 });
});

// Helper: create a date of birth for a given age at season start (April 1 2026)
function dobForAge(age: number): Date {
  // Season start: 2026-04-01
  // If age 18, born on or before 2008-04-01
  return new Date(2026 - age, 3, 1); // April 1, (2026 - age)
}

/** A member row as `resolveInheritedEmailSourceId` selects one. */
function familyRow(
  overrides: { id: string; email: string } & Partial<{
    ageTier: string;
    archivedAt: Date | null;
    inheritEmailFromId: string | null;
    parentMemberId: string | null;
    secondaryParentId: string | null;
  }>,
) {
  return {
    ageTier: "ADULT",
    archivedAt: null,
    inheritEmailFromId: null,
    parentMemberId: null,
    secondaryParentId: null,
    ...overrides,
  };
}

/**
 * #2282: the legacy parent handoff no longer mails the raw parent link — it
 * resolves the family's actual contact of record with `resolveInheritedEmail
 * SourceId`, the same walk every write path uses. That walk reads through
 * `prisma.member.findMany`, which is also the mock the candidate query uses, so
 * these tests dispatch on the `where` shape: the walk always asks for
 * `{ id: { in: [...] } }`, the candidate query never does.
 */
function mockCandidatesAndFamily(
  candidates: unknown[],
  family: Record<string, ReturnType<typeof familyRow>>,
) {
  mockedFindMany.mockImplementation((async (args: unknown) => {
    const ids = (args as { where?: { id?: { in?: string[] } } })?.where?.id?.in;
    if (!ids) return candidates;
    return ids.map((id) => family[id]).filter(Boolean);
  }) as never);
}

describe("checkAgeUpMembers", () => {
  /**
   * #2255 (M3). Age-up is the one AUTOMATIC event that leaves a derived email
   * pointer aimed at the wrong person. Clearing the aged-up member's own
   * inheritance gives them an address and a login of their own — but their
   * dependants' pointers had walked PAST them precisely because they had
   * neither, so those pointers still name the grandparent, and a parent who now
   * has a mailbox would never receive their own child's notifications.
   */
  describe("dependants' inherited email follows the member up (#2255)", () => {
    function agingMemberWithDependant(
      dependants: Array<{ id: string; inheritEmailFromId?: string }>,
      ancestorsOfAgingMember: string[] = [],
    ) {
      mockedFindMany.mockResolvedValue([
        {
          id: "m1",
          email: "youth@example.com",
          firstName: "Alice",
          lastName: "Smith",
          dateOfBirth: dobForAge(18),
          inheritEmailFromId: null,
          inheritEmailFrom: null,
        },
      ] as any);
      mockedEmailLogFind.mockResolvedValue(null);
      mockedUpdate.mockResolvedValue({} as any);
      mockedCreateToken.mockResolvedValue({} as any);
      mockedSendEmail.mockResolvedValue(undefined);
      mockTxMemberFindMany.mockImplementation(async ({ where }: any) => {
        // The derived-dependant lookup, now additionally scoped to pointers
        // that could only have been resolved through this member.
        if (where?.inheritParentEmail === true) {
          // Models the DATABASE, not the intent: an ABSENT `inheritEmailFromId`
          // clause is no constraint at all, so every dependant matches. Getting
          // this backwards (filtering when the clause is missing) makes the
          // regression this scoping exists to fix look fixed — the mutation
          // that deletes the clause would return nothing and the test would
          // pass for exactly the wrong reason.
          const allowedSources: string[] | null =
            where.inheritEmailFromId?.in ?? null;
          if (!allowedSources) return dependants;
          return dependants.filter((dependant: any) =>
            allowedSources.includes(dependant.inheritEmailFromId),
          );
        }
        // Two readers of the "these ids" shape: the ancestor walk that builds
        // the allowed-source set, and the email resolver walking up from the
        // aged-up member, who now qualifies as a source in their own right.
        if (where?.id?.in) {
          return where.id.in.map((id: string) => ({
            id,
            email: "youth@example.com",
            ageTier: "ADULT",
            archivedAt: null,
            inheritEmailFromId: null,
            parentMemberId:
              id === "m1" ? (ancestorsOfAgingMember[0] ?? null) : null,
            secondaryParentId: null,
          }));
        }
        return [];
      });
    }

    it("re-points a dependant's derived pointer at the newly-adult parent", async () => {
      agingMemberWithDependant([
        { id: "kid-1", inheritEmailFromId: "m1" },
        { id: "kid-2", inheritEmailFromId: "m1" },
      ]);

      await checkAgeUpMembers();

      expect(mockTxMemberUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["kid-1", "kid-2"] } },
        data: { inheritEmailFromId: "m1", inheritParentEmail: true },
      });
    });

    it("only looks at DERIVED pointers, never hand-picked ones", async () => {
      agingMemberWithDependant([{ id: "kid-1", inheritEmailFromId: "m1" }]);

      await checkAgeUpMembers();

      // A manually-chosen source is the admin's decision; the query must not
      // be able to pick one up in the first place.
      const derivedLookup = mockTxMemberFindMany.mock.calls
        .map(([args]: any) => args?.where)
        .find((where: any) => where?.inheritParentEmail !== undefined);
      expect(derivedLookup).toMatchObject({ inheritParentEmail: true });
    });

    it("writes nothing when the member has no dependants", async () => {
      agingMemberWithDependant([]);

      await checkAgeUpMembers();

      const inheritanceWrites = mockTxMemberUpdateMany.mock.calls.filter(
        ([args]: any) => args?.data?.inheritEmailFromId !== undefined,
      );
      expect(inheritanceWrites).toEqual([]);
    });

    /**
     * A dependant of the aged-up member is not automatically a dependant whose
     * pointer came THROUGH them. With two parents recorded, the pointer may name
     * the other parent — either because resolution went that way, or because an
     * admin picked that parent explicitly. `inheritParentEmail` cannot tell those
     * two apart (both store `true`), so the selection is scoped by WHERE the
     * pointer currently points instead: only a member this one's own chain could
     * have produced is re-pointed.
     */
    it("re-points a pointer at its own grandparent", async () => {
      agingMemberWithDependant(
        [{ id: "kid-1", inheritEmailFromId: "gran-1" }],
        ["gran-1"],
      );

      await checkAgeUpMembers();

      expect(mockTxMemberUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["kid-1"] } },
        data: { inheritEmailFromId: "m1", inheritParentEmail: true },
      });
    });

    it("leaves a pointer at the OTHER parent alone", async () => {
      // Q is the child's second parent and is not in m1's own chain, so the
      // pointer was resolved through Q's side (or chosen by an admin) — either
      // way it is not this job's to move.
      agingMemberWithDependant(
        [{ id: "kid-1", inheritEmailFromId: "parent-q" }],
        ["gran-1"],
      );

      await checkAgeUpMembers();

      const inheritanceWrites = mockTxMemberUpdateMany.mock.calls.filter(
        ([args]: any) => args?.data?.inheritEmailFromId !== undefined,
      );
      expect(inheritanceWrites).toEqual([]);
    });

    it("scopes the lookup to sources this member's own chain could produce", async () => {
      agingMemberWithDependant(
        [{ id: "kid-1", inheritEmailFromId: "gran-1" }],
        ["gran-1"],
      );

      await checkAgeUpMembers();

      const derivedLookup = mockTxMemberFindMany.mock.calls
        .map(([args]: any) => args?.where)
        .find((where: any) => where?.inheritParentEmail !== undefined);
      expect(derivedLookup).toEqual({
        inheritParentEmail: true,
        inheritEmailFromId: { in: ["m1", "gran-1"] },
        OR: [{ parentMemberId: "m1" }, { secondaryParentId: "m1" }],
      });
    });
  });

  it("should upgrade a YOUTH member who turned 18", async () => {
    const member = {
      id: "m1",
      email: "youth@example.com",
      firstName: "Alice",
      lastName: "Smith",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.upgraded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    // Check member was updated
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: {
        canLogin: true,
        ageTier: "ADULT",
        inheritEmailFromId: null,
        inheritParentEmail: false,
      },
    });

    // Check password reset token was created
    expect(mockedCreateToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: "m1",
        tokenHash: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    });

    // Check email was sent
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "youth@example.com",
      "Alice",
      expect.any(String),
      expect.objectContaining({
        targetAgeTier: "ADULT",
        targetAgeTierLabel: "Adult (18+)",
        targetAgeTierMinAge: 18,
      })
    );

    // E8 (#1934): the best-effort Xero contact-group re-sync fires after the
    // tier flip has committed.
    expect(mockTriggerGroupSync).toHaveBeenCalledTimes(1);
    expect(mockTriggerGroupSync).toHaveBeenCalledWith("m1", {
      reason: "cron_age_up",
    });
  });

  it("does not fire the Xero contact-group trigger when the flip is skipped (parent handoff)", async () => {
    const member = {
      id: "m-handoff",
      email: "shared@example.com",
      firstName: "Kid",
      lastName: "Smith",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: "parent-1",
      inheritEmailFrom: { id: "parent-1", email: "shared@example.com" },
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: "parent-1",
      inheritParentEmail: false,
      parentMemberId: null,
    });
    mockedSendHandoffEmail.mockResolvedValue(undefined as any);

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    // No tier flip happened, so no grouping trigger fires.
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("upgrades normally once the member has a unique email and inheritance is cleared", async () => {
    const member = {
      id: "m-unique-family-link",
      email: "unique-youth@example.com",
      firstName: "Una",
      lastName: "Unique",
      dateOfBirth: dobForAge(18),
      parentMemberId: "parent-keep",
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: {
        id: "parent-keep",
        email: "parent-keep@example.com",
        firstName: "Keep",
        lastName: "Parent",
      },
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: false,
      parentMemberId: "parent-keep",
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(1);
    expect(result.handoff).toBe(0);
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: "m-unique-family-link" },
      data: {
        canLogin: true,
        ageTier: "ADULT",
        inheritEmailFromId: null,
        inheritParentEmail: false,
      },
    });
    expect((mockedUpdate.mock.calls[0]![0] as any).data).not.toHaveProperty(
      "parentMemberId"
    );
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "unique-youth@example.com",
      "Una",
      expect.any(String),
      expect.objectContaining({
        targetAgeTierLabel: "Adult (18+)",
      })
    );
  });

  /**
   * The IN-TRANSACTION re-check, which nothing exercised (found by mutation
   * probe while re-verifying #2282's safeguarding claims: blanking the whole
   * in-transaction condition left the suite green, because every existing case
   * is decided by `resolveAgeUpParentEmailHandoff` on the candidate row read
   * OUTSIDE the transaction).
   *
   * It is not redundant. The candidate list is read, then each member is
   * processed one at a time, so an admin can link a member as an inheriting
   * dependant in between — and under READ COMMITTED the transaction sees that
   * write while the candidate row in memory does not. Without this clause the
   * job would enable a login and clear the inheritance that had just been set,
   * which is the one automatic action in the system that can hand a minor's
   * mailbox back to them without anyone deciding to.
   *
   * Mutation probe: replace the `currentMember.inheritEmailFromId || (...)`
   * condition with `false` and this test upgrades the member instead.
   */
  it("abandons the upgrade when inheritance appears between the read and the write", async () => {
    const member = {
      id: "m-race",
      email: "race@example.com",
      firstName: "Rae",
      lastName: "Race",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);
    // The transaction's own view: a link landed while this member was queued.
    // ONLY the resolved-source column is set, so this test isolates the first
    // half of the disjunction — with `inheritParentEmail`/`parentMemberId` also
    // set, the legacy half would catch it and the first half could be deleted
    // with the suite still green (which is exactly what the probe found).
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: "parent-late",
      inheritParentEmail: false,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("abandons the upgrade on a LEGACY inheritance appearing mid-run", async () => {
    // The second half of the same disjunction — `inheritParentEmail` with a
    // parent but no resolved source — so deleting either half fails a test.
    const member = {
      id: "m-race-legacy",
      email: "race2@example.com",
      firstName: "Rob",
      lastName: "Race",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: true,
      parentMemberId: "parent-late",
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  /**
   * The rest of the same in-transaction condition (#2282 review). A later
   * mutation sweep found three conjuncts still surviving: dropping
   * `&& parentMemberId`, `currentMember.canLogin ||`, and
   * `currentMember.ageTier === "ADULT" ||` all left the suite green, so the
   * clause was only a third pinned. Each case below kills exactly one.
   */
  function racingMember(id: string) {
    return {
      id,
      email: `${id}@example.com`,
      firstName: "Race",
      lastName: "Case",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: null,
    };
  }

  it("abandons the upgrade when a login is enabled between the read and the write", async () => {
    // `canLogin` is what stops the job issuing a SECOND password-reset token and
    // invitation to a member who was given a login mid-run.
    mockedFindMany.mockResolvedValue([racingMember("m-login")] as never);
    mockedEmailLogFind.mockResolvedValue(null);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: true,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: false,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("abandons the upgrade when the member is already ADULT in the transaction", async () => {
    mockedFindMany.mockResolvedValue([racingMember("m-adult")] as never);
    mockedEmailLogFind.mockResolvedValue(null);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "ADULT",
      inheritEmailFromId: null,
      inheritParentEmail: false,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("upgrades a member whose inheritParentEmail flag stands with no parent", async () => {
    // The `&& parentMemberId` half. A member detached by a cancellation or a
    // hard delete can be left carrying `inheritParentEmail: true` with no parent
    // and no source — inheriting from nobody. There is nothing to protect, so
    // dropping that conjunct (making the flag alone disqualifying) would strand
    // exactly these members at YOUTH for ever.
    mockedFindMany.mockResolvedValue([racingMember("m-stranded")] as never);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as never);
    mockedCreateToken.mockResolvedValue({} as never);
    mockedSendEmail.mockResolvedValue(undefined);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: true,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(1);
    expect(mockedUpdate).toHaveBeenCalled();
  });

  it("should skip members who already received age-up email", async () => {
    const member = {
      id: "m2",
      email: "already@example.com",
      firstName: "Bob",
      lastName: "Jones",
      dateOfBirth: dobForAge(19),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue({ id: "el1" } as any);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("sends parent handoff and does not update or tokenize when inheritEmailFromId is set", async () => {
    const member = {
      id: "m3",
      email: "child@placeholder.com",
      firstName: "Charlie",
      lastName: "Brown",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: "parent1",
      inheritEmailFrom: {
        id: "parent1",
        email: "parent@example.com",
        firstName: "Pat",
        lastName: "Parent",
      },
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedSendHandoffEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(result.handoff).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "parent@example.com",
      expect.objectContaining({
        recipientName: "Pat Parent",
        memberFirstName: "Charlie",
        memberLastName: "Brown",
        targetAgeTierLabel: "Adult (18+)",
        targetAgeTierMinAge: 18,
      })
    );
    expect(mockedAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "member.age_up.parent_email_handoff_sent",
        subjectMemberId: "m3",
        entityType: "Member",
        entityId: "m3",
        metadata: expect.objectContaining({
          handoffReason: "inheritEmailFrom",
          sourceMemberId: "parent1",
        }),
      }),
    });
  });

  it("sends parent handoff for legacy inheritParentEmail with parentMemberId", async () => {
    const member = {
      id: "m-legacy",
      email: "legacy-child@example.com",
      firstName: "Lee",
      lastName: "Legacy",
      dateOfBirth: dobForAge(18),
      parentMemberId: "parent-legacy",
      inheritParentEmail: true,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: {
        id: "parent-legacy",
        email: "legacy-parent@example.com",
        firstName: "Jordan",
        lastName: "Parent",
      },
    };

    mockCandidatesAndFamily([member], {
      "parent-legacy": familyRow({
        id: "parent-legacy",
        email: "legacy-parent@example.com",
      }),
    });
    mockedSendHandoffEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "legacy-parent@example.com",
      expect.objectContaining({
        recipientName: "Jordan Parent",
        memberFirstName: "Lee",
        memberLastName: "Legacy",
      })
    );
    expect(mockedAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subjectMemberId: "m-legacy",
        metadata: expect.objectContaining({
          handoffReason: "legacyParentEmail",
          sourceMemberId: "parent-legacy",
        }),
      }),
    });
  });

  /**
   * #2282 review. The legacy branch mailed `member.parent.email` outright, which
   * was only ever safe because a parent link implied an active adult — the rule
   * this issue removed. A minor parent, an archived one, or one whose only
   * address is a club-internal placeholder would now receive (or silently fail
   * to receive) another member's age-up notice.
   *
   * Mutation probe: put `member.parent?.email` back in place of the resolved
   * source and this test mails the 16-year-old instead of the grandparent.
   */
  it("routes the legacy handoff PAST a young parent to the contact of record", async () => {
    const member = {
      id: "m-young-parent",
      email: "kid@example.com",
      firstName: "Kea",
      lastName: "Rangi",
      dateOfBirth: dobForAge(18),
      parentMemberId: "tui",
      inheritParentEmail: true,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: {
        id: "tui",
        email: "tui@example.com",
        firstName: "Tui",
        lastName: "Rangi",
      },
    };

    mockCandidatesAndFamily([member], {
      tui: familyRow({
        id: "tui",
        email: "tui@example.com",
        ageTier: "YOUTH",
        parentMemberId: "nan",
      }),
      nan: familyRow({ id: "nan", email: "nan@example.com" }),
    });
    mockedMemberFindUnique.mockResolvedValue({
      id: "nan",
      email: "nan@example.com",
      firstName: "Nan",
      lastName: "Rangi",
    } as never);
    mockedSendHandoffEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(1);
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "nan@example.com",
      expect.objectContaining({ recipientName: "Nan Rangi" }),
    );
    expect(mockedSendHandoffEmail).not.toHaveBeenCalledWith(
      "tui@example.com",
      expect.anything(),
    );
  });

  it("declines the legacy handoff when the family reaches nobody", async () => {
    // No adult anywhere above the parent. Mailing the minor was the old
    // behaviour; the member is left for a human instead, because the
    // in-transaction guard then refuses the upgrade too.
    const member = {
      id: "m-no-source",
      email: "kid2@example.com",
      firstName: "Kim",
      lastName: "Rangi",
      dateOfBirth: dobForAge(18),
      parentMemberId: "tui",
      inheritParentEmail: true,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: {
        id: "tui",
        email: "tui@example.com",
        firstName: "Tui",
        lastName: "Rangi",
      },
    };

    mockCandidatesAndFamily([member], {
      tui: familyRow({
        id: "tui",
        email: "tui@example.com",
        ageTier: "YOUTH",
      }),
    });
    mockedEmailLogFind.mockResolvedValue(null);
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "YOUTH",
      inheritEmailFromId: null,
      inheritParentEmail: true,
      parentMemberId: "tui",
    });

    const result = await checkAgeUpMembers();

    expect(mockedSendHandoffEmail).not.toHaveBeenCalled();
    expect(result.handoff).toBe(0);
    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("sends parent handoff when the youth email matches another login member", async () => {
    const member = {
      id: "m-shared",
      email: "shared@example.com",
      firstName: "Sam",
      lastName: "Shared",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedMemberFindFirst.mockResolvedValue({
      id: "login-holder",
      email: "shared@example.com",
      firstName: "Alex",
      lastName: "Holder",
    } as any);
    mockedSendHandoffEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreateToken).not.toHaveBeenCalled();
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "shared@example.com",
      expect.objectContaining({
        recipientName: "Alex Holder",
        memberFirstName: "Sam",
        memberLastName: "Shared",
      })
    );
    expect(mockedAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subjectMemberId: "m-shared",
        metadata: expect.objectContaining({
          handoffReason: "sharedLoginEmail",
          sourceMemberId: "login-holder",
        }),
      }),
    });
  });

  it("dedupes handoff per youth member rather than recipient email", async () => {
    const parent = {
      id: "parent1",
      email: "parent@example.com",
      firstName: "Pat",
      lastName: "Parent",
    };
    const member1 = {
      id: "handoff-already",
      email: "one@example.com",
      firstName: "One",
      lastName: "Youth",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: "parent1",
      inheritEmailFrom: parent,
      parent: null,
    };
    const member2 = {
      id: "handoff-new",
      email: "two@example.com",
      firstName: "Two",
      lastName: "Youth",
      dateOfBirth: dobForAge(18),
      parentMemberId: null,
      inheritParentEmail: false,
      inheritEmailFromId: "parent1",
      inheritEmailFrom: parent,
      parent: null,
    };

    mockedFindMany.mockResolvedValue([member1, member2] as any);
    mockedAuditLogFind
      .mockResolvedValueOnce({ id: "existing-audit" } as any)
      .mockResolvedValueOnce(null);
    mockedSendHandoffEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.handoff).toBe(1);
    expect(result.skipped).toBe(1);
    expect(mockedSendHandoffEmail).toHaveBeenCalledTimes(1);
    expect(mockedSendHandoffEmail).toHaveBeenCalledWith(
      "parent@example.com",
      expect.objectContaining({
        memberFirstName: "Two",
        memberLastName: "Youth",
      })
    );
    expect(mockedAuditLogFind).toHaveBeenNthCalledWith(1, {
      where: {
        action: "member.age_up.parent_email_handoff_sent",
        subjectMemberId: "handoff-already",
        outcome: "success",
      },
      select: { id: true },
    });
    expect(mockedAuditLogFind).toHaveBeenNthCalledWith(2, {
      where: {
        action: "member.age_up.parent_email_handoff_sent",
        subjectMemberId: "handoff-new",
        outcome: "success",
      },
      select: { id: true },
    });
  });

  it("should handle no candidates gracefully", async () => {
    mockedFindMany.mockResolvedValue([]);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(0);
    expect(result.upgraded).toBe(0);
    expect(result.handoff).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("should skip member with null dateOfBirth", async () => {
    const member = {
      id: "m4",
      email: "nodob@example.com",
      firstName: "Dee",
      lastName: "NoDob",
      dateOfBirth: null,
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);

    const result = await checkAgeUpMembers();

    expect(result.skipped).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("does not age-up a member concurrently flipped to N/A (#2106 MINOR-7)", async () => {
    const member = {
      id: "m-na",
      email: "na@example.com",
      firstName: "Nora",
      lastName: "Na",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    // The in-transaction re-read sees a member who was flipped to N/A after the
    // batch selection — the re-check must short-circuit and leave them alone.
    mockTxMemberFindUnique.mockResolvedValue({
      canLogin: false,
      ageTier: "NOT_APPLICABLE",
      inheritEmailFromId: null,
      inheritParentEmail: false,
      parentMemberId: null,
    });

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("should count failed members when update throws", async () => {
    const member = {
      id: "m5",
      email: "fail@example.com",
      firstName: "Eve",
      lastName: "Fail",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockRejectedValue(new Error("DB error"));

    const result = await checkAgeUpMembers();

    expect(result.failed).toBe(1);
    expect(result.upgraded).toBe(0);
  });

  it("should roll back the member upgrade and setup token when email delivery fails", async () => {
    const member = {
      id: "m-email-fail",
      email: "email-fail@example.com",
      firstName: "Failure",
      lastName: "Retry",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockRejectedValue(new Error("SMTP down"));

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(mockPrismaTransaction).toHaveBeenCalledTimes(2);
    expect(mockTxTokenDeleteMany).toHaveBeenCalledWith({
      where: {
        memberId: "m-email-fail",
        tokenHash: expect.any(String),
        used: false,
      },
    });
    expect(mockTxMemberUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "m-email-fail",
        canLogin: true,
        ageTier: "ADULT",
      },
      data: {
        canLogin: false,
        ageTier: "YOUTH",
        inheritEmailFromId: null,
        inheritParentEmail: false,
      },
    });
  });

  it("should process multiple members independently", async () => {
    const member1 = {
      id: "m6",
      email: "a@example.com",
      firstName: "Aaa",
      lastName: "One",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };
    const member2 = {
      id: "m7",
      email: "b@example.com",
      firstName: "Bbb",
      lastName: "Two",
      dateOfBirth: dobForAge(20),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member1, member2] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.processed).toBe(2);
    expect(result.upgraded).toBe(2);
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedSendEmail).toHaveBeenCalledTimes(2);
  });

  it("should create a 7-day expiry token", async () => {
    const member = {
      id: "m8",
      email: "token@example.com",
      firstName: "Frank",
      lastName: "Token",
      dateOfBirth: dobForAge(18),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    await checkAgeUpMembers();

    const tokenCall = mockedCreateToken.mock.calls[0][0];
    const expiresAt = (tokenCall as any).data.expiresAt as Date;
    const now = Date.now();
    // Should expire in ~7 days (allow 1 minute tolerance)
    const diffDays = (expiresAt.getTime() - now) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("should query for the correct member criteria", async () => {
    mockedFindMany.mockResolvedValue([]);

    await checkAgeUpMembers();

    expect(mockedFindMany).toHaveBeenCalledWith({
      where: {
        active: true,
        canLogin: false,
        // NOT_APPLICABLE (organisations/schools, #1440) must never age up.
        ageTier: { notIn: ["ADULT", "NOT_APPLICABLE"] },
        dateOfBirth: {
          not: null,
          lte: expect.any(Date),
        },
      },
      select: expect.objectContaining({
        id: true,
        email: true,
        firstName: true,
        dateOfBirth: true,
        parentMemberId: true,
        inheritParentEmail: true,
        inheritEmailFromId: true,
        inheritEmailFrom: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        parent: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      }),
    });

    // Verify cutoff date is 18 years before season start (April 1, 2026)
    // Cutoff should be April 1, 2008
    const cutoff = (mockedFindMany.mock.calls[0]![0] as any).where.dateOfBirth;
    const cutoffDate = cutoff.lte as Date;
    expect(cutoffDate.getFullYear()).toBe(2008);
    expect(cutoffDate.getMonth()).toBe(3); // April
    expect(cutoffDate.getDate()).toBe(1);
  });

  it("should use the configured ADULT age tier for cutoff and email data", async () => {
    mockedAgeTierSettingsFindMany.mockResolvedValue([
      {
        tier: "CHILD",
        minAge: 0,
        maxAge: 12,
        label: "Junior",
        sortOrder: 1,
        subscriptionRequiredForBooking: false,
        xeroAcceptedContactGroups: [],
      },
      {
        tier: "YOUTH",
        minAge: 13,
        maxAge: 20,
        label: "Youth",
        sortOrder: 2,
        subscriptionRequiredForBooking: true,
        xeroAcceptedContactGroups: [],
      },
      {
        tier: "ADULT",
        minAge: 21,
        maxAge: null,
        label: "Senior (21+)",
        sortOrder: 3,
        subscriptionRequiredForBooking: true,
        xeroAcceptedContactGroups: [],
      },
    ] as any);

    const member = {
      id: "m-adult-21",
      email: "adult21@example.com",
      firstName: "Alex",
      lastName: "Boundary",
      dateOfBirth: dobForAge(21),
      inheritEmailFromId: null,
      inheritEmailFrom: null,
    };

    mockedFindMany.mockResolvedValue([member] as any);
    mockedEmailLogFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({} as any);
    mockedCreateToken.mockResolvedValue({} as any);
    mockedSendEmail.mockResolvedValue(undefined);

    const result = await checkAgeUpMembers();

    expect(result.upgraded).toBe(1);
    const cutoff = (mockedFindMany.mock.calls[0]![0] as any).where.dateOfBirth;
    const cutoffDate = cutoff.lte as Date;
    expect(cutoffDate.getFullYear()).toBe(2005);
    expect(cutoffDate.getMonth()).toBe(3);
    expect(cutoffDate.getDate()).toBe(1);
    expect(mockedSendEmail).toHaveBeenCalledWith(
      "adult21@example.com",
      "Alex",
      expect.any(String),
      {
        targetAgeTier: "ADULT",
        targetAgeTierLabel: "Senior (21+)",
        targetAgeTierMinAge: 21,
      }
    );
  });
});

describe("ageUpInvitationTemplate", () => {
  it("should generate HTML with member name and reset URL", async () => {
    const { ageUpInvitationTemplate } = await import("../email-templates");

    const html = ageUpInvitationTemplate("Alice", "https://example.com/reset?token=abc");

    expect(html).toContain("Alice");
    expect(html).toContain("https://example.com/reset?token=abc");
    expect(html).toContain("Adult (18+)");
    expect(html).toContain("Set Up My Password");
  });

  it("should use the configured target age tier label", async () => {
    const { ageUpInvitationTemplate } = await import("../email-templates");

    const html = ageUpInvitationTemplate(
      "Alice",
      "https://example.com/reset?token=abc",
      { targetAgeTierLabel: "Senior (21+)" }
    );

    expect(html).toContain("Senior (21+)");
    expect(html).not.toContain("turned 18");
  });

  it("should escape HTML in firstName", async () => {
    const { ageUpInvitationTemplate } = await import("../email-templates");

    const html = ageUpInvitationTemplate("<script>alert('xss')</script>", "https://example.com");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("ageUpParentEmailHandoffTemplate", () => {
  it("generates a tokenless handoff message and escapes member data", async () => {
    const { ageUpParentEmailHandoffTemplate } = await import("../email-templates");

    const html = ageUpParentEmailHandoffTemplate({
      recipientName: "Pat Parent",
      memberFirstName: "<Charlie>",
      memberLastName: "Brown",
      targetAgeTierLabel: "Adult (18+)",
    });

    expect(html).toContain("Pat Parent");
    expect(html).toContain("&lt;Charlie&gt; Brown");
    expect(html).toContain("unique email address");
    expect(html).not.toContain("token=");
    expect(html).not.toContain("Set Up My Password");
  });
});

describe("sendAgeUpInvitationEmail", () => {
  it("should be importable and callable", async () => {
    // Verify the function exists and accepts the right params
    expect(typeof sendAgeUpInvitationEmail).toBe("function");
  });
});
