import "server-only";

import type { SubscriptionStatus } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { sendMembershipPaymentRecordedEmail } from "@/lib/email/membership";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * E14 (#1944): audited manual mark-paid / mark-unpaid for a member subscription,
 * for clubs that do not use the Xero invoicing pipeline (or one-off cash
 * payments). This NEVER calls Xero and NEVER creates or voids an invoice — it
 * only writes the local MemberSubscription status plus provenance columns and an
 * audit-log entry recording the acting admin.
 *
 * Marking paid sets status = PAID with provenance (manuallyMarkedPaidAt / by /
 * note). A manually marked-paid member is then paid-up everywhere the app keys
 * off status === "PAID" (booking, nomination, member subscription status).
 *
 * Semantics (#1944 owner decision): manual mark-paid exists for cash payments
 * where NO Xero invoice exists. A subscription that carries a Xero invoice link
 * must be settled in Xero (record the payment against the invoice), so
 * direction "paid" is rejected with 409 when xeroInvoiceId is set, and a
 * NOT_REQUIRED row has nothing to pay so it is rejected too.
 *
 * Marking unpaid (reversal) is only permitted on a row this feature marked paid;
 * it restores the appropriate unpaid status — UNPAID when a Xero invoice link
 * still exists (the invoice is outstanding), NOT_INVOICED otherwise — and clears
 * the provenance columns.
 *
 * Both writes are status-fenced (conditional updateMany, 409 when no row
 * matches) so two admins clicking concurrently — or a Xero sync landing between
 * read and write — can never double-apply or clobber each other.
 *
 * #2260: marking paid now offers the club's standard "email the member or not"
 * choice. The choice is REQUIRED on the paid path (a discriminated union, so
 * omitting it is a compile error) and recorded in the audit entry either way.
 * Marking unpaid emails nobody — there is no reversal notice — so the union
 * forbids passing the flag at all on that path.
 */
export class ManualSubscriptionPaymentError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ManualSubscriptionPaymentError";
    this.status = status;
  }
}

export const MANUAL_PAYMENT_NOTE_MAX = 500;

export type ManualPaymentDirection = "paid" | "unpaid";

export type ManualSubscriptionPaymentResult = {
  id: string;
  memberId: string;
  seasonYear: number;
  status: SubscriptionStatus;
  direction: ManualPaymentDirection;
  /**
   * The admin's email decision as recorded in the audit log. Always false on
   * the unpaid path (no reversal notice exists). On the paid path it is the
   * decision, not a delivery receipt — a later send failure is retried and
   * alerted by the email layer, never by silently rewriting this.
   */
  memberNotified: boolean;
};

/**
 * Discriminated on `direction` so the "email the member or not" choice cannot
 * be left implicit: marking paid must state `notifyMember`, and marking unpaid
 * cannot pass it at all (nothing is ever emailed on a reversal).
 */
export type ApplyManualSubscriptionPaymentInput =
  | {
      subscriptionId: string;
      direction: "paid";
      note?: string | null;
      actingMemberId: string;
      notifyMember: boolean;
    }
  | {
      subscriptionId: string;
      direction: "unpaid";
      note?: string | null;
      actingMemberId: string;
      notifyMember?: never;
    };

