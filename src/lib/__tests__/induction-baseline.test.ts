import { describe, expect, it, vi } from "vitest";
import {
  INDUCTION_BASELINE_LOCK_SQL,
  INDUCTION_BASELINE_PROVENANCE_PREFIX,
  InductionBaselineBlockedError,
  InductionBaselineError,
  runInductionBaseline,
} from "@/lib/induction-baseline";

type PersonAgeTier = "INFANT" | "CHILD" | "YOUTH" | "ADULT";
type FakeAgeTierSetting = {
  tier: PersonAgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  sortOrder: number;
};
type FakeActor = {
  id: string;
  active: boolean;
  archivedAt: Date | null;
  cancelledAt: Date | null;
  accessRoles: Array<{ role: string | null }>;
};

const DEFAULT_AGE_TIERS: FakeAgeTierSetting[] = [
  {
    tier: "INFANT",
    minAge: 0,
    maxAge: 4,
    label: "Infant",
    sortOrder: 0,
  },
  {
    tier: "CHILD",
    minAge: 5,
    maxAge: 9,
    label: "Child",
    sortOrder: 1,
  },
  {
    tier: "YOUTH",
    minAge: 10,
    maxAge: 17,
    label: "Youth",
    sortOrder: 2,
  },
  {
    tier: "ADULT",
    minAge: 18,
    maxAge: null,
    label: "Adult",
    sortOrder: 3,
  },
];

const DEFAULT_TEMPLATE = {
  id: "template-new-member",
  name: "Club induction",
  version: "legacy-v1",
  sections: [
    {
      id: "section-1",
      title: "Safety",
      items: [{ id: "item-1", label: "Emergency exits" }],
    },
  ],
};

const DEFAULT_ACTOR: FakeActor = {
  id: "admin-1",
  active: true,
  archivedAt: null,
  cancelledAt: null,
  accessRoles: [{ role: "ADMIN" }],
};

type ExistingRow = {
  id: string;
  memberId: string;
  kind: "NEW_MEMBER" | "HUT_LEADER" | "YOUTH_TO_FULL" | "RE_INDUCTION";
  status: "DRAFT" | "IN_PROGRESS" | "COMPLETED" | "VOIDED";
};

function createFakeStore({
  actor = DEFAULT_ACTOR,
  ageTiers = DEFAULT_AGE_TIERS,
  templates = [DEFAULT_TEMPLATE],
  members = [
    { id: "infant-1", ageTier: "INFANT" },
    { id: "child-1", ageTier: "CHILD" },
    { id: "youth-1", ageTier: "YOUTH" },
    { id: "adult-1", ageTier: "ADULT" },
    { id: "org-1", ageTier: "NOT_APPLICABLE" },
  ],
  existing = [],
  requiredSignOffs = 2,
  auditFailure,
}: {
  actor?: FakeActor | null;
  ageTiers?: ReadonlyArray<FakeAgeTierSetting>;
  templates?: typeof DEFAULT_TEMPLATE[];
  members?: Array<{
    id: string;
    ageTier: "INFANT" | "CHILD" | "YOUTH" | "ADULT" | "NOT_APPLICABLE";
  }>;
  existing?: ExistingRow[];
  requiredSignOffs?: number;
  auditFailure?: Error;
} = {}) {
  const sequence: string[] = [];
  let rows = [...existing];
  let auditRows: unknown[] = [];
  let createCalls = 0;

  const tx = {
    $executeRawUnsafe: vi.fn(async (query: string) => {
      sequence.push("lock");
      expect(query).toBe(INDUCTION_BASELINE_LOCK_SQL);
      return 0;
    }),
    clubIdentitySettings: {
      findUnique: vi.fn(async () => {
        sequence.push("club");
        return { name: "Example Alpine Club" };
      }),
    },
    member: {
      findUnique: vi.fn(async () => {
        sequence.push("actor");
        return actor;
      }),
      findMany: vi.fn(async () => {
        sequence.push("members");
        return members;
      }),
    },
    ageTierSetting: {
      findMany: vi.fn(async () => {
        sequence.push("age-tiers");
        return ageTiers;
      }),
    },
    membershipNominationSettings: {
      findUnique: vi.fn(async () => {
        sequence.push("nomination-settings");
        return { requiredSignOffs };
      }),
    },
    inductionChecklistTemplate: {
      findMany: vi.fn(async () => {
        sequence.push("template");
        return templates;
      }),
    },
    memberInduction: {
      findMany: vi.fn(async () => {
        sequence.push("inductions");
        return rows;
      }),
      createMany: vi.fn(async (args: unknown) => {
        sequence.push("create");
        createCalls += 1;
        const data = (
          args as {
            data: Array<{
              memberId: string;
              kind: ExistingRow["kind"];
              status: ExistingRow["status"];
            }>;
          }
        ).data;
        rows.push(
          ...data.map((row, index) => ({
            id: `created-${createCalls}-${index}`,
            memberId: row.memberId,
            kind: row.kind,
            status: row.status,
          })),
        );
        return { count: data.length };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        sequence.push("audit");
        if (auditFailure) throw auditFailure;
        auditRows.push(args);
        return {};
      }),
    },
  };

  const store = {
    $transaction: vi.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => {
        const rowsBefore = [...rows];
        const auditBefore = [...auditRows];
        try {
          return await callback(tx);
        } catch (error) {
          // Simulate database rollback so tests can verify the service keeps the
          // insert and audit in the same transaction.
          rows = rowsBefore;
          auditRows = auditBefore;
          throw error;
        }
      },
    ),
  };

  return {
    store,
    tx,
    sequence,
    get rows() {
      return rows;
    },
    get auditRows() {
      return auditRows;
    },
    get createCalls() {
      return createCalls;
    },
  };
}

