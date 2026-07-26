import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

/**
 * Server-side setter for the per-booking "No emails" switch (#2258).
 *
 * Kept out of `booking-email-suppression.ts` on purpose: that module is imported
 * by the mailer itself, and the mailer has no business pulling in the audit
 * writer. The read path (the gate) and the write path (this) stay separate.
 *
 * Owner decision D10 makes the acknowledgement mandatory, not advisory: turning
 * the switch ON requires the caller to state that it understood the consequence.
 * That is enforced HERE as well as at the API boundary, so no future caller can
 * enable the switch without one.
 */

export type SetBookingNoEmailsResult =
  | {
      ok: true;
      noEmails: boolean;
      noEmailsAt: Date | null;
      noEmailsByMemberId: string | null;
      changed: boolean;
    }
  | { ok: false; status: 400 | 404; error: string };

export async function setBookingNoEmails(params: {
  bookingId: string;
  noEmails: boolean;
  // Required to ENABLE. Ignored when clearing: turning mail back on needs no
  // acknowledgement, and a stuck switch must always be clearable.
  acknowledged: boolean;
  actorMemberId: string;
  // Matches the nullable shape getAuditRequestContext() returns, so a route can
  // hand it straight through.
  auditRequest?: {
    id?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
}): Promise<SetBookingNoEmailsResult> {
  if (params.noEmails && params.acknowledged !== true) {
    return {
      ok: false,
      status: 400,
      error:
        'Turning off all emails for a booking requires an explicit acknowledgement that the member will not be told about confirmations, changes, payments, reminders or cancellations.',
    };
  }

  return prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<SetBookingNoEmailsResult> => {
      const booking = await tx.booking.findUnique({
        where: { id: params.bookingId },
        select: {
          id: true,
          memberId: true,
          status: true,
          deletedAt: true,
          noEmails: true,
          noEmailsAt: true,
          noEmailsByMemberId: true,
        },
      });
      if (!booking || booking.deletedAt) {
        return { ok: false, status: 404, error: "Booking not found" };
      }

      // Idempotent: setting the switch to the value it already has is a no-op
      // that reports success without rewriting the audit columns, so the
      // "who turned this on, and when" record is never overwritten by a repeat
      // click or a retried request.
      if (booking.noEmails === params.noEmails) {
        return {
          ok: true,
          noEmails: booking.noEmails,
          noEmailsAt: booking.noEmailsAt,
          noEmailsByMemberId: booking.noEmailsByMemberId,
          changed: false,
        };
      }

      const setAt = new Date();
      await tx.booking.update({
        where: { id: booking.id },
        data: params.noEmails
          ? {
              noEmails: true,
              noEmailsAt: setAt,
              noEmailsByMemberId: params.actorMemberId,
            }
          : {
              noEmails: false,
              noEmailsAt: null,
              noEmailsByMemberId: null,
            },
      });

      await createAuditLog(
        {
          action: params.noEmails
            ? "booking.noEmails.set"
            : "booking.noEmails.cleared",
          memberId: params.actorMemberId,
          actorMemberId: params.actorMemberId,
          subjectMemberId: booking.memberId,
          targetId: booking.id,
          entityType: "Booking",
          entityId: booking.id,
          category: "booking",
          severity: "important",
          outcome: "success",
          summary: params.noEmails
            ? "No emails turned on for a booking"
            : "No emails turned off for a booking",
          details: params.noEmails
            ? "Admin turned off every member-facing email for this booking: confirmations, changes, payments, reminders, arrival information, cancellations, waitlist offers, chore rosters and the Xero invoice email are all withheld until it is turned back on."
            : "Admin turned member-facing emails back on for this booking. Messages withheld while the switch was on are not re-sent.",
          metadata: {
            bookingStatus: booking.status,
            noEmails: params.noEmails,
            acknowledged: params.noEmails ? true : null,
            ...(params.noEmails
              ? {}
              : {
                  previouslySetAt: booking.noEmailsAt?.toISOString() ?? null,
                  previouslySetByMemberId: booking.noEmailsByMemberId,
                }),
          },
          requestId: params.auditRequest?.id,
          ipAddress: params.auditRequest?.ipAddress,
          userAgent: params.auditRequest?.userAgent,
        },
        tx,
      );

      return {
        ok: true,
        noEmails: params.noEmails,
        noEmailsAt: params.noEmails ? setAt : null,
        noEmailsByMemberId: params.noEmails ? params.actorMemberId : null,
        changed: true,
      };
    },
  );
}
