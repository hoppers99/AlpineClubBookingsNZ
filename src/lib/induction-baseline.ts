import type {
  AgeTier,
  InductionKind,
  InductionStatus,
  Prisma,
} from "@prisma/client";
import { clubConfig, clubConfigSource, type ClubConfigSource } from "@/config/club";
import { DEFAULT_MEMBERSHIP_NOMINATION_SETTINGS } from "@/config/club-settings-defaults";
import { buildStructuredAuditLogCreateArgs } from "@/lib/audit";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { MEMBER_IMPORT_ROLE_VALUES } from "@/lib/member-roles";
import { prisma } from "@/lib/prisma";
import {
  validateAgeTierPartition,
  type AgeTierPartitionRow,
} from "@/lib/policies/age-tier";

/**
 * A PostgreSQL SHARE ROW EXCLUSIVE table lock conflicts with the ROW EXCLUSIVE
 * lock acquired by INSERT, UPDATE and DELETE. Holding it for the apply
 * transaction therefore freezes every MemberInduction row without requiring a
 * new advisory-lock key or changing each ordinary induction writer.
 */
export const INDUCTION_BASELINE_LOCK_SQL =
  'LOCK TABLE "MemberInduction" IN SHARE ROW EXCLUSIVE MODE';

export const INDUCTION_BASELINE_PROVENANCE_PREFIX =
  "Trusted legacy induction baseline";

const PERSON_AGE_TIERS: AgeTier[] = [
  "INFANT",
  "CHILD",
  "YOUTH",
  "ADULT",
];

type BaselineActor = {
  id: string;
  active: boolean;
  canLogin: boolean;
  archivedAt: Date | null;
  cancelledAt: Date | null;
  accessRoles: Array<{ role: string | null }>;
};

type BaselineAgeTierSetting = AgeTierPartitionRow & {
  label: string;
  sortOrder: number;
};

type BaselineTemplate = {
  id: string;
  name: string;
  version: string;
  sections: Array<{
    id: string;
    title: string;
    items: Array<{ id: string; label: string }>;
  }>;
};

type BaselineMember = {
  id: string;
  ageTier: AgeTier;
};

type BaselineExistingInduction = {
  id: string;
  memberId: string;
  kind: InductionKind;
  status: InductionStatus;
};

interface InductionBaselineTransaction {
  $executeRawUnsafe(query: string): Promise<number>;
  clubIdentitySettings: {
    findUnique(args: unknown): Promise<{ name: string | null } | null>;
  };
  member: {
    findUnique(args: unknown): Promise<BaselineActor | null>;
    findMany(args: unknown): Promise<BaselineMember[]>;
  };
  ageTierSetting: {
    findMany(args: unknown): Promise<BaselineAgeTierSetting[]>;
  };
  membershipNominationSettings: {
    findUnique(args: unknown): Promise<{ requiredSignOffs: number } | null>;
  };
  inductionChecklistTemplate: {
    findMany(args: unknown): Promise<BaselineTemplate[]>;
  };
  memberInduction: {
    findMany(args: unknown): Promise<BaselineExistingInduction[]>;
    createMany(args: unknown): Promise<{ count: number }>;
  };
  auditLog: {
    create(args: unknown): Promise<unknown>;
  };
}

interface InductionBaselineStore {
  $transaction<T>(
    callback: (tx: InductionBaselineTransaction) => Promise<T>,
    options: {
      isolationLevel: Prisma.TransactionIsolationLevel;
      maxWait: number;
      timeout: number;
    },
  ): Promise<T>;
}

export type InductionBaselineExistingRef = {
  id: string;
  kind: InductionKind;
  status: InductionStatus;
};

export type InductionBaselineMemberPlan = {
  memberId: string;
  ageTier: AgeTier;
  existingInductions: InductionBaselineExistingRef[];
};

export type InductionBaselineTierCount = {
  tier: AgeTier;
  label: string;
  eligiblePopulation: number;
  toCreate: number;
  alreadyCompleted: number;
  openWorkflow: number;
};

export interface InductionBaselineReport {
  mode: "dry-run" | "apply";
  clubName: string;
  actorMemberId: string;
  baselineDate: string;
  provenance: string;
  template: {
    id: string;
    name: string;
    version: string;
  };
  configuredAgeTiers: Array<{ tier: AgeTier; label: string }>;
  tierCounts: InductionBaselineTierCount[];
  counts: {
    eligiblePopulation: number;
    toCreate: number;
    alreadyCompleted: number;
    openWorkflow: number;
    notApplicable: number;
  };
  toCreate: InductionBaselineMemberPlan[];
  alreadyCompleted: InductionBaselineMemberPlan[];
  openWorkflows: InductionBaselineMemberPlan[];
  notApplicable: Array<{ memberId: string; ageTier: "NOT_APPLICABLE" }>;
  appliedCount: number;
}