const BASE_OPTIONS = {
  actorMemberId: "admin-1",
  baselineDate: "2024-06-30",
  provenanceNote: "Committee minute 2024-07, verified legacy register",
  fallbackClubName: "unused",
  fallbackClubNameSource: "primary" as const,
};

describe("runInductionBaseline", () => {
  it("dry-runs every configured person tier and reports NOT_APPLICABLE separately without writing", async () => {
    const fake = createFakeStore({
      existing: [
        {
          id: "completed-hut-leader",
          memberId: "adult-1",
          kind: "HUT_LEADER",
          status: "COMPLETED",
        },
        {
          id: "voided-old",
          memberId: "child-1",
          kind: "RE_INDUCTION",
          status: "VOIDED",
        },
      ],
    });

    const report = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: fake.store as never,
    });

    expect(report.mode).toBe("dry-run");
    expect(report.counts).toEqual({
      eligiblePopulation: 4,
      toCreate: 3,
      alreadyCompleted: 1,
      openWorkflow: 0,
      notApplicable: 1,
    });
    expect(report.tierCounts).toEqual([
      expect.objectContaining({ tier: "INFANT", toCreate: 1 }),
      expect.objectContaining({ tier: "CHILD", toCreate: 1 }),
      expect.objectContaining({ tier: "YOUTH", toCreate: 1 }),
      expect.objectContaining({ tier: "ADULT", alreadyCompleted: 1 }),
    ]);
    expect(report.toCreate.map((member) => member.memberId)).toEqual([
      "infant-1",
      "child-1",
      "youth-1",
    ]);
    expect(report.notApplicable).toEqual([
      { memberId: "org-1", ageTier: "NOT_APPLICABLE" },
    ]);
    expect(fake.tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(fake.tx.memberInduction.createMany).not.toHaveBeenCalled();
    expect(fake.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("locks first, re-reads under the lock, and creates completed override rows with stable provenance", async () => {
    const fake = createFakeStore();

    const report = await runInductionBaseline({
      ...BASE_OPTIONS,
      apply: true,
      confirmClubName: "Example Alpine Club",
      store: fake.store as never,
    });

    expect(fake.sequence[0]).toBe("lock");
    expect(fake.sequence).toEqual([
      "lock",
      "club",
      "actor",
      "age-tiers",
      "nomination-settings",
      "template",
      "members",
      "inductions",
      "create",
      "audit",
    ]);
    expect(report.appliedCount).toBe(4);

    const createArgs = fake.tx.memberInduction.createMany.mock.calls[0][0] as {
      data: Array<Record<string, unknown>>;
    };
    expect(createArgs.data).toHaveLength(4);
    for (const row of createArgs.data) {
      expect(row).toMatchObject({
        templateId: "template-new-member",
        kind: "NEW_MEMBER",
        status: "COMPLETED",
        requiredSignOffs: 2,
        completionSource: "ADMIN_OVERRIDE",
        createdByMemberId: "admin-1",
        finalComments:
          `${INDUCTION_BASELINE_PROVENANCE_PREFIX}: ` +
          "Committee minute 2024-07, verified legacy register",
      });
      expect(row.inductionDate).toEqual(
        new Date("2024-06-30T00:00:00.000Z"),
      );
      expect(row.completedAt).toBe(row.inductionDate);
      expect(row).not.toHaveProperty("assignedSigners");
      expect(row).not.toHaveProperty("signOffs");
    }
    expect(fake.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("skips any member with a completed induction of any kind", async () => {
    const fake = createFakeStore({
      existing: [
        {
          id: "completed-reinduction",
          memberId: "child-1",
          kind: "RE_INDUCTION",
          status: "COMPLETED",
        },
      ],
    });

    const report = await runInductionBaseline({
      ...BASE_OPTIONS,
      apply: true,
      confirmClubName: "Example Alpine Club",
      store: fake.store as never,
    });

    expect(report.alreadyCompleted.map((member) => member.memberId)).toEqual([
      "child-1",
    ]);
    const createdMemberIds = (
      fake.tx.memberInduction.createMany.mock.calls[0][0] as {
        data: Array<{ memberId: string }>;
      }
    ).data.map((row) => row.memberId);
    expect(createdMemberIds).not.toContain("child-1");
  });

  it("reports open workflows in dry-run and aborts the entire apply", async () => {
    const fake = createFakeStore({
      existing: [
        {
          id: "open-youth",
          memberId: "youth-1",
          kind: "YOUTH_TO_FULL",
          status: "IN_PROGRESS",
        },
      ],
    });

    const dryRun = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: fake.store as never,
    });
    expect(dryRun.counts.openWorkflow).toBe(1);
    expect(dryRun.openWorkflows[0]?.memberId).toBe("youth-1");

    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        apply: true,
        confirmClubName: "Example Alpine Club",
        store: fake.store as never,
      }),
    ).rejects.toMatchObject({
      name: "InductionBaselineBlockedError",
      report: expect.objectContaining({
        counts: expect.objectContaining({ openWorkflow: 1 }),
      }),
    });
    expect(fake.tx.memberInduction.createMany).not.toHaveBeenCalled();
    expect(fake.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate active templates and invalid age-tier configuration", async () => {
    const duplicateTemplates = createFakeStore({
      templates: [
        DEFAULT_TEMPLATE,
        { ...DEFAULT_TEMPLATE, id: "template-duplicate" },
      ],
    });
    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        store: duplicateTemplates.store as never,
      }),
    ).rejects.toThrow(
      "Exactly one active NEW_MEMBER induction template is required; found 2.",
    );

    const invalidConfig = createFakeStore({
      ageTiers: [
        {
          tier: "CHILD",
          minAge: 1,
          maxAge: 17,
          label: "Child",
          sortOrder: 0,
        },
        {
          tier: "ADULT",
          minAge: 18,
          maxAge: null,
          label: "Adult",
          sortOrder: 1,
        },
      ],
    });
    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        store: invalidConfig.store as never,
      }),
    ).rejects.toThrow("Age-tier configuration is invalid");
  });

  it.each([
    {
      label: "inactive",
      actor: { ...DEFAULT_ACTOR, active: false },
      message: "The actor member is inactive.",
    },
    {
      label: "archived",
      actor: { ...DEFAULT_ACTOR, archivedAt: new Date("2024-01-01") },
      message: "The actor member is archived.",
    },
    {
      label: "cancelled",
      actor: { ...DEFAULT_ACTOR, cancelledAt: new Date("2024-01-01") },
      message: "The actor member is cancelled.",
    },
    {
      label: "not Full Admin",
      actor: { ...DEFAULT_ACTOR, accessRoles: [{ role: "ADMIN_MEMBERSHIP" }] },
      message: "does not hold the protected Full Admin role",
    },
  ])("rejects an $label actor", async ({ actor, message }) => {
    const fake = createFakeStore({ actor });
    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        store: fake.store as never,
      }),
    ).rejects.toThrow(message);
  });

  it("rolls back created rows when the in-transaction audit fails", async () => {
    const fake = createFakeStore({
      auditFailure: new Error("audit storage unavailable"),
    });

    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        apply: true,
        confirmClubName: "Example Alpine Club",
        store: fake.store as never,
      }),
    ).rejects.toThrow("audit storage unavailable");

    expect(fake.rows).toEqual([]);
    expect(fake.auditRows).toEqual([]);
  });

  it("is idempotent: a successful rerun writes no induction or audit row", async () => {
    const fake = createFakeStore();
    const options = {
      ...BASE_OPTIONS,
      apply: true,
      confirmClubName: "Example Alpine Club",
      store: fake.store as never,
    };

    const first = await runInductionBaseline(options);
    const second = await runInductionBaseline(options);

    expect(first.appliedCount).toBe(4);
    expect(second.counts).toMatchObject({
      toCreate: 0,
      alreadyCompleted: 4,
    });
    expect(second.appliedCount).toBe(0);
    expect(fake.createCalls).toBe(1);
    expect(fake.auditRows).toHaveLength(1);
  });

  it("requires an exact club-name confirmation on apply", async () => {
    const fake = createFakeStore();
    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        apply: true,
        confirmClubName: "example alpine club",
        store: fake.store as never,
      }),
    ).rejects.toThrow(
      "Club-name confirmation does not exactly match the effective club name.",
    );
    expect(fake.tx.memberInduction.createMany).not.toHaveBeenCalled();
  });

  it("rejects malformed dates and blank provenance before opening a transaction", async () => {
    const fake = createFakeStore();
    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        baselineDate: "2024-02-30",
        store: fake.store as never,
      }),
    ).rejects.toBeInstanceOf(InductionBaselineError);
    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        provenanceNote: " ",
        store: fake.store as never,
      }),
    ).rejects.toThrow("A provenance note is required.");
    expect(fake.store.$transaction).not.toHaveBeenCalled();
  });

  it("exposes the blocked report for a CLI to print before returning non-zero", async () => {
    const fake = createFakeStore({
      existing: [
        {
          id: "draft-child",
          memberId: "child-1",
          kind: "NEW_MEMBER",
          status: "DRAFT",
        },
      ],
    });

    try {
      await runInductionBaseline({
        ...BASE_OPTIONS,
        apply: true,
        confirmClubName: "Example Alpine Club",
        store: fake.store as never,
      });
      throw new Error("expected apply to be blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(InductionBaselineBlockedError);
      expect((error as InductionBaselineBlockedError).report.openWorkflows).toHaveLength(
        1,
      );
    }
  });
});
