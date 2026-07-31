import { describe, expect, it, vi } from "vitest";
import {
  INDUCTION_BASELINE_PROVENANCE_PREFIX,
  InductionBaselineBlockedError,
  InductionBaselineError,
  InductionBaselinePlanMismatchError,
  runInductionBaseline,
  type InductionBaselineReport,
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
  canLogin: boolean;
  archivedAt: Date | null;
  cancelledAt: Date | null;
  accessRoles: Array<{ role: string | null }>;
};
type FakeMemberRole = "USER" | "ADMIN" | "LODGE" | "NON_MEMBER" | "SCHOOL";
type FakeMember = {
  id: string;
  ageTier: "INFANT" | "CHILD" | "YOUTH" | "ADULT" | "NOT_APPLICABLE";
  role: FakeMemberRole;
  active: boolean;
  canLogin: boolean;
  archivedAt: Date | null;
  cancelledAt: Date | null;
};

function fakeAgeTier(
  tier: PersonAgeTier,
  minAge: number,
  maxAge: number | null,
  label: string,
  sortOrder: number,
): FakeAgeTierSetting {
  return { tier, minAge, maxAge, label, sortOrder };
}

const DEFAULT_AGE_TIERS: FakeAgeTierSetting[] = [
  fakeAgeTier("INFANT", 0, 4, "Infant", 0),
  fakeAgeTier("CHILD", 5, 9, "Child", 1),
  fakeAgeTier("YOUTH", 10, 17, "Youth", 2),
  fakeAgeTier("ADULT", 18, null, "Adult", 3),
];

const DEFAULT_TEMPLATE = {
  id: "template-new-member",
  name: "Club induction",
  version: "legacy-v1",
  kind: "NEW_MEMBER" as const,
  sourceLabel: "Legacy committee checklist",
  sections: [
    {
      id: "section-1",
      title: "Safety",
      description: "Core safety competencies",
      priority: "CRITICAL" as const,
      sortOrder: 0,
      items: [
        {
          id: "item-1",
          label: "Emergency exits",
          competencyPrompt: "Show both exits",
          notesPrompt: "Record any support needed",
          isMandatory: true,
          requiresDemonstration: true,
          sortOrder: 0,
          legacySourceText: "Emergency exit briefing",
        },
      ],
    },
  ],
};

const DEFAULT_ACTOR: FakeActor = {
  id: "admin-1",
  active: true,
  canLogin: true,
  archivedAt: null,
  cancelledAt: null,
  accessRoles: [{ role: "ADMIN" }],
};