export async function applyManualSubscriptionPayment(
  input: ApplyManualSubscriptionPaymentInput,
): Promise<ManualSubscriptionPaymentResult> {
  const trimmedNote = input.note?.trim() ? input.note.trim() : null;
  const note = trimmedNote ? trimmedNote.slice(0, MANUAL_PAYMENT_NOTE_MAX) : null;
  const notifyMember = input.direction === "paid" && input.notifyMember;

  // The write commits first; the member email is dispatched afterwards, never
  // inside the transaction (no provider call inside a database transaction).
  const { result, recipient } = await prisma.$transaction(async (tx) => {
    const subscription = await tx.memberSubscription.findUnique({
      where: { id: input.subscriptionId },
      select: {
        id: true,
        memberId: true,
        seasonYear: true,
        status: true,
        xeroInvoiceId: true,
        manuallyMarkedPaidAt: true,
        member: { select: { firstName: true, email: true } },
        // #2260: the only amount this app can honestly put on a manual-payment
        // receipt. A manual payment is cash the app never saw, so the figure
        // comes from the frozen charge snapshot of the season's ACTIVE coverage
        // claim (releasedAt IS NULL) when there is one — never from a guess.
        chargeCoverage: {
          where: { releasedAt: null },
          select: { charge: { select: { chargedAmountCents: true } } },
          take: 1,
        },
      },
    });
    if (!subscription) {
      throw new ManualSubscriptionPaymentError("Subscription not found", 404);
    }

    if (input.direction === "paid") {
      // Never overwrite a PAID status the Xero pipeline (or a prior manual
      // action) already owns.
      if (subscription.status === "PAID") {
        throw new ManualSubscriptionPaymentError(
          "This subscription is already marked paid.",
          409,
        );
      }
      // Owner-decided semantics (#1944): manual mark-paid is for cash payments
      // where no Xero invoice exists. Once an invoice links, Xero owns the
      // money state — recording the payment here would leave the invoice
      // outstanding in Xero and the two systems permanently disagreeing.
      if (subscription.xeroInvoiceId) {
        throw new ManualSubscriptionPaymentError(
          "This subscription has an outstanding Xero invoice — record the payment against the invoice in Xero instead.",
          409,
        );
      }
      // A NOT_REQUIRED row has nothing to pay, and marking it paid would lose
      // the policy-derived status with no way to restore it on reversal.
      if (subscription.status === "NOT_REQUIRED") {
        throw new ManualSubscriptionPaymentError(
          "This subscription is not required for this member — there is nothing to mark paid.",
          409,
        );
      }
      const now = new Date();
      // Status-fenced write: re-assert every guard inside the WHERE so a
      // concurrent second click, manual mark-paid, or Xero sync between the
      // read above and this write cannot double-apply or clobber (F4).
      const fenced = await tx.memberSubscription.updateMany({
        where: {
          id: subscription.id,
          status: { notIn: ["PAID", "NOT_REQUIRED"] },
          xeroInvoiceId: null,
          manuallyMarkedPaidAt: null,
        },
        data: {
          status: "PAID",
          paidAt: now,
          manuallyMarkedPaidAt: now,
          manuallyMarkedPaidByMemberId: input.actingMemberId,
          manualPaymentNote: note,
        },
      });
      if (fenced.count === 0) {
        throw new ManualSubscriptionPaymentError(
          "This subscription changed while you were marking it paid — refresh and try again.",
          409,
        );
      }
      const updated = await tx.memberSubscription.findUniqueOrThrow({
        where: { id: subscription.id },
        select: { id: true, memberId: true, seasonYear: true, status: true },
      });
      await createAuditLog(
        {
          action: "membership-subscription.manual-payment.mark-paid",
          memberId: input.actingMemberId,
          actorMemberId: input.actingMemberId,
          subjectMemberId: subscription.memberId,
          targetId: subscription.id,
          entityType: "MemberSubscription",
          entityId: subscription.id,
          category: "payment",
          severity: "important",
          outcome: "success",
          summary: "Membership subscription manually marked paid",
          details: note,
          metadata: {
            subscriptionId: subscription.id,
            memberId: subscription.memberId,
            seasonYear: subscription.seasonYear,
            previousStatus: subscription.status,
            hasXeroInvoiceLink: Boolean(subscription.xeroInvoiceId),
            // #2260 honesty rule: the admin's email choice is an explicit
            // per-action decision, so record it BOTH ways — a reader of the log
            // must be able to tell "chose not to email" from "the feature never
            // offered a choice", which an only-on-decline record cannot express.
            notifyMember,
          },
        },
        tx,
      );
      // The receipt needs the amount and the recipient read before commit;
      // the send itself happens after the transaction returns.
      const amountCents =
        subscription.chargeCoverage?.[0]?.charge.chargedAmountCents ?? null;
      return {
        result: {
          ...updated,
          direction: "paid" as const,
          memberNotified: notifyMember,
        },
        recipient:
          notifyMember && subscription.member?.email
            ? {
                email: subscription.member.email,
                firstName: subscription.member.firstName,
                seasonYear: subscription.seasonYear,
                // The receipt states the moment the payment was recorded — the
                // same timestamp written to manuallyMarkedPaidAt/paidAt, not a
                // second clock read after the transaction.
                recordedAt: now,
                // A no-invoice (zero-cent) fee carries no amount worth
                // printing, so it is reported as "unknown" and the receipt
                // simply omits the line.
                amountCents:
                  amountCents !== null && amountCents > 0 ? amountCents : null,
              }
            : null,
      };
    }

    // direction === "unpaid": reversal, only on a row this feature marked paid.
    if (!subscription.manuallyMarkedPaidAt) {
      throw new ManualSubscriptionPaymentError(
        "Only a manually marked-paid subscription can be reversed here.",
        409,
      );
    }
    const restoredStatus: SubscriptionStatus = subscription.xeroInvoiceId
      ? "UNPAID"
      : "NOT_INVOICED";
    // Status-fenced write (F4): only a row still carrying manual provenance can
    // be reversed, so a concurrent reversal / Xero sync that already cleared it
    // 409s instead of silently re-applying.
    const fenced = await tx.memberSubscription.updateMany({
      where: {
        id: subscription.id,
        manuallyMarkedPaidAt: { not: null },
      },
      data: {
        status: restoredStatus,
        paidAt: null,
        manuallyMarkedPaidAt: null,
        manuallyMarkedPaidByMemberId: null,
        manualPaymentNote: null,
      },
    });
    if (fenced.count === 0) {
      throw new ManualSubscriptionPaymentError(
        "This subscription changed while you were reversing the manual payment — refresh and try again.",
        409,
      );
    }
    const updated = await tx.memberSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
      select: { id: true, memberId: true, seasonYear: true, status: true },
    });
    await createAuditLog(
      {
        action: "membership-subscription.manual-payment.mark-unpaid",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: subscription.memberId,
        targetId: subscription.id,
        entityType: "MemberSubscription",
        entityId: subscription.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "Manual membership subscription payment reversed",
        details: note,
        metadata: {
          subscriptionId: subscription.id,
          memberId: subscription.memberId,
          seasonYear: subscription.seasonYear,
          previousStatus: subscription.status,
          restoredStatus,
          hasXeroInvoiceLink: Boolean(subscription.xeroInvoiceId),
          // #2260: a reversal never emails the member — there is no
          // "your payment was un-recorded" notice, and inventing one would be
          // worse than silence. Pinned in the log so the absence is a decision.
          notifyMember: false,
        },
      },
      tx,
    );
    return {
      result: {
        ...updated,
        direction: "unpaid" as const,
        memberNotified: false,
      },
      recipient: null,
    };
  });

  // #2260: dispatched only on the paid path, and only when the admin chose it.
  // A send failure must never undo or 500 the committed money state — the email
  // layer already logs, retries and alerts on its own failures.
  if (recipient) {
    try {
      await sendMembershipPaymentRecordedEmail({
        email: recipient.email,
        firstName: recipient.firstName,
        seasonYear: recipient.seasonYear,
        amountCents: recipient.amountCents,
        recordedAt: recipient.recordedAt,
      });
    } catch (error) {
      logger.error(
        { err: error, subscriptionId: input.subscriptionId },
        "Manual subscription payment recorded, but the member receipt failed to send",
      );
    }
  }

  return result;
}
