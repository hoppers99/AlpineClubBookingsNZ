import {
  MembershipCancellationParticipantStatus,
  MembershipCancellationRequestStatus,
  type Prisma,
} from "@prisma/client";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { memberHoldsPrivilegedRole, type UserType } from "@/lib/access-roles";
import {
  actorIsFullAdmin,
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
  wouldRemoveLastFullAdmin,
} from "@/lib/admin-account-guards";
import { createAuditLog } from "@/lib/audit";
import {
  sendMembershipCancellationApprovedEmail,
  sendMembershipCancellationRejectedEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import { classifyAccountRecord } from "@/lib/member-roles";
import {
  buildMembershipCancellationApprovalBlockedMessage,
  buildMembershipCancellationSharedInvoiceMessage,
  type MembershipCancellationSharedInvoiceNotice,
} from "@/lib/membership-cancellation-blocker-messages";
import {
  emptyMembershipCancellationBlockerMap,
  loadMembershipCancellationBlockersByMemberId,
  type MembershipCancellationBlocker,
} from "@/lib/membership-cancellation-blockers";
import {
  buildMembershipCancellationSharedInvoiceNotices,
  buildSharedInvoiceNotice,
  loadMembershipCancellationSubscriptionCreditPlansByMemberId,
} from "@/lib/membership-cancellation-subscription-credit";
import {
  EMPTY_ORPHANED_FAMILY_LINKS,
  readFamilyLinkOrphans,
  type OrphanedFamilyLinks,
} from "@/lib/member-family-link-orphans";
import { loadMembershipCancellationSettings } from "@/lib/membership-cancellation-settings";
import {
  cleanText,
  memberName,
  serializeDate,
  serializeMember,
} from "@/lib/member-serialization";
import { prisma } from "@/lib/prisma";
import { queueApprovedMembershipCancellationXeroOperations } from "@/lib/xero-operation-outbox";

const REVIEWABLE_REQUEST_STATUSES: readonly MembershipCancellationRequestStatus[] = [
  MembershipCancellationRequestStatus.REQUESTED,
] as const;

const REVIEWABLE_REJECTION_STATUSES: readonly MembershipCancellationParticipantStatus[] = [
  MembershipCancellationParticipantStatus.REQUESTED,
  MembershipCancellationParticipantStatus.PENDING_CONFIRMATION,
] as const;

/**
 * Everything the review queue needs in order to ask "could an approval of this
 * participant actually be attempted right now?" (#2402).
 */
export type MembershipCancellationApprovalCandidate = {
  requestStatus: MembershipCancellationRequestStatus;
  status: MembershipCancellationParticipantStatus;
  confirmedAt: Date | null;
  member: { active: boolean; cancelledAt: Date | null };
};

/**
 * THE definition of "still awaiting approval" — one place, so the review queue,
 * the post-review reload and the tests cannot each carry their own (#2402).
 *
 * It is deliberately the conjunction of the two approval-time guards' own
 * preconditions, read straight off them:
 *
 * - `assertRequestCanBeReviewed` — the REQUEST is still `REQUESTED`;
 * - `assertParticipantCanBeApproved` — the participant is `REQUESTED`, has
 *   confirmed, and the membership is neither deactivated nor already cancelled.
 *
 * Those guards are NOT re-expressed in terms of this predicate: they throw one
 * specific message each, and rewriting them to share this would have been a
 * change to the approval path, which #2402 is explicitly not. The agreement is
 * held by test instead (`membership-cancellation-admin.test.ts`), which drives
 * every shape through both and asserts they answer alike.
 *
 * What it is FOR: the queue's unpaid-invoice check is a live Xero read, and Xero
 * bills the club for a daily quota of them. Spending one on a participant whose
 * outcome is already settled — rejected, already cancelled, still awaiting the
 * member's own confirmation — buys nothing, because no approval of that
 * participant is possible for the answer to inform. The one promise that must
 * not break is the other way round: anything an admin could press Approve on
 * gets checked, so blockers are on screen BEFORE the button. That is why the
 * predicate mirrors the guards rather than approximating them, and why it is
 * never narrower than the enabled-Approve condition the page itself uses.
 */
export function isMembershipCancellationParticipantAwaitingApproval(
  candidate: MembershipCancellationApprovalCandidate,
): boolean {
  return (
    REVIEWABLE_REQUEST_STATUSES.includes(candidate.requestStatus) &&
    candidate.status === MembershipCancellationParticipantStatus.REQUESTED &&
    candidate.confirmedAt !== null &&
    candidate.member.active &&
    candidate.member.cancelledAt === null
  );
}

type AdminCancellationRequestRecord =
  Prisma.MembershipCancellationRequestGetPayload<{
    include: {
      requestedBy: { select: typeof memberSummarySelect };
      reviewedBy: { select: typeof memberSummarySelect };
      participants: {
        include: {
          reviewedBy: { select: typeof memberSummarySelect };
          member: {
            select: typeof cancellationParticipantMemberSelect;
          };
        };
      };
    };
  }>;

export type AdminCancellationStatusFilter =
  | MembershipCancellationRequestStatus
  | "ALL";

type AdminSerializedMembershipCancellationParticipant = {
  id: string;
  memberId: string;
  name: string;
  email: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  cancelledAt: string | null;
  status: string;
  reason: string | null;
  adminNote: string | null;
  confirmationTokenExpiresAt: string | null;
  confirmedAt: string | null;
  declinedAt: string | null;
  reviewedAt: string | null;
  cancelledAtParticipant: string | null;
  reviewedBy: { id: string; name: string; email: string } | null;
  blockers: MembershipCancellationBlocker[];
  /**
   * #2400: set when this member's subscription invoice also covers other members
   * who are staying, so this cancellation credits nothing against it.
   *
   * Not itself a blocker — it adds no reason to refuse — but it does not promise
   * the approval will go through either. The family's invoice is raised to the
   * charge RECIPIENT's Xero contact, so when the recipient is the one leaving
   * that uncredited balance sits on a contact the approval would archive and the
   * unpaid-invoice blocker refuses it outright. `notice.blocksApproval` says
   * which of the two this participant is, and the wording follows it (#2400
   * review, F2).
   */
  sharedInvoiceNotice: MembershipCancellationSharedInvoiceNotice | null;
  /**
   * #2402: true when this participant COULD be approved, but the approval
   * pre-checks were not run for this viewer — so `blockers` and
   * `sharedInvoiceNotice` are silent because nothing was asked, not because
   * nothing is wrong.
   *
   * Only ever true for a viewer without `membership: edit`. The whole point of
   * the field is that an empty amber panel must not read as "nothing is owing"
   * to somebody who was never told either way; the queue renders an explicit
   * "not checked" line off this flag instead of showing nothing at all.
   */
  blockerCheckSkipped: boolean;
  /** True when approving this participant requires a Full Admin (#1604/#2383). */
  holdsPrivilegedAccess: boolean;
  /** Derived User Type, so an organisation account is visibly one. */
  accountType: UserType;
};

export type AdminSerializedMembershipCancellationRequest = {
  id: string;
  status: string;
  reason: string | null;
  adminNote: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  completedAt: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  reviewedBy: { id: string; name: string; email: string } | null;
  participants: AdminSerializedMembershipCancellationParticipant[];
};

export class MembershipCancellationAdminError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MembershipCancellationAdminError";
  }
}

const memberSummarySelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
} satisfies Prisma.MemberSelect;

const cancellationParticipantMemberSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  ageTier: true,
  active: true,
  canLogin: true,
  cancelledAt: true,
  cancelledReason: true,
  cancelledViaRequestId: true,
  // #2383: the queue must show WHAT is being cancelled, not just who. Since
  // any account holder is now cancellable, "de-logins the Treasurer" and
  // "closes the school's account" would otherwise look identical to an ordinary
  // member, and a scoped Membership Officer can raise either. These are the
  // same fields the approval-time privileged-target guard reads, so the badge
  // and the guard cannot disagree — minus the joined definition rows, which
  // carry a full permission matrix each and are not needed: a custom role is
  // identified by its `roleDefinitionId` token alone.
  role: true,
  financeAccessLevel: true,
  accessRoles: { select: { role: true, roleDefinitionId: true } },
} satisfies Prisma.MemberSelect;

const adminCancellationRequestInclude = {
  requestedBy: { select: memberSummarySelect },
  reviewedBy: { select: memberSummarySelect },
  participants: {
    include: {
      reviewedBy: { select: memberSummarySelect },
      member: { select: cancellationParticipantMemberSelect },
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.MembershipCancellationRequestInclude;

type SerializeRequestOptions = {
  blockersByMemberId?: ReadonlyMap<
    string,
    MembershipCancellationBlocker[]
  >;
  // #2400: absent by default, exactly like the blocker map — a caller that has
  // not asked shows no notice rather than an unexplained empty one.
  sharedInvoiceNoticesByMemberId?: ReadonlyMap<
    string,
    MembershipCancellationSharedInvoiceNotice | null
  >;
  /**
   * #2402: whether the viewer this payload is for holds `membership: edit`, and
   * so whether the approval pre-checks above were run at all. Required — not
   * defaulted — because getting it wrong in either direction is a lie to an
   * admin about money: defaulted true would silently claim a check that never
   * happened, defaulted false would tell an approver their checks were skipped
   * when they were not.
   */
  viewerCanApprove: boolean;
};

function serializeRequest(
  request: AdminCancellationRequestRecord,
  {
    blockersByMemberId = emptyMembershipCancellationBlockerMap(
      request.participants.map((participant) => participant.memberId),
    ),
    sharedInvoiceNoticesByMemberId = new Map<
      string,
      MembershipCancellationSharedInvoiceNotice | null
    >(),
    viewerCanApprove,
  }: SerializeRequestOptions,
): AdminSerializedMembershipCancellationRequest {
  return {
    id: request.id,
    status: request.status,
    reason: request.reason,
    adminNote: request.adminNote,
    submittedAt: request.submittedAt.toISOString(),
    reviewedAt: serializeDate(request.reviewedAt),
    completedAt: serializeDate(request.completedAt),
    requestedBy: serializeMember(request.requestedBy),
    reviewedBy: serializeMember(request.reviewedBy),
    participants: request.participants.map((participant) => ({
      id: participant.id,
      memberId: participant.memberId,
      name: memberName(participant.member),
      email: participant.member.email,
      ageTier: participant.member.ageTier,
      active: participant.member.active,
      canLogin: participant.member.canLogin,
      cancelledAt: serializeDate(participant.member.cancelledAt),
      status: participant.status,
      reason: participant.reason,
      adminNote: participant.adminNote,
      confirmationTokenExpiresAt: serializeDate(
        participant.confirmationTokenExpiresAt,
      ),
      confirmedAt: serializeDate(participant.confirmedAt),
      declinedAt: serializeDate(participant.declinedAt),
      reviewedAt: serializeDate(participant.reviewedAt),
      cancelledAtParticipant: serializeDate(participant.cancelledAt),
      reviewedBy: serializeMember(participant.reviewedBy),
      blockers: blockersByMemberId.get(participant.memberId) ?? [],
      sharedInvoiceNotice:
        sharedInvoiceNoticesByMemberId.get(participant.memberId) ?? null,
      // #2402: said out loud only where the silence would otherwise be
      // ambiguous — a participant somebody COULD approve, whose checks this
      // viewer did not earn. A settled or unconfirmed participant has an empty
      // panel for a reason the queue already shows (its status badge), and
      // saying "not checked" there would be noise.
      blockerCheckSkipped:
        !viewerCanApprove &&
        isMembershipCancellationParticipantAwaitingApproval({
          requestStatus: request.status,
          status: participant.status,
          confirmedAt: participant.confirmedAt,
          member: participant.member,
        }),
      // #2383: what the reviewer is actually approving. `holdsPrivilegedAccess`
      // is the exact predicate the approval guard uses, so it is a promise:
      // approving this participant needs a Full Admin.
      holdsPrivilegedAccess: memberHoldsPrivilegedRole(participant.member),
      accountType: classifyAccountRecord(participant.member),
    })),
  };
}

function deriveRequestStatus(
  participants: Array<{ status: MembershipCancellationParticipantStatus }>,
) {
  if (
    participants.some((participant) =>
      REVIEWABLE_REJECTION_STATUSES.includes(participant.status),
    )
  ) {
    return MembershipCancellationRequestStatus.REQUESTED;
  }

  if (
    participants.some(
      (participant) =>
        participant.status ===
        MembershipCancellationParticipantStatus.CANCELLED,
    )
  ) {
    return MembershipCancellationRequestStatus.COMPLETED;
  }

  if (participants.length > 0) {
    return MembershipCancellationRequestStatus.REJECTED;
  }

  return MembershipCancellationRequestStatus.REQUESTED;
}

async function getAdminRequestById(requestId: string) {
  return prisma.membershipCancellationRequest.findUnique({
    where: { id: requestId },
    include: adminCancellationRequestInclude,
  });
}

async function updateRequestLifecycle(
  tx: Prisma.TransactionClient,
  requestId: string,
  adminMemberId: string,
  now: Date,
  adminNote: string | null,
) {
  const participants =
    await tx.membershipCancellationRequestParticipant.findMany({
      where: { requestId },
      select: { status: true },
    });
  const nextStatus = deriveRequestStatus(participants);

  await tx.membershipCancellationRequest.update({
    where: { id: requestId },
    data: {
      status: nextStatus,
      ...(nextStatus !== MembershipCancellationRequestStatus.REQUESTED
        ? {
            reviewedByMemberId: adminMemberId,
            reviewedAt: now,
            completedAt:
              nextStatus === MembershipCancellationRequestStatus.COMPLETED
                ? now
                : null,
            adminNote,
          }
        : {}),
    },
  });

  return nextStatus;
}

function assertRequestCanBeReviewed(
  request: { status: MembershipCancellationRequestStatus },
) {
  if (!REVIEWABLE_REQUEST_STATUSES.includes(request.status)) {
    throw new MembershipCancellationAdminError(
      "This cancellation request has already been reviewed.",
      409,
    );
  }
}

function assertParticipantCanBeApproved(participant: {
  status: MembershipCancellationParticipantStatus;
  confirmedAt: Date | null;
  member: { active: boolean; cancelledAt: Date | null };
}) {
  if (participant.status !== MembershipCancellationParticipantStatus.REQUESTED) {
    throw new MembershipCancellationAdminError(
      "Only confirmed cancellation participants can be approved.",
      409,
    );
  }

  if (!participant.confirmedAt) {
    throw new MembershipCancellationAdminError(
      "This participant has not confirmed their cancellation request.",
      409,
    );
  }

  if (!participant.member.active || participant.member.cancelledAt) {
    throw new MembershipCancellationAdminError(
      "This membership is already inactive or cancelled.",
      409,
    );
  }
}

/**
 * Separation of duties: whoever raised a cancellation may not approve it.
 *
 * Fails CLOSED on a missing requester (#2383 review). `requestedByMemberId` is
 * `onDelete: SetNull`, so hard-deleting the raiser nulls it — and with the
 * widened entry rule this guard is the only thing standing between an admin and
 * approving their own cancellation. "We cannot tell who raised this" must
 * therefore mean "not you", not "anyone". Rejecting the request is unaffected,
 * so such a request is never stuck: reject it and raise it again.
 */
function assertCancellationApprovalIsIndependent(
  requestedByMemberId: string | null,
  adminMemberId: string,
) {
  if (!requestedByMemberId) {
    throw new MembershipCancellationAdminError(
      "The admin who raised this request is no longer on file, so it cannot be confirmed as an independent approval. Reject it and raise a new request.",
      403,
    );
  }
  if (requestedByMemberId === adminMemberId) {
    throw new MembershipCancellationAdminError(
      "Cancellation requests must be approved by a different admin.",
      403,
    );
  }
}

function assertParticipantCanBeRejected(participant: {
  status: MembershipCancellationParticipantStatus;
}) {
  if (!REVIEWABLE_REJECTION_STATUSES.includes(participant.status)) {
    throw new MembershipCancellationAdminError(
      "This participant has already been reviewed.",
      409,
    );
  }
}

async function loadParticipantForReview(
  requestId: string,
  participantId: string,
) {
  const participant =
    await prisma.membershipCancellationRequestParticipant.findUnique({
      where: { id: participantId },
      include: {
        member: { select: cancellationParticipantMemberSelect },
        request: {
          select: {
            id: true,
            status: true,
            reason: true,
            requestedByMemberId: true,
          },
        },
      },
    });

  if (!participant || participant.requestId !== requestId) {
    throw new MembershipCancellationAdminError(
      "Cancellation participant not found.",
      404,
    );
  }

  return participant;
}

async function sendCancellationOutcomeEmail(params: {
  action: "approve" | "reject";
  member: {
    email: string;
    firstName: string;
    lastName: string;
  };
  requestReason: string | null;
  adminNote: string | null;
}) {
  try {
    if (params.action === "approve") {
      const settings = await loadMembershipCancellationSettings();
      await sendMembershipCancellationApprovedEmail({
        email: params.member.email,
        firstName: params.member.firstName,
        participantName: memberName(params.member),
        reason: params.requestReason,
        adminNote: params.adminNote,
        rejoinProcessText: settings.rejoinProcessText,
      });
      return;
    }

    await sendMembershipCancellationRejectedEmail({
      email: params.member.email,
      firstName: params.member.firstName,
      participantName: memberName(params.member),
      reason: params.requestReason,
      adminNote: params.adminNote,
    });
  } catch (err) {
    logger.error(
      { err, email: params.member.email },
      "Failed to send membership cancellation outcome email",
    );
  }
}

export async function getPendingMembershipCancellationReviewCount() {
  return prisma.membershipCancellationRequest.count({
    where: {
      status: MembershipCancellationRequestStatus.REQUESTED,
      participants: {
        some: {
          status: MembershipCancellationParticipantStatus.REQUESTED,
          confirmedAt: { not: null },
        },
      },
    },
  });
}

/**
 * The admin review queue.
 *
 * ## Who pays for the Xero check (#2402)
 *
 * The unpaid-invoice half of the blocker set is a LIVE Xero read, and Xero meters
 * the club's API calls daily. This queue used to run it for every participant on
 * the page on every load, filter change and refresh, whoever was looking — so a
 * view-only membership admin browsing the queue spent the same quota as a
 * reviewer about to act on it, for an answer neither of them could use.
 *
 * The owner's decision (31 Jul 2026, recorded on #2402) is to run the check only
 * where its answer can still change what somebody does:
 *
 * 1. **the viewer holds `membership: edit`** — the exact permission the review
 *    endpoint requires, so "could this person press Approve at all?"; and
 * 2. **the participant is still awaiting approval** — see
 *    {@link isMembershipCancellationParticipantAwaitingApproval}.
 *
 * The accepted cost, stated rather than glossed: a view-only admin no longer
 * learns from this queue that money is owing. They are not left to guess,
 * though — `blockerCheckSkipped` marks each participant whose checks were not
 * run, and the queue says so in words, because an empty amber panel and "nothing
 * is owing" look identical and only one of them is true.
 *
 * The shared-invoice notice (#2400) is skipped with it, although it costs no
 * Xero call. It is built from the blockers as well as the credit plans — its
 * `blocksApproval` field says whether the unpaid-invoice check refuses over that
 * very invoice — so building it without them would not be a cheaper notice, it
 * would be a notice asserting "this does not block approval" on the strength of
 * a check that never ran.
 *
 * None of this touches the approval-time check, which stays live, fresh and
 * fail-closed in `reviewMembershipCancellationParticipant`. This is the render
 * only.
 */
export async function getAdminMembershipCancellationRequests({
  status = MembershipCancellationRequestStatus.REQUESTED,
  page = 1,
  pageSize = 25,
  viewerCanApprove,
}: {
  status?: AdminCancellationStatusFilter;
  page?: number;
  pageSize?: number;
  /**
   * Whether the admin being served holds `membership: edit`. Required, and
   * never inferred here: this module has no session, and a default in either
   * direction would be a guess about somebody's permissions.
   */
  viewerCanApprove: boolean;
}) {
  const where =
    status === "ALL"
      ? {}
      : {
          status,
        };

  const [requests, total, pendingCount] = await Promise.all([
    prisma.membershipCancellationRequest.findMany({
      where,
      include: adminCancellationRequestInclude,
      orderBy: { submittedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.membershipCancellationRequest.count({ where }),
    getPendingMembershipCancellationReviewCount(),
  ]);

  // #2402: the members whose approval pre-checks are worth running. Empty for a
  // view-only viewer, which makes every load below a no-op — both loaders return
  // an empty map without touching the database or Xero when handed no ids — so
  // the skip needs no branch here and cannot half-happen.
  const participantMemberIds = viewerCanApprove
    ? requests.flatMap((request) =>
        request.participants
          .filter((participant) =>
            isMembershipCancellationParticipantAwaitingApproval({
              requestStatus: request.status,
              status: participant.status,
              confirmedAt: participant.confirmedAt,
              member: participant.member,
            }),
          )
          .map((participant) => participant.memberId),
      )
    : [];
  // #2400: the shared-invoice notice reads only local records — no Xero call.
  // The credit plans are loaded ONCE for the page and handed to both consumers:
  // the blocker check needs them to decide its exclusion, and the notice is
  // built from the same plans plus the blockers, so the plan read (an `in` list
  // over MemberSubscription.xeroInvoiceId) happens once per page load rather
  // than twice (#2400 review, F8). The notice is built last because it has to
  // know whether the approval will actually be refused over that same invoice.
  const creditPlansByMemberId =
    await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
      participantMemberIds,
    );
  const blockersByMemberId = await loadMembershipCancellationBlockersByMemberId(
    participantMemberIds,
    prisma,
    { creditPlansByMemberId },
  );
  const sharedInvoiceNoticesByMemberId =
    buildMembershipCancellationSharedInvoiceNotices(
      creditPlansByMemberId,
      blockersByMemberId,
    );

  return {
    requests: requests.map((request) =>
      serializeRequest(request, {
        blockersByMemberId,
        sharedInvoiceNoticesByMemberId,
        viewerCanApprove,
      }),
    ),
    pendingCount,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function reviewMembershipCancellationParticipant({
  requestId,
  participantId,
  action,
  adminMemberId,
  adminNote,
  ipAddress,
  notifyMember,
}: {
  requestId: string;
  participantId: string;
  action: "approve" | "reject";
  adminMemberId: string;
  adminNote?: string | null;
  ipAddress?: string | null;
  // #1787: admin per-action email choice. Absent/undefined = notify (default);
  // false = suppress the member outcome email. Only recorded in the audit when
  // a notification was actually suppressed.
  notifyMember?: boolean;
}) {
  const note = cleanText(adminNote);
  const participant = await loadParticipantForReview(requestId, participantId);
  assertRequestCanBeReviewed(participant.request);

  // #2400: what this approval will (or will not) do to a shared family invoice.
  // Filled on the approve path only, and read twice — once to give the refusal
  // its real route out (F5), once to record in the audit trail that a credit
  // note was deliberately NOT raised, so "why was there no credit note for the
  // Smiths?" is answerable from the audit rather than only from a Xero
  // sync-operation payload (F7).
  let sharedInvoiceNotice: MembershipCancellationSharedInvoiceNotice | null =
    null;

  if (action === "approve") {
    assertCancellationApprovalIsIndependent(
      participant.request.requestedByMemberId,
      adminMemberId,
    );
    assertParticipantCanBeApproved(participant);
    // #2392: the approval decision is always taken on a LIVE unpaid-invoice
    // answer, never the review queue's short-lived memo — approving archives the
    // member's Xero contact, so a stale "nothing owing" must not be able to let
    // one through.
    const creditPlansByMemberId =
      await loadMembershipCancellationSubscriptionCreditPlansByMemberId([
        participant.memberId,
      ]);
    const blockersByMemberId =
      await loadMembershipCancellationBlockersByMemberId(
        [participant.memberId],
        prisma,
        { freshInvoiceCheck: true, creditPlansByMemberId },
      );
    const blockers = blockersByMemberId.get(participant.memberId) ?? [];
    const creditPlan = creditPlansByMemberId.get(participant.memberId) ?? null;
    sharedInvoiceNotice =
      creditPlan && !creditPlan.creditsInFull
        ? buildSharedInvoiceNotice(creditPlan, blockers)
        : null;
    if (blockers.length > 0) {
      // The refusal has to be actionable — it names the invoices and says how to
      // clear them — so the audit record and the message the approver sees are
      // the same sentence, built once. Where one of those invoices is the
      // family's own, the generic "pay, credit or void it" is not the real route
      // out, so the shared-invoice explanation goes in too and an API caller
      // reads exactly what the review queue shows (#2400 review, F5).
      const blockedMessage = buildMembershipCancellationApprovalBlockedMessage(
        blockers,
        sharedInvoiceNotice,
      );

      await createAuditLog({
        action: "membership_cancellation.approval_blocked",
        memberId: adminMemberId,
        actorMemberId: adminMemberId,
        subjectMemberId: participant.memberId,
        targetId: participant.requestId,
        entityType: "MembershipCancellationRequest",
        entityId: participant.requestId,
        category: "account",
        severity: "important",
        outcome: "blocked",
        summary: "Membership cancellation approval blocked",
        details: blockedMessage,
        metadata: {
          blockers,
          blockerTypes: [...new Set(blockers.map((blocker) => blocker.type))],
          ...(sharedInvoiceNotice ? { sharedInvoiceNotice } : {}),
        },
        ipAddress,
      });

      throw new MembershipCancellationAdminError(blockedMessage, 409, {
        blockers,
      });
    }
  } else {
    assertParticipantCanBeRejected(participant);
  }

  // #1787: honesty rule — only record the notify choice when an outcome email
  // was actually suppressed. Both approve and reject unconditionally send an
  // outcome email below (Member.email is non-nullable, no email-presence
  // guard), so the sole discriminator is whether the admin opted out.
  const notifyAuditFields =
    notifyMember === false ? { notifyMember: false } : {};

  // #2255: filled inside the transaction, read after it. Declared out here
  // because the family links it describes no longer exist by the time the
  // transaction commits — this is the only record of what the sweep detached.
  let orphanedByCancellation: OrphanedFamilyLinks = EMPTY_ORPHANED_FAMILY_LINKS;

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (action === "approve") {
      // Admin-account guards (issue #1604/#1622). Approving a cancellation
      // clears active/canLogin on the target, a de-login of the same class the
      // #1604 guards protect. Enforced inside the transaction so the last-admin
      // count sees this mutation's read view. The target's role fields are read
      // in-transaction and evaluated canLogin-blind via memberHoldsPrivilegedRole.
      const guardTarget = await tx.member.findUnique({
        where: { id: participant.memberId },
        select: {
          role: true,
          financeAccessLevel: true,
          accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
        },
      });
      if (
        guardTarget &&
        !(await actorIsFullAdmin(tx, adminMemberId)) &&
        memberHoldsPrivilegedRole(guardTarget)
      ) {
        throw new MembershipCancellationAdminError(
          PRIVILEGED_TARGET_GUARD_MESSAGE,
          403,
        );
      }
      // Single-target: a per-participant approval de-logins exactly this member
      // (the sibling updateMany calls below null FK links, not canLogin), so the
      // single-target end-state check is the correct primitive here.
      if (await wouldRemoveLastFullAdmin(tx, participant.memberId)) {
        throw new MembershipCancellationAdminError(
          LAST_FULL_ADMIN_GUARD_MESSAGE,
          409,
        );
      }

      // #2255 (D9): cancelling a member clears ONE level of links — their own
      // parent links, and every link pointing AT them. With chains of up to four
      // generations, the member being cancelled is often a MIDDLE generation, so
      // that sweep detaches their dependants from the family without touching
      // the grandparent above. Grandchildren are deliberately NOT re-parented
      // onto the grandparent: who is responsible for a child is a real-world
      // fact, and silently promoting it because someone left the club would
      // record a relationship nobody asserted. The defined outcome is instead
      // "detached and DECLARED" — captured here, before the sweep, and returned
      // to the caller so the admin sees exactly who was left without a parent
      // link or without a notification mailbox.
      orphanedByCancellation = await readFamilyLinkOrphans(
        tx,
        participant.memberId,
      );

      await tx.member.update({
        where: { id: participant.memberId },
        data: {
          active: false,
          canLogin: false,
          cancelledAt: now,
          cancelledReason: participant.request.reason,
          cancelledViaRequestId: participant.requestId,
          familyGroupId: null,
          // Billing-family removal sweep (#1932, E6): the member is leaving all
          // families in this transaction, so clear any billing-family selection.
          billingFamilyGroupId: null,
          parentMemberId: null,
          secondaryParentId: null,
          inheritEmailFromId: null,
        },
      });

      await Promise.all([
        tx.familyGroupMember.deleteMany({
          where: { memberId: participant.memberId },
        }),
        tx.member.updateMany({
          where: { parentMemberId: participant.memberId },
          data: { parentMemberId: null },
        }),
        tx.member.updateMany({
          where: { secondaryParentId: participant.memberId },
          data: { secondaryParentId: null },
        }),
        tx.member.updateMany({
          where: { inheritEmailFromId: participant.memberId },
          data: { inheritEmailFromId: null },
        }),
      ]);

      await tx.membershipCancellationRequestParticipant.update({
        where: { id: participant.id },
        data: {
          status: MembershipCancellationParticipantStatus.CANCELLED,
          adminNote: note,
          reviewedByMemberId: adminMemberId,
          reviewedAt: now,
          cancelledAt: now,
          confirmationTokenHash: null,
          confirmationTokenExpiresAt: null,
        },
      });

      await createAuditLog(
        {
          action: "membership_cancellation.participant_cancelled",
          memberId: adminMemberId,
          actorMemberId: adminMemberId,
          subjectMemberId: participant.memberId,
          targetId: participant.requestId,
          entityType: "MembershipCancellationRequest",
          entityId: participant.requestId,
          category: "account",
          severity: "important",
          outcome: "success",
          summary: "Membership cancellation participant approved",
          details: note,
          metadata: {
            participantId: participant.id,
            xeroCancellationDeferred: true,
            // #2255: the detached members are named in the audit as well as in
            // the response, so the record survives the admin closing the page.
            detachedDependantIds: orphanedByCancellation.dependants.map(
              (member) => member.id,
            ),
            detachedEmailInheritorIds:
              orphanedByCancellation.emailInheritors.map((member) => member.id),
            // #2400 (review F7): a cancellation that deliberately credits
            // NOTHING leaves no other durable trace on the member's own record —
            // the skip is recorded on a Xero sync-operation payload, which is
            // not where anyone looks a year later. Recorded here in the words
            // the reviewer was shown, with the invoice and the members it still
            // covers, so "why was there no credit note for the Smiths?" is
            // answerable from the audit trail.
            ...(sharedInvoiceNotice
              ? {
                  sharedInvoiceUncredited: {
                    invoiceId: sharedInvoiceNotice.invoiceId,
                    invoiceNumber: sharedInvoiceNotice.invoiceNumber,
                    sharedWithMemberIds: sharedInvoiceNotice.sharedWith.map(
                      (member) => member.memberId,
                    ),
                    route: sharedInvoiceNotice.route,
                    summary:
                      buildMembershipCancellationSharedInvoiceMessage(
                        sharedInvoiceNotice,
                      ),
                  },
                }
              : {}),
            ...notifyAuditFields,
          },
          ipAddress,
        },
        tx,
      );
    } else {
      await tx.membershipCancellationRequestParticipant.update({
        where: { id: participant.id },
        data: {
          status: MembershipCancellationParticipantStatus.REJECTED,
          adminNote: note,
          reviewedByMemberId: adminMemberId,
          reviewedAt: now,
          confirmationTokenHash: null,
          confirmationTokenExpiresAt: null,
        },
      });

      await createAuditLog(
        {
          action: "membership_cancellation.participant_rejected",
          memberId: adminMemberId,
          actorMemberId: adminMemberId,
          subjectMemberId: participant.memberId,
          targetId: participant.requestId,
          entityType: "MembershipCancellationRequest",
          entityId: participant.requestId,
          category: "account",
          severity: "important",
          outcome: "success",
          summary: "Membership cancellation participant rejected",
          details: note,
          metadata: { participantId: participant.id, ...notifyAuditFields },
          ipAddress,
        },
        tx,
      );
    }

    await updateRequestLifecycle(
      tx,
      participant.requestId,
      adminMemberId,
      now,
      note,
    );
  });

  if (action === "approve") {
    try {
      await queueApprovedMembershipCancellationXeroOperations({
        memberId: participant.memberId,
        requestId: participant.requestId,
        participantId: participant.id,
        createdByMemberId: adminMemberId,
      });
    } catch (err) {
      logger.error(
        { err, memberId: participant.memberId, requestId: participant.requestId },
        "Failed to queue Xero membership cancellation operations",
      );
    }
  }

  // #1787: send the member outcome email unless the admin chose not to notify
  // (default is notify; the suppression is audited above).
  if (notifyMember !== false) {
    await sendCancellationOutcomeEmail({
      action,
      member: participant.member,
      requestReason: participant.request.reason,
      adminNote: note,
    });
  }

  const updatedRequest = await getAdminRequestById(participant.requestId);
  if (!updatedRequest) {
    throw new MembershipCancellationAdminError(
      "Cancellation request could not be reloaded.",
      500,
    );
  }

  // #2402: the same "still awaiting approval" rule the queue page uses, so the
  // panel a reviewer sees after acting is built from exactly the same set as the
  // one they saw before — and the reload does not spend a Xero call on a
  // participant nobody can approve either. The viewer here is by definition an
  // approver: this function is only reachable through the review endpoint, which
  // requires `membership: edit`.
  const stillReviewableMemberIds = updatedRequest.participants
    .filter((item) =>
      isMembershipCancellationParticipantAwaitingApproval({
        requestStatus: updatedRequest.status,
        status: item.status,
        confirmedAt: item.confirmedAt,
        member: item.member,
      }),
    )
    .map((item) => item.memberId);
  // #2400: reloaded with the blockers, because approving one family member
  // changes the answer for the others — the one just cancelled no longer keeps
  // the shared invoice alive, so the next reviewer sees the notice disappear at
  // the moment the last leaver's approval would credit the invoice in full. Same
  // one-read-then-share shape as the queue page.
  const reloadedCreditPlansByMemberId =
    await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
      stillReviewableMemberIds,
    );
  const blockersByMemberId = await loadMembershipCancellationBlockersByMemberId(
    stillReviewableMemberIds,
    prisma,
    { creditPlansByMemberId: reloadedCreditPlansByMemberId },
  );
  const sharedInvoiceNoticesByMemberId =
    buildMembershipCancellationSharedInvoiceNotices(
      reloadedCreditPlansByMemberId,
      blockersByMemberId,
    );

  return {
    request: serializeRequest(updatedRequest, {
      blockersByMemberId,
      sharedInvoiceNoticesByMemberId,
      // Only an admin with `membership: edit` can reach this function at all.
      viewerCanApprove: true,
    }),
    // #2255: always present (empty arrays on reject, or when nothing was
    // linked), so a caller cannot mistake "no key" for "nothing detached".
    orphanedLinks: orphanedByCancellation,
  };
}