function fakeMember(
  id: string,
  role: FakeMemberRole,
  overrides: Partial<Omit<FakeMember, "id" | "role">> = {},
): FakeMember {
  return {
    id,
    role,
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    archivedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

type ExistingRow = {
  id: string;
  memberId: string;
  kind: "NEW_MEMBER" | "HUT_LEADER" | "YOUTH_TO_FULL" | "RE_INDUCTION";
  status: "DRAFT" | "IN_PROGRESS" | "COMPLETED" | "VOIDED";
};

function existingRow(
  id: string,
  memberId: string,
  kind: ExistingRow["kind"],
  status: ExistingRow["status"],
): ExistingRow {
  return { id, memberId, kind, status };
}

function createFakeStore({
  clubName = "Example Alpine Club",
  actor = DEFAULT_ACTOR,
  ageTiers = DEFAULT_AGE_TIERS,
  templates = [DEFAULT_TEMPLATE],
  members = [
    fakeMember("infant-1", "USER", { ageTier: "INFANT", canLogin: false }),
    fakeMember("child-1", "USER", { ageTier: "CHILD", canLogin: false }),
    fakeMember("youth-1", "USER", { ageTier: "YOUTH" }),
    fakeMember("adult-1", "ADMIN"),
    fakeMember("na-member-1", "USER", {
      ageTier: "NOT_APPLICABLE",
      canLogin: false,
    }),
  ] satisfies FakeMember[],
  existing = [],
  requiredSignOffs = 2,
  auditFailure,
}: {
  clubName?: string;
  actor?: FakeActor | null;
  ageTiers?: ReadonlyArray<FakeAgeTierSetting>;
  templates?: (typeof DEFAULT_TEMPLATE)[];
  members?: FakeMember[];
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
      expect(query).toBe(
        'LOCK TABLE "MemberInduction" IN SHARE ROW EXCLUSIVE MODE',
      );
      return 0;
    }),
    clubIdentitySettings: {
      findUnique: vi.fn(async () => {
        sequence.push("club");
        return { name: clubName };
      }),
    },
    member: {
      findUnique: vi.fn(async () => {
        sequence.push("actor");
        return actor;
      }),
      findMany: vi.fn(async (args: unknown) => {
        sequence.push("members");
        const where = (
          args as {
            where: {
              active?: boolean;
              archivedAt?: Date | null;
              cancelledAt?: Date | null;
              canLogin?: boolean;
              role?: { in?: FakeMemberRole[] };
            };
          }
        ).where;
        return members
          .filter(
            (member) =>
              (where.active === undefined || member.active === where.active) &&
              (where.archivedAt === undefined ||
                member.archivedAt === where.archivedAt) &&
              (where.cancelledAt === undefined ||
                member.cancelledAt === where.cancelledAt) &&
              (where.canLogin === undefined ||
                member.canLogin === where.canLogin) &&
              (!where.role?.in || where.role.in.includes(member.role)),
          )
          .map(({ id, ageTier }) => ({ id, ageTier }));
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
  databaseTarget: {
    host: "postgres.internal:5432",
    databaseName: "alpine_club",
  },
  fallbackClubName: "unused",
  fallbackClubNameSource: "primary" as const,
};

const ACTIVE_REAL_MEMBER_QUERY = {
  where: {
    active: true,
    archivedAt: null,
    cancelledAt: null,
    role: { in: ["USER", "ADMIN"] },
  },
  select: { id: true, ageTier: true },
  orderBy: { id: "asc" },
};

function classification(report: InductionBaselineReport) {
  return {
    counts: report.counts,
    tierCounts: report.tierCounts,
    toCreate: report.toCreate,
    alreadyCompleted: report.alreadyCompleted,
    openWorkflows: report.openWorkflows,
    notApplicable: report.notApplicable,
  };
}

async function applyCurrentPlan(
  fake: ReturnType<typeof createFakeStore>,
  overrides: Partial<Parameters<typeof runInductionBaseline>[0]> = {},
): Promise<{
  dryRun: InductionBaselineReport;
  apply: InductionBaselineReport;
}> {
  const dryRun = await runInductionBaseline({
    ...BASE_OPTIONS,
    ...overrides,
    apply: false,
    store: fake.store as never,
  });
  fake.sequence.length = 0;
  const apply = await runInductionBaseline({
    ...BASE_OPTIONS,
    ...overrides,
    apply: true,
    confirmClubName: "Example Alpine Club",
    confirmPlanDigest: dryRun.planDigest,
    store: fake.store as never,
  });
  return { dryRun, apply };
}

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
      "child-1",
      "infant-1",
      "youth-1",
    ]);
    expect(report.notApplicable).toEqual([
      { memberId: "na-member-1", ageTier: "NOT_APPLICABLE" },
    ]);
    expect(fake.tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(fake.tx.memberInduction.createMany).not.toHaveBeenCalled();
    expect(fake.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("queries only active USER/ADMIN members while retaining non-login dependants", async () => {
    const fake = createFakeStore({
      members: [
        fakeMember("login-user", "USER"),
        fakeMember("non-login-dependant", "USER", { canLogin: false }),
        fakeMember("legacy-admin", "ADMIN"),
        fakeMember("lodge-device", "LODGE"),
        fakeMember("non-member-contact", "NON_MEMBER"),
        fakeMember("school-contact", "SCHOOL"),
        fakeMember("inactive-user", "USER", { active: false }),
        fakeMember("archived-user", "USER", {
          archivedAt: new Date("2024-01-01"),
        }),
        fakeMember("cancelled-user", "USER", {
          cancelledAt: new Date("2024-01-01"),
        }),
      ],
    });

    const report = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: fake.store as never,
    });

    expect(fake.tx.member.findMany).toHaveBeenCalledWith(
      ACTIVE_REAL_MEMBER_QUERY,
    );
    expect(report.toCreate.map((member) => member.memberId)).toEqual([
      "legacy-admin",
      "login-user",
      "non-login-dependant",
    ]);
    expect(report.counts.eligiblePopulation).toBe(3);
    expect(report.notApplicable).toEqual([]);
  });

  it("locks first, re-reads under the lock, and creates completed override rows with stable provenance", async () => {
    const fake = createFakeStore();

    const { apply: appliedReport } = await applyCurrentPlan(fake);

    expect(fake.sequence[0]).toBe("lock");
    expect(fake.tx.member.findUnique).toHaveBeenCalledWith({
      where: { id: "admin-1" },
      select: {
        id: true,
        active: true,
        canLogin: true,
        archivedAt: true,
        cancelledAt: true,
        accessRoles: {
          where: { role: "ADMIN" },
          select: { role: true },
        },
      },
    });
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
    expect(appliedReport.appliedCount).toBe(4);

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
      expect(row.inductionDate).toEqual(new Date("2024-06-30T00:00:00.000Z"));
      expect(row.completedAt).toBe(row.inductionDate);
      expect(row).not.toHaveProperty("assignedSigners");
      expect(row).not.toHaveProperty("signOffs");
    }
    expect(fake.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            planDigest: appliedReport.planDigest,
          }),
        }),
      }),
    );
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

    const { apply: report } = await applyCurrentPlan(fake);

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

  it("lets an open workflow take precedence when the member also has a completed induction", async () => {
    const fake = createFakeStore({
      existing: [
        existingRow("completed-child", "child-1", "RE_INDUCTION", "COMPLETED"),
        existingRow("open-child", "child-1", "NEW_MEMBER", "DRAFT"),
      ],
    });

    const report = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: fake.store as never,
    });
    expect(report.openWorkflows.map((member) => member.memberId)).toContain(
      "child-1",
    );
    expect(
      report.alreadyCompleted.map((member) => member.memberId),
    ).not.toContain("child-1");
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
        confirmPlanDigest: dryRun.planDigest,
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

  it("uses identical deterministic classifications for dry-run and apply", async () => {
    const fake = createFakeStore({
      existing: [
        existingRow("completed-adult", "adult-1", "HUT_LEADER", "COMPLETED"),
        existingRow("voided-child", "child-1", "NEW_MEMBER", "VOIDED"),
      ],
    });
    const dryRun = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: fake.store as never,
    });
    const apply = await runInductionBaseline({
      ...BASE_OPTIONS,
      apply: true,
      confirmClubName: "Example Alpine Club",
      confirmPlanDigest: dryRun.planDigest,
      store: fake.store as never,
    });

    expect(classification(apply)).toEqual(classification(dryRun));
    expect(apply.planDigest).toBe(dryRun.planDigest);
  });

  it("produces the same versioned SHA-256 digest for semantically identical plans returned in different orders", async () => {
    const secondItem = {
      ...DEFAULT_TEMPLATE.sections[0].items[0],
      id: "item-2",
      label: "Fire response",
      sortOrder: 10,
    };
    const secondSection = {
      ...DEFAULT_TEMPLATE.sections[0],
      id: "section-2",
      title: "Lodge systems",
      sortOrder: 10,
      items: [
        {
          ...DEFAULT_TEMPLATE.sections[0].items[0],
          id: "item-3",
          label: "Water shutoff",
        },
      ],
    };
    const orderedTemplate = {
      ...DEFAULT_TEMPLATE,
      sections: [
        {
          ...DEFAULT_TEMPLATE.sections[0],
          items: [DEFAULT_TEMPLATE.sections[0].items[0], secondItem],
        },
        secondSection,
      ],
    };
    const shuffledTemplate = {
      ...orderedTemplate,
      sections: [
        secondSection,
        {
          ...orderedTemplate.sections[0],
          items: [secondItem, DEFAULT_TEMPLATE.sections[0].items[0]],
        },
      ],
    };
    const members = [
      fakeMember("member-z", "USER"),
      fakeMember("member-a", "USER", { ageTier: "CHILD" }),
      fakeMember("na-z", "USER", { ageTier: "NOT_APPLICABLE" }),
      fakeMember("na-a", "USER", { ageTier: "NOT_APPLICABLE" }),
    ];
    const existing = [
      existingRow("induction-z", "member-z", "HUT_LEADER", "VOIDED"),
      existingRow("induction-a", "member-z", "NEW_MEMBER", "VOIDED"),
    ];
    const ordered = createFakeStore({
      ageTiers: DEFAULT_AGE_TIERS,
      templates: [orderedTemplate],
      members,
      existing,
    });
    const shuffled = createFakeStore({
      ageTiers: [...DEFAULT_AGE_TIERS].reverse(),
      templates: [shuffledTemplate],
      members: [...members].reverse(),
      existing: [...existing].reverse(),
    });

    const orderedReport = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: ordered.store as never,
    });
    const shuffledReport = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: shuffled.store as never,
    });

    expect(orderedReport.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(shuffledReport.planDigest).toBe(orderedReport.planDigest);
    expect(classification(shuffledReport)).toEqual(
      classification(orderedReport),
    );
  });

  it("binds every safety-relevant plan input into the digest", async () => {
    async function digestFor(
      storeOptions: Parameters<typeof createFakeStore>[0] = {},
      optionOverrides: Partial<Parameters<typeof runInductionBaseline>[0]> = {},
    ) {
      const fake = createFakeStore(storeOptions);
      return (
        await runInductionBaseline({
          ...BASE_OPTIONS,
          ...optionOverrides,
          store: fake.store as never,
        })
      ).planDigest;
    }

    const baselineDigest = await digestFor();
    const changedTemplateContent = structuredClone(DEFAULT_TEMPLATE);
    changedTemplateContent.sections[0].items[0].competencyPrompt =
      "Demonstrate both exits without prompting";
    const changedAgeTiers = structuredClone(DEFAULT_AGE_TIERS);
    changedAgeTiers[0] = {
      ...changedAgeTiers[0],
      maxAge: 3,
      label: "Infant under four",
      sortOrder: 40,
    };
    changedAgeTiers[1] = { ...changedAgeTiers[1], minAge: 4 };
    const completedMembers = [
      fakeMember("adult-1", "ADMIN"),
      fakeMember("na-member-1", "USER", {
        ageTier: "NOT_APPLICABLE",
        canLogin: false,
      }),
    ];
    const variants: Array<[string, Promise<string>]> = [
      [
        "database host",
        digestFor(
          {},
          {
            databaseTarget: {
              ...BASE_OPTIONS.databaseTarget,
              host: "other.internal:5432",
            },
          },
        ),
      ],
      [
        "database name",
        digestFor(
          {},
          {
            databaseTarget: {
              ...BASE_OPTIONS.databaseTarget,
              databaseName: "other_club",
            },
          },
        ),
      ],
      ["club", digestFor({ clubName: "Other Alpine Club" })],
      [
        "actor",
        digestFor(
          { actor: { ...DEFAULT_ACTOR, id: "admin-2" } },
          { actorMemberId: "admin-2" },
        ),
      ],
      ["date", digestFor({}, { baselineDate: "2024-06-29" })],
      [
        "full stored provenance",
        digestFor({}, { provenanceNote: "A different trusted register" }),
      ],
      [
        "template identity",
        digestFor({
          templates: [{ ...DEFAULT_TEMPLATE, id: "other-template" }],
        }),
      ],
      [
        "template name",
        digestFor({
          templates: [{ ...DEFAULT_TEMPLATE, name: "Other induction" }],
        }),
      ],
      [
        "template version",
        digestFor({
          templates: [{ ...DEFAULT_TEMPLATE, version: "legacy-v2" }],
        }),
      ],
      [
        "template section/item content",
        digestFor({ templates: [changedTemplateContent] }),
      ],
      ["age-tier partition", digestFor({ ageTiers: changedAgeTiers })],
      ["required sign-offs", digestFor({ requiredSignOffs: 3 })],
      [
        "eligible member ID",
        digestFor({
          members: [
            fakeMember("adult-2", "ADMIN"),
            fakeMember("na-member-1", "USER", {
              ageTier: "NOT_APPLICABLE",
              canLogin: false,
            }),
          ],
        }),
      ],
      [
        "existing induction ID and kind",
        digestFor({
          members: completedMembers,
          existing: [
            existingRow(
              "different-induction",
              "adult-1",
              "HUT_LEADER",
              "COMPLETED",
            ),
          ],
        }),
      ],
      [
        "existing induction status/category",
        digestFor({
          members: completedMembers,
          existing: [
            existingRow(
              "existing-induction",
              "adult-1",
              "NEW_MEMBER",
              "IN_PROGRESS",
            ),
          ],
        }),
      ],
      [
        "not-applicable member ID",
        digestFor({
          members: [
            fakeMember("adult-1", "ADMIN"),
            fakeMember("different-na-member", "USER", {
              ageTier: "NOT_APPLICABLE",
              canLogin: false,
            }),
          ],
        }),
      ],
    ];

    for (const [label, pendingDigest] of variants) {
      expect(await pendingDigest, label).not.toBe(baselineDigest);
    }
  });

  it("rejects a stale digest before the blocked and write branches and exposes the refreshed safe report", async () => {
    const fake = createFakeStore();
    const dryRun = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: fake.store as never,
    });
    fake.sequence.length = 0;
    fake.rows.push(
      existingRow("concurrent-draft", "child-1", "NEW_MEMBER", "DRAFT"),
    );

    let thrown: unknown;
    try {
      await runInductionBaseline({
        ...BASE_OPTIONS,
        apply: true,
        confirmClubName: "Example Alpine Club",
        confirmPlanDigest: dryRun.planDigest,
        store: fake.store as never,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InductionBaselinePlanMismatchError);
    const mismatch = thrown as InductionBaselinePlanMismatchError;
    expect(mismatch.report.planDigest).not.toBe(dryRun.planDigest);
    expect(mismatch.report.openWorkflows).toEqual([
      expect.objectContaining({ memberId: "child-1" }),
    ]);
    expect(fake.sequence[0]).toBe("lock");
    expect(fake.tx.memberInduction.createMany).not.toHaveBeenCalled();
    expect(fake.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("compares the apply digest exactly without trimming", async () => {
    const fake = createFakeStore();
    const dryRun = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: fake.store as never,
    });

    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        apply: true,
        confirmClubName: "Example Alpine Club",
        confirmPlanDigest: ` ${dryRun.planDigest} `,
        store: fake.store as never,
      }),
    ).rejects.toBeInstanceOf(InductionBaselinePlanMismatchError);
    expect(fake.tx.memberInduction.createMany).not.toHaveBeenCalled();
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

  it("rejects an otherwise valid ADULT-only partition before population planning", async () => {
    const fake = createFakeStore({
      ageTiers: [fakeAgeTier("ADULT", 0, null, "Adult", 0)],
    });

    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        store: fake.store as never,
      }),
    ).rejects.toThrow(
      "the induction baseline requires exactly one INFANT, CHILD, YOUTH, and ADULT tier",
    );
    expect(fake.tx.member.findMany).not.toHaveBeenCalled();
    expect(fake.tx.memberInduction.findMany).not.toHaveBeenCalled();
    expect(fake.tx.memberInduction.createMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      missingTier: "INFANT",
      ageTiers: [
        fakeAgeTier("CHILD", 0, 9, "Child", 0),
        fakeAgeTier("YOUTH", 10, 17, "Youth", 1),
        fakeAgeTier("ADULT", 18, null, "Adult", 2),
      ],
    },
    {
      missingTier: "CHILD",
      ageTiers: [
        fakeAgeTier("INFANT", 0, 9, "Infant", 0),
        fakeAgeTier("YOUTH", 10, 17, "Youth", 1),
        fakeAgeTier("ADULT", 18, null, "Adult", 2),
      ],
    },
    {
      missingTier: "YOUTH",
      ageTiers: [
        fakeAgeTier("INFANT", 0, 4, "Infant", 0),
        fakeAgeTier("CHILD", 5, 17, "Child", 1),
        fakeAgeTier("ADULT", 18, null, "Adult", 2),
      ],
    },
  ])(
    "rejects a gapless partition missing $missingTier",
    async ({ ageTiers }) => {
      const fake = createFakeStore({ ageTiers });

      await expect(
        runInductionBaseline({
          ...BASE_OPTIONS,
          store: fake.store as never,
        }),
      ).rejects.toThrow(
        "the induction baseline requires exactly one INFANT, CHILD, YOUTH, and ADULT tier",
      );
      expect(fake.tx.member.findMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "inactive",
      actor: { ...DEFAULT_ACTOR, active: false },
      message: "The actor member is inactive.",
    },
    {
      label: "login-disabled",
      actor: { ...DEFAULT_ACTOR, canLogin: false },
      message: "The actor member has login disabled.",
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

    const dryRun = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: fake.store as never,
    });
    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        apply: true,
        confirmClubName: "Example Alpine Club",
        confirmPlanDigest: dryRun.planDigest,
        store: fake.store as never,
      }),
    ).rejects.toThrow("audit storage unavailable");

    expect(fake.rows).toEqual([]);
    expect(fake.auditRows).toEqual([]);
  });

  it("requires a fresh digest for an idempotent no-op rerun", async () => {
    const fake = createFakeStore();
    const dryRun = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: fake.store as never,
    });
    const applyOptions = {
      ...BASE_OPTIONS,
      apply: true as const,
      confirmClubName: "Example Alpine Club",
      confirmPlanDigest: dryRun.planDigest,
      store: fake.store as never,
    };
    const first = await runInductionBaseline(applyOptions);
    await expect(runInductionBaseline(applyOptions)).rejects.toBeInstanceOf(
      InductionBaselinePlanMismatchError,
    );
    const refreshedDryRun = await runInductionBaseline({
      ...BASE_OPTIONS,
      store: fake.store as never,
    });
    const second = await runInductionBaseline({
      ...applyOptions,
      confirmPlanDigest: refreshedDryRun.planDigest,
    });

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
        confirmPlanDigest: "sha256:not-reached",
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
      const dryRun = await runInductionBaseline({
        ...BASE_OPTIONS,
        store: fake.store as never,
      });
      await runInductionBaseline({
        ...BASE_OPTIONS,
        apply: true,
        confirmClubName: "Example Alpine Club",
        confirmPlanDigest: dryRun.planDigest,
        store: fake.store as never,
      });
      throw new Error("expected apply to be blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(InductionBaselineBlockedError);
      expect(
        (error as InductionBaselineBlockedError).report.openWorkflows,
      ).toHaveLength(1);
    }
  });
});