export class InductionBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InductionBaselineError";
  }
}

export class InductionBaselineBlockedError extends InductionBaselineError {
  constructor(
    message: string,
    readonly report: InductionBaselineReport,
  ) {
    super(message);
    this.name = "InductionBaselineBlockedError";
  }
}

export interface RunInductionBaselineOptions {
  actorMemberId: string;
  baselineDate: string;
  provenanceNote: string;
  apply?: boolean;
  confirmClubName?: string;
  store?: InductionBaselineStore;
  fallbackClubName?: string;
  fallbackClubNameSource?: ClubConfigSource;
}

function validateInputs(options: RunInductionBaselineOptions): {
  actorMemberId: string;
  baselineDate: string;
  baselineTimestamp: Date;
  provenance: string;
} {
  const actorMemberId = options.actorMemberId.trim();
  if (!actorMemberId) {
    throw new InductionBaselineError("A Full Admin actor member ID is required.");
  }

  if (!isDateOnlyString(options.baselineDate)) {
    throw new InductionBaselineError(
      "The baseline date must be a real NZ date-only value in YYYY-MM-DD form.",
    );
  }

  const provenanceNote = options.provenanceNote.trim();
  if (!provenanceNote) {
    throw new InductionBaselineError("A provenance note is required.");
  }
  if (provenanceNote.length > 1000) {
    throw new InductionBaselineError(
      "The provenance note must be 1000 characters or fewer.",
    );
  }

  return {
    actorMemberId,
    baselineDate: options.baselineDate,
    baselineTimestamp: parseDateOnly(options.baselineDate),
    provenance: `${INDUCTION_BASELINE_PROVENANCE_PREFIX}: ${provenanceNote}`,
  };
}

function resolveClubName(params: {
  persistedName: string | null | undefined;
  fallbackName: string;
  fallbackSource: ClubConfigSource;
}): string {
  const persistedName = params.persistedName?.trim();
  if (persistedName) {
    return persistedName;
  }

  const fallbackName = params.fallbackName.trim();
  if (params.fallbackSource === "primary" && fallbackName) {
    return fallbackName;
  }

  throw new InductionBaselineError(
    "Club identity configuration is invalid: set a database-backed club name or provide a valid primary config/club.json before running the baseline.",
  );
}

function assertValidActor(actor: BaselineActor | null): asserts actor is BaselineActor {
  if (!actor) {
    throw new InductionBaselineError("The actor member was not found.");
  }
  if (!actor.active) {
    throw new InductionBaselineError("The actor member is inactive.");
  }
  if (!actor.canLogin) {
    throw new InductionBaselineError("The actor member has login disabled.");
  }
  if (actor.archivedAt) {
    throw new InductionBaselineError("The actor member is archived.");
  }
  if (actor.cancelledAt) {
    throw new InductionBaselineError("The actor member is cancelled.");
  }
  if (!actor.accessRoles.some((assignment) => assignment.role === "ADMIN")) {
    throw new InductionBaselineError(
      "The actor member does not hold the protected Full Admin role.",
    );
  }
}

function validateAgeTierSettings(
  settings: BaselineAgeTierSetting[],
): BaselineAgeTierSetting[] {
  const validation = validateAgeTierPartition(settings);
  if (!validation.ok) {
    throw new InductionBaselineError(
      `Age-tier configuration is invalid: ${validation.error}`,
    );
  }
  for (const setting of validation.sorted) {
    if (!setting.label.trim()) {
      throw new InductionBaselineError(
        `Age-tier configuration is invalid: ${setting.tier} has a blank label.`,
      );
    }
  }
  return validation.sorted;
}

function validateActiveTemplate(templates: BaselineTemplate[]): BaselineTemplate {
  if (templates.length !== 1) {
    throw new InductionBaselineError(
      `Exactly one active NEW_MEMBER induction template is required; found ${templates.length}.`,
    );
  }

  const template = templates[0];
  const hasBlankSection = template.sections.some(
    (section) => !section.title.trim(),
  );
  const items = template.sections.flatMap((section) => section.items);
  const hasBlankItem = items.some((item) => !item.label.trim());
  if (
    !template.name.trim() ||
    !template.version.trim() ||
    template.sections.length === 0 ||
    items.length === 0 ||
    hasBlankSection ||
    hasBlankItem
  ) {
    throw new InductionBaselineError(
      "The active NEW_MEMBER induction template is invalid: it needs a name, version, and at least one non-blank checklist section and item.",
    );
  }

  return template;
}

function inductionRefs(
  rows: BaselineExistingInduction[],
): InductionBaselineExistingRef[] {
  return [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, kind, status }) => ({ id, kind, status }));
}

