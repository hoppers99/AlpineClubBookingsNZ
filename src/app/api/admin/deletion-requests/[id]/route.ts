/**
 * F-COMP-04: Admin — Approve or Reject a Deletion Request
 * POST /api/admin/deletion-requests/[id]
 * Body: { action: "approve" | "reject", note?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueHostingCoverageReevaluationForMember } from "@/lib/adult-member-hosting-review";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { getTodayDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { cancelBooking } from "@/lib/booking-cancel";
import { logAudit } from "@/lib/audit";
import {
  EMPTY_ORPHANED_FAMILY_LINKS,
  readFamilyLinkOrphans,
} from "@/lib/member-family-link-orphans";
import { isFullAdmin, memberHoldsPrivilegedRole } from "@/lib/access-roles";
import {
  AdminAccountGuardError,
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
  wouldRemoveLastFullAdmin,
} from "@/lib/admin-account-guards";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  sendAccountDeletionApprovedEmail,
  sendAccountDeletionRejectedEmail,
  sendAdminPartnerShareSweptAlert,
} from "@/lib/email";
import {
  acquireFuturePartnerSharedAllocationLocks,
  describePartnerSharedSweepReason,
  partnerShareSweepCounterpartNames,
  partnerShareSweepNights,
  sweepFuturePartnerSharedAllocationsWithLocksHeld,
  type SweptPartnerSharedAllocation,
} from "@/lib/bed-allocation-lifecycle";
import logger from "@/lib/logger";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import {
  claimDeletionRequestApproval,
  claimDeletionRequestDecision,
  DELETION_REQUEST_ALREADY_REVIEWED_CODE,
  DeletionRequestDecisionLostError,
} from "@/lib/deletion-request-decision";
import {
  assertNoMemberContactChangeBlockerForDeletion,
  DELETED_ACCOUNT_PASSWORD_HASH,
  lockMemberForAccountDeletionXeroFence,
  XERO_CONTACT_OPERATION_RESOLVE_REMEDY,
  XeroContactCreateBlocksDeletionError,
} from "@/lib/xero-contact-create-recovery";

const actionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
  // #1788: absent/undefined = notify (default), false = suppress the member
  // email. Only honoured on the REJECT path; the APPROVE path's final privacy
  // receipt (sendAccountDeletionApprovedEmail) always sends regardless. A
  // non-boolean value fails the parse below and returns 400.
  notifyMember: z.boolean().optional(),
});

const CANCELLABLE_DELETION_BOOKING_STATUSES = [
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
] as const;

function deletionCleanupRecovery(input: {
  cancelledBookings: number;
  cancellationPending: boolean;
  retryBookingId: string | null;
  cancellationStatusUnconfirmed?: boolean;
  cancellationPostProcessingUnconfirmed?: boolean;
  reviewBookingId?: string | null;
  blocker?: {
    code: string;
    message: string;
    remedy: string;
  };
}) {
  return {
    code: "DELETION_CLEANUP_PARTIAL",
    error:
      "Account deletion cleanup is incomplete. The member was not anonymised and no approval receipt was sent. Retry only the remaining cleanup.",
    cancelledBookings: input.cancelledBookings,
    cancellationPending: input.cancellationPending,
    retryBookingId: input.retryBookingId,
    ...(input.cancellationStatusUnconfirmed
      ? { cancellationStatusUnconfirmed: true }
      : {}),
    ...(input.cancellationPostProcessingUnconfirmed
      ? { cancellationPostProcessingUnconfirmed: true }
      : {}),
    ...(input.reviewBookingId
      ? { reviewBookingId: input.reviewBookingId }
      : {}),
    ...(input.blocker ? { blocker: input.blocker } : {}),
    remainingCleanupPending: true,
    memberAnonymised: false,
    memberDataAnonymised: false,
    approvalReceiptSent: false,
  };
}

function isMemberAnonymised(member: {
  firstName: string;
  lastName: string;
  email: string;
  active: boolean;
}): boolean {
  return (
    member.active === false &&
    member.firstName === "Deleted" &&
    member.lastName === "Member" &&
    member.email.startsWith("deleted-") &&
    member.email.endsWith("@deleted.invalid")
  );
}

async function readFinalDeletionDecision(
  requestId: string,
  cancelledBookings: number,
  decisionErrorCode: string,
) {
  try {
    const latest = await prisma.deletionRequest.findUnique({
      where: { id: requestId },
      select: {
        status: true,
        member: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            active: true,
          },
        },
      },
    });
    if (
      latest &&
      (latest.status === "APPROVED" || latest.status === "REJECTED")
    ) {
      const memberAnonymised = isMemberAnonymised(latest.member);
      return {
        code: decisionErrorCode,
        error:
          latest.status === "APPROVED"
            ? "Another administrator approved this deletion request. Reload the deletion queue to see the final state."
            : "Another administrator rejected this deletion request. Reload the deletion queue to see the final state.",
        decisionFinal: true as const,
        finalDecision: latest.status,
        cancelledBookings,
        memberAnonymised,
        memberDataAnonymised: memberAnonymised,
        retryAllowed: false as const,
      };
    }
  } catch (error) {
    logger.error(
      { err: error, requestId },
      "Could not re-read a deletion request after its decision claim was lost",
    );
  }

  return {
    code: "DELETION_REQUEST_DECISION_STATUS_UNCONFIRMED",
    error:
      "Another administrator claimed this deletion request, but its final state could not be confirmed. Reload the deletion queue; do not retry the deletion action.",
    decisionStatusUnconfirmed: true as const,
    cancelledBookings,
    retryAllowed: false as const,
  };
}

type CancellationFailureFact =
  | { state: "CANCELLED" }
  | { state: "PENDING" }
  | { state: "STATUS_UNCONFIRMED" };

async function recheckCancellationFailure(
  bookingId: string,
): Promise<CancellationFailureFact> {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { status: true },
    });
    if (booking?.status === "CANCELLED") {
      return { state: "CANCELLED" };
    }
    if (
      booking &&
      CANCELLABLE_DELETION_BOOKING_STATUSES.some(
        (status) => status === booking.status,
      )
    ) {
      return { state: "PENDING" };
    }
    return { state: "STATUS_UNCONFIRMED" };
  } catch (error) {
    logger.error(
      { err: error, bookingId },
      "Could not authoritatively recheck booking after deletion cleanup failure",
    );
    return { state: "STATUS_UNCONFIRMED" };
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  let body: { action: "approve" | "reject"; note?: string; notifyMember?: boolean };
  try {
    const raw = await request.json();
    body = actionSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  let completedBookingCancellations = 0;
  let memberAnonymised = false;

  try {
    const deletionRequest = await prisma.deletionRequest.findUnique({
      where: { id },
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
            financeAccessLevel: true,
            active: true,
            accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
          },
        },
      },
    });

    if (!deletionRequest) {
      return NextResponse.json({ error: "Deletion request not found" }, { status: 404 });
    }

    const approvalCanResume =
      body.action === "approve" &&
      deletionRequest.status === "APPROVAL_IN_PROGRESS";
    if (deletionRequest.status !== "PENDING" && !approvalCanResume) {
      return NextResponse.json(
        await readFinalDeletionDecision(
          id,
          completedBookingCancellations,
          DELETION_REQUEST_ALREADY_REVIEWED_CODE,
        ),
        { status: 409 }
      );
    }

    const member = deletionRequest.member;

    if (body.action === "reject") {
      await claimDeletionRequestDecision(prisma, {
        id,
        decision: "REJECTED",
        adminNote: body.note ?? null,
        reviewedBy: session.user.id,
      });

      // #1788 honesty rule — record the suppression in the audit ONLY on a path
      // that truly would have sent. The member is emailed unless they have no
      // address on file (member.email is a required field, so in practice this
      // is always present) or the admin opted out.
      const suppressedNotifyAudit =
        member.email && body.notifyMember === false
          ? { notifyMember: false }
          : undefined;

      logAudit({
        action: "member.deletion_rejected",
        memberId: session.user.id,
        targetId: member.id,
        details: body.note ? `Note: ${body.note}` : "No note",
        ipAddress: ip,
        ...(suppressedNotifyAudit ? { metadata: suppressedNotifyAudit } : {}),
      });

      // #1788: email the member unless the admin opted out (default = notify).
      if (body.notifyMember !== false) {
        sendAccountDeletionRejectedEmail(
          member.email,
          member.firstName,
          body.note ?? ""
        ).catch((err) =>
          logger.error({ err, memberId: member.id }, "Failed to send deletion rejected email")
        );
      }

      return NextResponse.json({ message: "Deletion request rejected." });
    }

    // --- APPROVE ---

    // Admin-account guards (issue #1604). Approving a deletion request
    // anonymises the member and sets active=false, so it is a deactivate of
    // the target. A member cannot self-request deletion while holding admin
    // access, but a request made before promotion could later target an
    // admin, so re-check at this execution point. Fail fast here (before any
    // booking cancellation) on the actor-permission and invariant; the
    // last-admin check is repeated inside the anonymise transaction below for
    // race-safety.
    if (!isFullAdmin(session.user) && memberHoldsPrivilegedRole(member)) {
      return NextResponse.json(
        { error: PRIVILEGED_TARGET_GUARD_MESSAGE },
        { status: 403 },
      );
    }
    if (await wouldRemoveLastFullAdmin(prisma, member.id)) {
      return NextResponse.json(
        { error: LAST_FULL_ADMIN_GUARD_MESSAGE },
        { status: 409 },
      );
    }

    // A Xero contact operation in flight blocks the anonymisation below, and
    // that check used to happen only inside the anonymise transaction — after
    // the loop had already cancelled every future booking. So an approval could
    // destroy a member's stays and then stop, for a condition that was knowable
    // before any of them was touched.
    //
    // Ask the same question here, unlocked, as a fail-fast alongside the other
    // guards. This is advisory only: the AUTHORITATIVE check is still
    // lockMemberForAccountDeletionXeroFence inside the anonymise transaction,
    // which holds the Member row through commit. It must stay there — hoisting
    // the LOCK to wrap the cancellation loop would hold a row lock across
    // separately committed transactions and provider work. A reservation that
    // starts between this check and that one is still caught, and the approval
    // is then recoverable rather than final (#2623 T1).
    try {
      await assertNoMemberContactChangeBlockerForDeletion(member.id, prisma);
    } catch (err) {
      if (err instanceof XeroContactCreateBlocksDeletionError) {
        return NextResponse.json(
          {
            error: err.message,
            code: err.code,
            // #2623 T7: name the operation and where the remedy lives, so the
            // refusal is actionable instead of an unexplained 409.
            ...(err.operationId
              ? {
                  xeroOperationId: err.operationId,
                  remedy: XERO_CONTACT_OPERATION_RESOLVE_REMEDY,
                }
              : {}),
          },
          { status: err.statusCode },
        );
      }
      throw err;
    }

    // checkIn is @db.Date (NZ calendar date at UTC midnight). Use the date-only
    // "today" rather than a raw instant so a stay checking in today still counts
    // as future for the whole NZ day, not just the first ~13h (F32, #1888).
    const today = getTodayDateOnly();

    // 1. Block approval while future paid stays still need financial/lodge follow-up.
    const futurePaidBookings = await prisma.booking.findMany({
      where: {
        memberId: member.id,
        status: "PAID",
        checkIn: { gte: today },
      },
      select: { id: true },
    });

    if (futurePaidBookings.length > 0) {
      const paidBookingIds = futurePaidBookings.map((booking) => booking.id);
      logger.warn(
        { memberId: member.id, paidBookingIds },
        "Blocked account deletion approval because future paid bookings remain active"
      );
      logAudit({
        action: "member.deletion_approval_blocked",
        memberId: session.user.id,
        targetId: member.id,
        details: `Future paid bookings must be resolved before anonymisation: ${paidBookingIds.join(", ")}`,
        ipAddress: ip,
        category: "privacy",
        severity: "important",
        outcome: "blocked",
      });

      return NextResponse.json(
        {
          error:
            "Account deletion cannot be approved while this member has future paid bookings. Cancel or refund the paid bookings first.",
          paidBookingIds,
        },
        { status: 409 }
      );
    }

    // 2. Cancel all future unpaid/hold bookings for the member.
    const futureBookings = await prisma.booking.findMany({
      where: {
        memberId: member.id,
        status: { in: [...CANCELLABLE_DELETION_BOOKING_STATUSES] },
        checkIn: { gte: today },
      },
      select: { id: true },
    });

    // The cleanup below commits one booking cancellation at a time. Own the
    // approval decision durably before the first such commit, so rejection can
    // only win while the request is still PENDING and no approval cleanup has
    // begun. A retry resumes this same intermediate claim.
    await claimDeletionRequestApproval(prisma, {
      id,
      adminNote: body.note ?? null,
      reviewedBy: session.user.id,
    });

    const cancelledBookingIds: string[] = [];
    for (const booking of futureBookings) {
      let result;
      try {
        result = await cancelBooking(
          booking.id,
          session.user.id,
          "ADMIN",
          ip,
        );
      } catch (err) {
        const cancellationFact = await recheckCancellationFailure(booking.id);
        if (
          cancellationFact.state === "CANCELLED" &&
          !cancelledBookingIds.includes(booking.id)
        ) {
          cancelledBookingIds.push(booking.id);
          completedBookingCancellations = cancelledBookingIds.length;
        }
        const recovery = deletionCleanupRecovery({
          cancelledBookings: cancelledBookingIds.length,
          cancellationPending: cancellationFact.state === "PENDING",
          retryBookingId:
            cancellationFact.state === "PENDING" ? booking.id : null,
          cancellationStatusUnconfirmed:
            cancellationFact.state === "STATUS_UNCONFIRMED",
          cancellationPostProcessingUnconfirmed:
            cancellationFact.state === "CANCELLED",
          reviewBookingId:
            cancellationFact.state === "PENDING" ? null : booking.id,
        });
        const hostingRetry = hostingCoverageParticipantRetryResponse(err, recovery);
        if (hostingRetry) return hostingRetry;
        logger.error(
          { err, memberId: member.id, bookingId: booking.id },
          "Account deletion cleanup stopped after a booking cancellation error",
        );
        return NextResponse.json(recovery, { status: 500 });
      }
      if (result.status === 200) {
        cancelledBookingIds.push(booking.id);
        completedBookingCancellations = cancelledBookingIds.length;
      } else {
        const cancellationFact = await recheckCancellationFailure(booking.id);
        if (cancellationFact.state === "CANCELLED") {
          if (!cancelledBookingIds.includes(booking.id)) {
            cancelledBookingIds.push(booking.id);
            completedBookingCancellations = cancelledBookingIds.length;
          }
          continue;
        }
        logger.warn(
          { bookingId: booking.id, memberId: member.id, result },
          "Failed to cancel booking during account deletion"
        );
        logAudit({
          action: "member.deletion_cleanup_failed",
          memberId: session.user.id,
          targetId: member.id,
          details: `Account deletion approval stopped; failed to cancel future booking: ${booking.id}`,
          ipAddress: ip,
          category: "privacy",
          severity: "critical",
          outcome: "failure",
        });
        return NextResponse.json(
          deletionCleanupRecovery({
            cancelledBookings: cancelledBookingIds.length,
            cancellationPending: cancellationFact.state === "PENDING",
            retryBookingId:
              cancellationFact.state === "PENDING" ? booking.id : null,
            cancellationStatusUnconfirmed:
              cancellationFact.state === "STATUS_UNCONFIRMED",
            reviewBookingId:
              cancellationFact.state === "PENDING" ? null : booking.id,
          }),
          { status: 409 },
        );
      }
    }

    // Capture the destination before anonymisation, but send only after commit.
    // A participant retry must not send a false approval receipt, and provider
    // calls must remain outside lifecycle/participant lock transactions.
    const approvalReceipt = { email: member.email, firstName: member.firstName };

    // 4-7: Anonymise atomically in a single transaction
    const anonymisedEmail = `deleted-${member.id.substring(0, 8)}@deleted.invalid`;
    let sweptShares: SweptPartnerSharedAllocation[] = [];
    // #2255: who was still pointed at this member when we anonymised them.
    let detachedFamilyLinks = EMPTY_ORPHANED_FAMILY_LINKS;
    await prisma.$transaction(async (tx) => {
      await acquireFuturePartnerSharedAllocationLocks(tx, [member.id]);
      await acquireMemberLifecycleLocks(tx, [member.id]);
      // Race-safe re-check of the last-admin invariant inside the mutation
      // transaction (issue #1604): the fail-fast check above ran before the
      // booking cleanup, so re-count against this transaction's read view.
      if (await wouldRemoveLastFullAdmin(tx, member.id)) {
        throw new AdminAccountGuardError(LAST_FULL_ADMIN_GUARD_MESSAGE);
      }

      // Final approval is deliberately inside the anonymisation transaction so
      // any later failure restores APPROVAL_IN_PROGRESS and sends no receipt.
      // Rejection cannot claim that intermediate state; a later approval may
      // safely resume only the remaining cleanup.
      await claimDeletionRequestDecision(tx, {
        id,
        decision: "APPROVED",
        adminNote: body.note ?? null,
        reviewedBy: session.user.id,
      });

      // #1756: anonymisation deactivates the member and unlinks their guest
      // rows, breaking the double-bed sharing precondition. Sweep their future
      // shared-double placements now, while bookingGuest.memberId (nulled in
      // step 5 below) still identifies them. Second-occupant appearances on
      // OTHER members' bookings survive the own-booking cancellation above, so
      // this is not vacuously empty.
      sweptShares = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
        memberId: member.id,
        reason: "member_deactivated",
        db: tx,
      });

      // Record the exact bounded fan-out before deactivation and guest unlinking
      // remove the evidence. It commits or rolls back with anonymisation.
      await enqueueHostingCoverageReevaluationForMember(member.id, tx, {
        cause: "SYSTEM_CHANGE",
        actorMemberId: session.user.id,
      });

      // The standing fan-out above holds this exact Member row FOR UPDATE.
      // Re-check the complete contact-create recovery set while that fence is
      // held so deletion cannot anonymise a member whose PII may already be in
      // flight to Xero or whose provider-created contact still needs linking.
      await lockMemberForAccountDeletionXeroFence(tx, member.id);

      // 3. Anonymise the member record
      await tx.member.update({
        where: { id: member.id },
        data: {
          firstName: "Deleted",
          lastName: "Member",
          email: anonymisedEmail,
          phoneCountryCode: null,
          phoneAreaCode: null,
          phoneNumber: null,
          dateOfBirth: null,
          streetAddressLine1: null,
          streetAddressLine2: null,
          streetCity: null,
          streetRegion: null,
          streetPostalCode: null,
          streetCountry: null,
          postalAddressLine1: null,
          postalAddressLine2: null,
          postalCity: null,
          postalRegion: null,
          postalPostalCode: null,
          postalCountry: null,
          passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
          active: false,
          // #2620: anonymisation used to leave every credential usable, so
          // `active: false` was the only thing between an erased member and a
          // working session — and Reactivate flips exactly that. Google sign-in
          // resolves on `googleSub` and never on email, so the placeholder
          // address stopped nothing. Clear the credentials themselves, so no
          // path that reaches `active` can produce a login. Dropping `canLogin`
          // also takes the row out of the partial unique index on (email) WHERE
          // canLogin, which removes the collision between two anonymised
          // members whose ids share the truncated prefix in `anonymisedEmail`.
          canLogin: false,
          googleSub: null,
          emailVerified: false,
          totpSecret: null,
          twoFactorEnabled: false,
          twoFactorMethod: null,
          twoFactorEnrolledAt: null,
          twoFactorFailedAttempts: 0,
          twoFactorLockedUntil: null,
          xeroContactId: null,
          inheritEmailFromId: null,
          // Billing-family removal sweep (#1932, E6): the member is leaving all
          // families here, so clear any billing-family selection they hold.
          billingFamilyGroupId: null,
        },
      });

      // #2620: the credentials cleared above are not the only ones. Every
      // outstanding token and second-factor artefact is independently sufficient
      // to authenticate, and deletion revoked none of them — a live magic link
      // or an unused recovery code still worked. Revoke them in the same commit,
      // so the erased account holds nothing that can be presented later.
      await Promise.all([
        tx.magicLinkToken.deleteMany({ where: { memberId: member.id } }),
        tx.passwordResetToken.deleteMany({ where: { memberId: member.id } }),
        tx.emailChangeToken.deleteMany({ where: { memberId: member.id } }),
        tx.twoFactorEmailCode.deleteMany({ where: { memberId: member.id } }),
        tx.twoFactorRecoveryCode.deleteMany({ where: { memberId: member.id } }),
        tx.twoFactorSessionChallenge.deleteMany({
          where: { memberId: member.id },
        }),
      ]);

      // The pointer and canonical ledger are one privacy boundary. A contact
      // update that completed before this transaction may have refreshed the
      // active link; deactivate it in the same commit that anonymises Member.
      await tx.xeroObjectLink.updateMany({
        where: {
          localModel: "Member",
          localId: member.id,
          xeroObjectType: "CONTACT",
          active: true,
        },
        data: { active: false },
      });

      // 4. Remove from all family groups
      await tx.familyGroupMember.deleteMany({
        where: { memberId: member.id },
      });

      // #2255: anonymisation nulled this member's OWN inheritance pointer but
      // left every pointer aimed AT them untouched, so their dependants — and,
      // at four generations, their grandchildren — kept resolving club email to
      // the `@deleted.invalid` address this route had just written. That is a
      // hard bounce on every send, forever, with nothing on any screen saying
      // so. The lifecycle paths (cancellation, archive) already sweep those
      // pointers; this one now does too, and names who it detached in the audit
      // rather than only counting them.
      //
      // The parent LINKS are deliberately left in place: anonymisation keeps
      // the member row for history, so the family structure is still true even
      // though the person's details are gone. It is only the mailbox that has
      // to stop being used.
      detachedFamilyLinks = await readFamilyLinkOrphans(tx, member.id);
      await tx.member.updateMany({
        where: { inheritEmailFromId: member.id },
        data: { inheritEmailFromId: null, inheritParentEmail: false },
      });

      // 5. Anonymise BookingGuest names for this member's guest appearances
      await tx.bookingGuest.updateMany({
        where: { memberId: member.id },
        data: {
          firstName: "Deleted",
          lastName: "Member",
          memberId: null,
        },
      });

    });
    memberAnonymised = true;

    try {
      await sendAccountDeletionApprovedEmail(
        approvalReceipt.email,
        approvalReceipt.firstName,
      );
    } catch (err) {
      logger.error({ err, memberId: member.id }, "Failed to send deletion approved email");
      // Continue — email failure should not undo the committed deletion.
    }
    await settleHostingCoverageAfterCommit({ limit: 25 });

    if (sweptShares.length > 0) {
      // Post-commit, fire-and-forget (#1756). Uses the pre-anonymisation name
      // captured above — admins keep an actionable reference, consistent with
      // the audit trail this route already retains.
      sendAdminPartnerShareSweptAlert({
        memberName: `${member.firstName} ${member.lastName}`.trim(),
        partnerName: partnerShareSweepCounterpartNames(sweptShares, member.id),
        reason: describePartnerSharedSweepReason("member_deactivated"),
        nights: partnerShareSweepNights(sweptShares),
      }).catch((alertErr) => {
        logger.error(
          { err: alertErr, memberId: member.id, sweptCount: sweptShares.length },
          "Failed to send partner share sweep alert"
        );
      });
    }

    logAudit({
      action: "member.deletion_approved",
      memberId: session.user.id,
      targetId: member.id,
      details: `Account anonymised. Cancelled ${cancelledBookingIds.length} future bookings.${body.note ? ` Note: ${body.note}` : ""}`,
      ipAddress: ip,
      metadata: {
        detachedEmailInheritorIds: detachedFamilyLinks.emailInheritors.map(
          (inheritor) => inheritor.id,
        ),
        dependantIds: detachedFamilyLinks.dependants.map(
          (dependant) => dependant.id,
        ),
      },
    });

    return NextResponse.json({
      message: "Account deletion approved. Member data has been anonymised.",
      cancelledBookings: cancelledBookingIds.length,
      orphanedLinks: detachedFamilyLinks,
    });
  } catch (err) {
    const recovery = deletionCleanupRecovery({
      cancelledBookings: completedBookingCancellations,
      cancellationPending: false,
      retryBookingId: null,
    });
    const hostingRetry = hostingCoverageParticipantRetryResponse(err, recovery);
    if (hostingRetry) return hostingRetry;
    if (err instanceof AdminAccountGuardError) {
      if (completedBookingCancellations > 0 && !memberAnonymised) {
        return NextResponse.json(
          deletionCleanupRecovery({
            cancelledBookings: completedBookingCancellations,
            cancellationPending: false,
            retryBookingId: null,
            blocker: {
              code: "LAST_FULL_ADMIN_GUARD",
              message: err.message,
              remedy:
                "Give another active account Full Admin access, then retry only the remaining deletion cleanup.",
            },
          }),
          { status: err.statusCode },
        );
      }
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }
    if (err instanceof DeletionRequestDecisionLostError) {
      return NextResponse.json(
        await readFinalDeletionDecision(
          id,
          completedBookingCancellations,
          err.code,
        ),
        { status: err.statusCode },
      );
    }
    if (err instanceof XeroContactCreateBlocksDeletionError) {
      const xeroRecovery = deletionCleanupRecovery({
        cancelledBookings: completedBookingCancellations,
        cancellationPending: false,
        retryBookingId: null,
        blocker: {
          code: err.code,
          message: err.message,
          remedy: `Wait for or resolve the current Xero contact operation${
            err.operationId ? ` (${err.operationId})` : ""
          } under Admin → Xero → Operations, then retry only the remaining deletion cleanup.`,
        },
      });
      return NextResponse.json(
        {
          ...xeroRecovery,
          code: err.code,
          error: err.message,
          ...(err.operationId ? { xeroOperationId: err.operationId } : {}),
        },
        { status: err.statusCode },
      );
    }
    logger.error({ err, requestId: id }, "Failed to process deletion request");
    if (completedBookingCancellations > 0 && !memberAnonymised) {
      return NextResponse.json(recovery, { status: 500 });
    }
    return NextResponse.json({ error: "Failed to process deletion request" }, { status: 500 });
  }
}
