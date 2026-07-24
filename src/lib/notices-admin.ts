import "server-only";

import type { NoticeAudienceKind, NoticeStatus } from "@prisma/client";
import type { NoticeAudienceInput } from "@/lib/notices";
import { prisma } from "@/lib/prisma";

/**
 * Dedupe a notice's audience rows so a replace-all write never stores the same
 * target twice. ALL_MEMBERS collapses to one row; each typed target keys on its
 * id. (ALL_MEMBERS is intentionally NOT allowed to suppress explicit MEMBER
 * rows: an explicit MEMBER target additionally exempts that member from the
 * financialMembersOnly filter, so it carries meaning beyond group membership.)
 */
export function dedupeNoticeAudiences(
  audiences: readonly NoticeAudienceInput[],
): NoticeAudienceInput[] {
  const seen = new Set<string>();
  const out: NoticeAudienceInput[] = [];
  for (const audience of audiences) {
    let key: string;
    switch (audience.kind) {
      case "MEMBER":
        key = `MEMBER:${audience.memberId}`;
        break;
      case "MEMBERSHIP_TYPE":
        key = `MEMBERSHIP_TYPE:${audience.membershipTypeId}`;
        break;
      case "LODGE":
        key = `LODGE:${audience.lodgeId}`;
        break;
      case "COMMITTEE_ROLE":
        key = `COMMITTEE_ROLE:${audience.committeeRoleId}`;
        break;
      case "ALL_MEMBERS":
      default:
        key = "ALL_MEMBERS";
        break;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(audience);
  }
  return out;
}

/**
 * Verify every typed audience target id refers to an existing row. Returns an
 * error message on the first missing set, else null. Real FKs would also reject
 * a bad id at write time, but validating up front gives a clean 400.
 */
export async function validateNoticeAudienceTargets(
  audiences: readonly NoticeAudienceInput[],
): Promise<string | null> {
  const memberIds = audiences
    .filter((a): a is Extract<NoticeAudienceInput, { kind: "MEMBER" }> => a.kind === "MEMBER")
    .map((a) => a.memberId);
  const typeIds = audiences
    .filter(
      (a): a is Extract<NoticeAudienceInput, { kind: "MEMBERSHIP_TYPE" }> =>
        a.kind === "MEMBERSHIP_TYPE",
    )
    .map((a) => a.membershipTypeId);
  const lodgeIds = audiences
    .filter((a): a is Extract<NoticeAudienceInput, { kind: "LODGE" }> => a.kind === "LODGE")
    .map((a) => a.lodgeId);
  const roleIds = audiences
    .filter(
      (a): a is Extract<NoticeAudienceInput, { kind: "COMMITTEE_ROLE" }> =>
        a.kind === "COMMITTEE_ROLE",
    )
    .map((a) => a.committeeRoleId);

  if (memberIds.length > 0) {
    const found = await prisma.member.count({ where: { id: { in: memberIds } } });
    if (found !== new Set(memberIds).size) {
      return "One or more member targets do not exist";
    }
  }
  if (typeIds.length > 0) {
    const found = await prisma.membershipType.count({ where: { id: { in: typeIds } } });
    if (found !== new Set(typeIds).size) {
      return "One or more membership type targets do not exist";
    }
  }
  if (lodgeIds.length > 0) {
    const found = await prisma.lodge.count({ where: { id: { in: lodgeIds } } });
    if (found !== new Set(lodgeIds).size) {
      return "One or more lodge targets do not exist";
    }
  }
  if (roleIds.length > 0) {
    const found = await prisma.committeeRole.count({ where: { id: { in: roleIds } } });
    if (found !== new Set(roleIds).size) {
      return "One or more committee role targets do not exist";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Admin-facing notice reads. Unlike the member-facing helpers in notices.ts,
// these expose audience definitions and receipt counts — admin-only surfaces.
// ---------------------------------------------------------------------------

export type AdminNoticeAudience = {
  id: string;
  kind: NoticeAudienceKind;
  targetId: string | null;
  /** Joined display name of the target (member/type/lodge/role), or null for
   *  ALL_MEMBERS and for a target row whose join is missing. */
  targetName: string | null;
};

export type AdminNotice = {
  id: string;
  title: string;
  status: NoticeStatus;
  publishedAt: string | null;
  expiresAt: string | null;
  pinned: boolean;
  requiresAcknowledgement: boolean;
  financialMembersOnly: boolean;
  emailedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  audiences: AdminNoticeAudience[];
  audienceCount: number;
  readCount: number;
  acknowledgedCount: number;
};

export type AdminNoticeGroups = {
  published: AdminNotice[];
  draft: AdminNotice[];
  archived: AdminNotice[];
};

// The single-notice detail view additionally carries bodyHtml so the admin
// editor can round-trip the stored body. The grouped list deliberately omits
// bodyHtml (it can be large per notice).
export type AdminNoticeDetail = AdminNotice & { bodyHtml: string };

const ADMIN_NOTICE_SELECT = {
  id: true,
  title: true,
  status: true,
  publishedAt: true,
  expiresAt: true,
  pinned: true,
  requiresAcknowledgement: true,
  financialMembersOnly: true,
  emailedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { firstName: true, lastName: true } },
  audiences: {
    select: {
      id: true,
      kind: true,
      memberId: true,
      membershipTypeId: true,
      lodgeId: true,
      committeeRoleId: true,
      member: { select: { firstName: true, lastName: true } },
      membershipType: { select: { name: true } },
      lodge: { select: { name: true } },
      committeeRole: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  },
} as const;

type AdminNoticeRow = {
  id: string;
  title: string;
  status: NoticeStatus;
  publishedAt: Date | null;
  expiresAt: Date | null;
  pinned: boolean;
  requiresAcknowledgement: boolean;
  financialMembersOnly: boolean;
  emailedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: { firstName: string; lastName: string } | null;
  audiences: Array<{
    id: string;
    kind: NoticeAudienceKind;
    memberId: string | null;
    membershipTypeId: string | null;
    lodgeId: string | null;
    committeeRoleId: string | null;
    member: { firstName: string; lastName: string } | null;
    membershipType: { name: string } | null;
    lodge: { name: string } | null;
    committeeRole: { name: string } | null;
  }>;
};

function serializeAudience(
  audience: AdminNoticeRow["audiences"][number],
): AdminNoticeAudience {
  switch (audience.kind) {
    case "MEMBER":
      return {
        id: audience.id,
        kind: audience.kind,
        targetId: audience.memberId,
        targetName: audience.member
          ? `${audience.member.firstName} ${audience.member.lastName}`.trim()
          : null,
      };
    case "MEMBERSHIP_TYPE":
      return {
        id: audience.id,
        kind: audience.kind,
        targetId: audience.membershipTypeId,
        targetName: audience.membershipType?.name ?? null,
      };
    case "LODGE":
      return {
        id: audience.id,
        kind: audience.kind,
        targetId: audience.lodgeId,
        targetName: audience.lodge?.name ?? null,
      };
    case "COMMITTEE_ROLE":
      return {
        id: audience.id,
        kind: audience.kind,
        targetId: audience.committeeRoleId,
        targetName: audience.committeeRole?.name ?? null,
      };
    case "ALL_MEMBERS":
    default:
      return { id: audience.id, kind: audience.kind, targetId: null, targetName: null };
  }
}

function serializeAdminNotice(
  notice: AdminNoticeRow,
  counts: { read: number; acknowledged: number },
): AdminNotice {
  return {
    id: notice.id,
    title: notice.title,
    status: notice.status,
    publishedAt: notice.publishedAt?.toISOString() ?? null,
    expiresAt: notice.expiresAt?.toISOString() ?? null,
    pinned: notice.pinned,
    requiresAcknowledgement: notice.requiresAcknowledgement,
    financialMembersOnly: notice.financialMembersOnly,
    emailedAt: notice.emailedAt?.toISOString() ?? null,
    createdAt: notice.createdAt.toISOString(),
    updatedAt: notice.updatedAt.toISOString(),
    createdByName: notice.createdBy
      ? `${notice.createdBy.firstName} ${notice.createdBy.lastName}`.trim()
      : null,
    audiences: notice.audiences.map(serializeAudience),
    audienceCount: notice.audiences.length,
    readCount: counts.read,
    acknowledgedCount: counts.acknowledged,
  };
}

/**
 * All notices for the admin index, grouped by status (mirrors
 * listSiteBannersForAdmin's grouped shape). Each notice carries its audience
 * rows with joined target names and its read/acknowledged receipt counts.
 */
export async function listNoticesForAdmin(): Promise<AdminNoticeGroups> {
  const notices = (await prisma.notice.findMany({
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    select: ADMIN_NOTICE_SELECT,
  })) as AdminNoticeRow[];

  const ids = notices.map((n) => n.id);
  const [readCounts, ackCounts] = ids.length
    ? await Promise.all([
        prisma.noticeReadReceipt.groupBy({
          by: ["noticeId"],
          where: { noticeId: { in: ids } },
          _count: { _all: true },
        }),
        prisma.noticeReadReceipt.groupBy({
          by: ["noticeId"],
          where: { noticeId: { in: ids }, acknowledgedAt: { not: null } },
          _count: { _all: true },
        }),
      ])
    : [[], []];

  const readByNotice = new Map(
    readCounts.map((row) => [row.noticeId, row._count._all]),
  );
  const ackByNotice = new Map(
    ackCounts.map((row) => [row.noticeId, row._count._all]),
  );

  const groups: AdminNoticeGroups = { published: [], draft: [], archived: [] };
  for (const notice of notices) {
    const serialized = serializeAdminNotice(notice, {
      read: readByNotice.get(notice.id) ?? 0,
      acknowledged: ackByNotice.get(notice.id) ?? 0,
    });
    if (notice.status === "PUBLISHED") {
      groups.published.push(serialized);
    } else if (notice.status === "ARCHIVED") {
      groups.archived.push(serialized);
    } else {
      groups.draft.push(serialized);
    }
  }

  // Published: pinned first, then newest published. Draft/archived: newest
  // updated (already ordered by the query, but re-sort published on publishedAt).
  groups.published.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
  });

  return groups;
}

/**
 * One notice with its full body, audience rows (joined names), and receipt
 * counts — for the admin editor's edit view. Returns null when not found.
 */
export async function getAdminNoticeById(
  id: string,
): Promise<AdminNoticeDetail | null> {
  const notice = (await prisma.notice.findUnique({
    where: { id },
    select: { ...ADMIN_NOTICE_SELECT, bodyHtml: true },
  })) as (AdminNoticeRow & { bodyHtml: string }) | null;
  if (!notice) {
    return null;
  }

  const [readCount, acknowledgedCount] = await Promise.all([
    prisma.noticeReadReceipt.count({ where: { noticeId: id } }),
    prisma.noticeReadReceipt.count({
      where: { noticeId: id, acknowledgedAt: { not: null } },
    }),
  ]);

  return {
    ...serializeAdminNotice(notice, { read: readCount, acknowledged: acknowledgedCount }),
    bodyHtml: notice.bodyHtml,
  };
}