function buildReport(params: {
  mode: "dry-run" | "apply";
  clubName: string;
  actorMemberId: string;
  baselineDate: string;
  provenance: string;
  template: BaselineTemplate;
  settings: BaselineAgeTierSetting[];
  eligibleMembers: BaselineMember[];
  notApplicableMembers: BaselineMember[];
  existingInductions: BaselineExistingInduction[];
}): InductionBaselineReport {
  const rowsByMember = new Map<string, BaselineExistingInduction[]>();
  for (const induction of params.existingInductions) {
    const rows = rowsByMember.get(induction.memberId) ?? [];
    rows.push(induction);
    rowsByMember.set(induction.memberId, rows);
  }

  const toCreate: InductionBaselineMemberPlan[] = [];
  const alreadyCompleted: InductionBaselineMemberPlan[] = [];
  const openWorkflows: InductionBaselineMemberPlan[] = [];

  for (const member of params.eligibleMembers) {
    const existing = rowsByMember.get(member.id) ?? [];
    const plan = {
      memberId: member.id,
      ageTier: member.ageTier,
      existingInductions: inductionRefs(existing),
    };
    const hasOpenWorkflow = existing.some(
      (row) => row.status === "DRAFT" || row.status === "IN_PROGRESS",
    );
    const hasCompleted = existing.some((row) => row.status === "COMPLETED");

    if (hasOpenWorkflow) {
      openWorkflows.push(plan);
    } else if (hasCompleted) {
      alreadyCompleted.push(plan);
    } else {
      // No completed or open workflow: zero rows and VOIDED-only histories are
      // both eligible for the trusted baseline.
      toCreate.push(plan);
    }
  }

  const tierCounts = params.settings.map((setting) => ({
    tier: setting.tier,
    label: setting.label,
    eligiblePopulation: params.eligibleMembers.filter(
      (member) => member.ageTier === setting.tier,
    ).length,
    toCreate: toCreate.filter((member) => member.ageTier === setting.tier)
      .length,
    alreadyCompleted: alreadyCompleted.filter(
      (member) => member.ageTier === setting.tier,
    ).length,
    openWorkflow: openWorkflows.filter(
      (member) => member.ageTier === setting.tier,
    ).length,
  }));

  return {
    mode: params.mode,
    clubName: params.clubName,
    actorMemberId: params.actorMemberId,
    baselineDate: params.baselineDate,
    provenance: params.provenance,
    template: {
      id: params.template.id,
      name: params.template.name,
      version: params.template.version,
    },
    configuredAgeTiers: params.settings.map((setting) => ({
      tier: setting.tier,
      label: setting.label,
    })),
    tierCounts,
    counts: {
      eligiblePopulation: params.eligibleMembers.length,
      toCreate: toCreate.length,
      alreadyCompleted: alreadyCompleted.length,
      openWorkflow: openWorkflows.length,
      notApplicable: params.notApplicableMembers.length,
    },
    toCreate,
    alreadyCompleted,
    openWorkflows,
    notApplicable: params.notApplicableMembers.map((member) => ({
      memberId: member.id,
      ageTier: "NOT_APPLICABLE",
    })),
    appliedCount: 0,
  };
}

/**
 * Plan or apply a trusted legacy induction baseline.
 *
 * Dry-run is read-only. Apply acquires the MemberInduction table lock as the
 * transaction's first statement, then re-reads every decision input under that
 * lock. Existing induction rows are never updated or deleted.
 */
export async function runInductionBaseline(
  options: RunInductionBaselineOptions,
): Promise<InductionBaselineReport> {
  const input = validateInputs(options);
  const apply = options.apply === true;
  const store =
    options.store ??
    (prisma as unknown as InductionBaselineStore);
  const fallbackClubName = options.fallbackClubName ?? clubConfig.name;
  const fallbackClubNameSource =
    options.fallbackClubNameSource ?? clubConfigSource;

  return store.$transaction(
    async (tx) => {
      if (apply) {
        // This MUST remain the first database statement in the callback.
        await tx.$executeRawUnsafe(INDUCTION_BASELINE_LOCK_SQL);
      }

      const persistedIdentity = await tx.clubIdentitySettings.findUnique({
        where: { id: "default" },
        select: { name: true },
      });
      const clubName = resolveClubName({
        persistedName: persistedIdentity?.name,
        fallbackName: fallbackClubName,
        fallbackSource: fallbackClubNameSource,
      });
      if (apply && options.confirmClubName !== clubName) {
        throw new InductionBaselineError(
          "Club-name confirmation does not exactly match the effective club name.",
        );
      }

      const actor = await tx.member.findUnique({
        where: { id: input.actorMemberId },
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
      assertValidActor(actor);

      const ageTierSettings = validateAgeTierSettings(
        await tx.ageTierSetting.findMany({
          select: {
            tier: true,
            minAge: true,
            maxAge: true,
            label: true,
            sortOrder: true,
          },
          orderBy: [{ minAge: "asc" }, { tier: "asc" }],
        }),
      );
      const configuredTiers = new Set(
        ageTierSettings.map((setting) => setting.tier),
      );

      const nominationSettings =
        await tx.membershipNominationSettings.findUnique({
          where: { id: "default" },
          select: { requiredSignOffs: true },
        });
      const requiredSignOffs =
        nominationSettings?.requiredSignOffs ??
        DEFAULT_MEMBERSHIP_NOMINATION_SETTINGS.requiredSignOffs;
      if (!Number.isInteger(requiredSignOffs) || requiredSignOffs < 1) {
        throw new InductionBaselineError(
          "Induction configuration is invalid: requiredSignOffs must be an integer of at least 1.",
        );
      }

      const template = validateActiveTemplate(
        await tx.inductionChecklistTemplate.findMany({
          where: { kind: "NEW_MEMBER", isActive: true },
          select: {
            id: true,
            name: true,
            version: true,
            sections: {
              select: {
                id: true,
                title: true,
                items: { select: { id: true, label: true } },
              },
            },
          },
          orderBy: { id: "asc" },
        }),
      );

      const activePopulation = await tx.member.findMany({
        where: {
          active: true,
          archivedAt: null,
          cancelledAt: null,
          role: { in: [...MEMBER_IMPORT_ROLE_VALUES] },
        },
        select: { id: true, ageTier: true },
        orderBy: { id: "asc" },
      });
      const notApplicableMembers = activePopulation.filter(
        (member) => member.ageTier === "NOT_APPLICABLE",
      );
      const unconfiguredMembers = activePopulation.filter(
        (member) =>
          PERSON_AGE_TIERS.includes(member.ageTier) &&
          !configuredTiers.has(member.ageTier),
      );
      if (unconfiguredMembers.length > 0) {
        throw new InductionBaselineError(
          `Age-tier configuration is invalid: ${unconfiguredMembers.length} active member(s) use an unconfigured person tier.`,
        );
      }
      const eligibleMembers = activePopulation.filter((member) =>
        configuredTiers.has(member.ageTier),
      );

      const existingInductions =
        eligibleMembers.length === 0
          ? []
          : await tx.memberInduction.findMany({
              where: {
                memberId: { in: eligibleMembers.map((member) => member.id) },
              },
              select: {
                id: true,
                memberId: true,
                kind: true,
                status: true,
              },
              orderBy: [{ memberId: "asc" }, { id: "asc" }],
            });

      const report = buildReport({
        mode: apply ? "apply" : "dry-run",
        clubName,
        actorMemberId: input.actorMemberId,
        baselineDate: input.baselineDate,
        provenance: input.provenance,
        template,
        settings: ageTierSettings,
        eligibleMembers,
        notApplicableMembers,
        existingInductions,
      });

      if (!apply) {
        return report;
      }
      if (report.openWorkflows.length > 0) {
        throw new InductionBaselineBlockedError(
          `Apply blocked: ${report.openWorkflows.length} eligible member(s) have a DRAFT or IN_PROGRESS induction.`,
          report,
        );
      }
      if (report.toCreate.length === 0) {
        return report;
      }

      const created = await tx.memberInduction.createMany({
        data: report.toCreate.map((member) => ({
          memberId: member.memberId,
          templateId: template.id,
          kind: "NEW_MEMBER",
          status: "COMPLETED",
          requiredSignOffs,
          inductionDate: input.baselineTimestamp,
          completedAt: input.baselineTimestamp,
          completionSource: "ADMIN_OVERRIDE",
          finalComments: input.provenance,
          createdByMemberId: input.actorMemberId,
        })),
      });
      if (created.count !== report.toCreate.length) {
        throw new InductionBaselineError(
          `Atomic apply failed: planned ${report.toCreate.length} row(s) but created ${created.count}.`,
        );
      }

      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "MEMBER_INDUCTION_LEGACY_BASELINE_APPLIED",
          actor: { memberId: input.actorMemberId },
          entity: { type: "MemberInductionBaseline", id: input.baselineDate },
          category: "lodge",
          severity: "critical",
          summary: `Applied trusted legacy induction baseline to ${created.count} member(s).`,
          details: input.provenance,
          metadata: {
            baselineDate: input.baselineDate,
            templateId: template.id,
            configuredAgeTiers: ageTierSettings.map((setting) => setting.tier),
            counts: report.counts,
          },
          retentionClass: "critical",
        }),
      );

      return { ...report, appliedCount: created.count };
    },
    {
      isolationLevel: "Serializable",
      maxWait: 10_000,
      timeout: 120_000,
    },
  );
}
