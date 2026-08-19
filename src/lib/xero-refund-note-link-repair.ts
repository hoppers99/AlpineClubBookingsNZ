/**
 * Operator-reviewed repair for Stripe per-delta refund credit-note links that
 * the pre-#2901 canonical cleanup wrongly deactivated (and for the local
 * aftermath of cleaning up the Xero-side duplicate notes the resulting loop
 * created).
 *
 * What it does — LOCAL ledger rows only, never a provider call:
 *
 * - Reactivates inactive `Payment`/`REFUND_CREDIT_NOTE` links on
 *   `source: STRIPE` payments, oldest first, until the active covered cents
 *   equal the payment's `refundedAmountCents` EXACTLY (INV-ADDPAY-020). A link
 *   amount is read from its metadata, falling back to the persisted
 *   create-operation payload for legacy links, through the same shared helper
 *   the coverage sum uses (`recoverRefundCreditNoteLinkAmountCents`).
 * - Deactivates ACTIVE links whose inbound-merged Xero status is VOIDED or
 *   DELETED — the local mirror of a note the operator has already voided in
 *   Xero. It never voids or deletes anything in Xero itself.
 *
 * What it refuses, structurally:
 *
 * - Unrelated links: the query is scoped to `localModel: "Payment"`,
 *   `role: "REFUND_CREDIT_NOTE"`, `xeroObjectType: "CREDIT_NOTE"` and the
 *   payment's own id, so contact, invoice, account-credit and allocation links
 *   can never be touched.
 * - Foreign / non-Stripe payments: only `source: STRIPE` payments are scanned.
 * - Voided notes: a link whose merged metadata status is VOIDED/DELETED is
 *   never reactivated.
 * - Duplicates / over-coverage: the planner never lets planned coverage exceed
 *   `refundedAmountCents`, and a payment whose plan cannot land EXACTLY on the
 *   refunded total is reported for manual review and left untouched. (The
 *   unique link key also means one row per note per payment, so reactivation
 *   cannot mint a second active row for the same note.)
 *
 * Concurrency: no advisory lock — this composes no settlement-money or
 * capacity transition; it flips the local link mirror only. `applyEligible`
 * runs each payment in its own transaction, re-reads the payment and links
 * inside it, rebuilds the plan from that snapshot, and applies status-guarded
 * `updateMany` claims (`active: false -> true` / `active: true -> false`), so
 * a racing writer makes the claim match nothing rather than corrupt coverage.
 * The post-#2901 cleanup no longer touches these links, and every other
 * writer only ever ADDS active coverage, whose worst case (coverage above the
 * refunded total) enqueues nothing.
 *
 * Exposed to operators through `scripts/xero-refund-note-link-repair.ts`
 * (dry-run by default). The full operator runbook lives in
 * `docs/xero/ARCHITECTURE.md` → "Repairing Stripe refund-note links (#2901)".
 */
import { PaymentSource, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { asRecord, readString } from "@/lib/xero-json";
import { recoverRefundCreditNoteLinkAmountCents } from "@/lib/xero-sync";

/** Xero credit-note statuses that mean the document no longer counts. */
const CANCELLED_XERO_STATUSES = new Set(["VOIDED", "DELETED"]);

export type StripeRefundNoteLinkPlannedAction =
  | "keep-active"
  | "reactivate"
  | "deactivate-cancelled"
  | "leave-inactive";

export interface StripeRefundNoteLinkAssessment {
  linkId: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  active: boolean;
  /** Merged inbound `metadata.status` (e.g. AUTHORISED, VOIDED), if recorded. */
  xeroStatus: string | null;
  /** Recovered contribution in cents; null when neither metadata nor the create-operation payload carries one. */
  amountCents: number | null;
  createdAt: Date;
  plannedAction: StripeRefundNoteLinkPlannedAction;
  reason: string;
}

export interface StripeRefundNoteLinkRepairPlan {
  paymentId: string;
  bookingId: string;
  refundedAmountCents: number;
  /** Active covered cents exactly as `sumCoveredRefundCreditNoteCents` sees them today. */
  activeCoveredCents: number;
  /** Active covered cents after the planned actions. */
  plannedCoveredCents: number;
  repairable: boolean;
  /** Why the payment needs manual review instead, when not repairable. */
  manualReviewReason: string | null;
  links: StripeRefundNoteLinkAssessment[];
  reactivateLinkIds: string[];
  deactivateLinkIds: string[];
}

export interface StripeRefundNoteLinkRepairReport {
  generatedAt: Date;
  scannedPayments: number;
  /** Payments whose active coverage diverges from the refunded total (or that carry an active cancelled-note link). */
  plans: StripeRefundNoteLinkRepairPlan[];
}

export interface StripeRefundNoteLinkRepairApplyResult {
  report: StripeRefundNoteLinkRepairReport;
  appliedPayments: number;
  reactivatedLinks: number;
  deactivatedLinks: number;
  skippedPayments: Array<{ paymentId: string; reason: string }>;
}

interface AssessableLink {
  id: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  active: boolean;
  metadata: unknown;
  createdAt: Date;
}

function readLinkXeroStatus(metadata: unknown): string | null {
  const record = asRecord(metadata);
  const status = record ? readString(record.status) : null;
  return status ? status.toUpperCase() : null;
}

function isCancelledInXero(status: string | null): boolean {
  return status !== null && CANCELLED_XERO_STATUSES.has(status);
}

async function assessLinks(
  paymentId: string,
  links: AssessableLink[],
  db: Prisma.TransactionClient
): Promise<Array<AssessableLink & { xeroStatus: string | null; amountCents: number | null }>> {
  const assessed = [];
  for (const link of links) {
    assessed.push({
      ...link,
      xeroStatus: readLinkXeroStatus(link.metadata),
      amountCents: await recoverRefundCreditNoteLinkAmountCents(
        paymentId,
        link,
        db
      ),
    });
  }
  return assessed;
}

/**
 * Pure planner over an assessed snapshot. Deterministic: given the same
 * payment state it always produces the same plan, which is what lets apply
 * rebuild it inside the transaction and refuse when the state moved.
 */
function buildPlan(
  payment: { id: string; bookingId: string; refundedAmountCents: number },
  assessedLinks: Array<
    AssessableLink & { xeroStatus: string | null; amountCents: number | null }
  >
): StripeRefundNoteLinkRepairPlan {
  const ordered = [...assessedLinks].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id)
  );

  const assessments: StripeRefundNoteLinkAssessment[] = [];
  const reactivateLinkIds: string[] = [];
  const deactivateLinkIds: string[] = [];

  const activeCoveredCents = ordered
    .filter((link) => link.active)
    .reduce((sum, link) => sum + (link.amountCents ?? 0), 0);

  // Step 1: active links. A cancelled-in-Xero note contributes nothing in
  // Xero, so its local mirror is deactivated; every other active link is the
  // multi-delta contract and is kept.
  let baselineCents = 0;
  for (const link of ordered) {
    if (!link.active) {
      continue;
    }
    if (isCancelledInXero(link.xeroStatus)) {
      deactivateLinkIds.push(link.id);
      assessments.push({
        linkId: link.id,
        xeroObjectId: link.xeroObjectId,
        xeroObjectNumber: link.xeroObjectNumber,
        active: true,
        xeroStatus: link.xeroStatus,
        amountCents: link.amountCents,
        createdAt: link.createdAt,
        plannedAction: "deactivate-cancelled",
        reason: `The Xero note is ${link.xeroStatus}; its local mirror must not count as coverage.`,
      });
      continue;
    }
    baselineCents += link.amountCents ?? 0;
    assessments.push({
      linkId: link.id,
      xeroObjectId: link.xeroObjectId,
      xeroObjectNumber: link.xeroObjectNumber,
      active: true,
      xeroStatus: link.xeroStatus,
      amountCents: link.amountCents,
      createdAt: link.createdAt,
      plannedAction: "keep-active",
      reason: "Active per-delta coverage is kept (INV-ADDPAY-020).",
    });
  }

  // Step 2: inactive links, oldest first. Reactivate while doing so cannot
  // push coverage past the refunded total.
  let plannedCoveredCents = baselineCents;
  for (const link of ordered) {
    if (link.active) {
      continue;
    }
    let plannedAction: StripeRefundNoteLinkPlannedAction = "leave-inactive";
    let reason: string;
    if (isCancelledInXero(link.xeroStatus)) {
      reason = `The Xero note is ${link.xeroStatus}; a cancelled note is never reactivated.`;
    } else if (link.amountCents === null) {
      reason =
        "No amount is recoverable from the link metadata or the persisted create-operation payload.";
    } else if (link.amountCents <= 0) {
      reason = "The recovered amount is zero, so reactivation would add no coverage.";
    } else if (
      plannedCoveredCents + link.amountCents <=
      payment.refundedAmountCents
    ) {
      plannedAction = "reactivate";
      plannedCoveredCents += link.amountCents;
      reactivateLinkIds.push(link.id);
      reason = "Reactivated to restore the per-delta coverage this note settles.";
    } else {
      reason =
        "Reactivating this note would push coverage past the refunded total (a Xero-side duplicate to void manually).";
    }
    assessments.push({
      linkId: link.id,
      xeroObjectId: link.xeroObjectId,
      xeroObjectNumber: link.xeroObjectNumber,
      active: false,
      xeroStatus: link.xeroStatus,
      amountCents: link.amountCents,
      createdAt: link.createdAt,
      plannedAction,
      reason,
    });
  }

  let manualReviewReason: string | null = null;
  if (plannedCoveredCents > payment.refundedAmountCents) {
    manualReviewReason =
      "Active, non-voided coverage already exceeds the refunded total. Void the surplus notes in Xero, let inbound reconciliation record it, then re-run.";
  } else if (plannedCoveredCents < payment.refundedAmountCents) {
    manualReviewReason =
      "No combination of recoverable inactive notes lands exactly on the refunded total. Review the notes in Xero (voiding surplus duplicates there first), then re-run.";
  }

  const repairable =
    manualReviewReason === null &&
    (reactivateLinkIds.length > 0 || deactivateLinkIds.length > 0);

  return {
    paymentId: payment.id,
    bookingId: payment.bookingId,
    refundedAmountCents: payment.refundedAmountCents,
    activeCoveredCents,
    plannedCoveredCents,
    repairable,
    manualReviewReason,
    links: assessments,
    reactivateLinkIds,
    deactivateLinkIds,
  };
}

const LINK_SELECT = {
  id: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  active: true,
  metadata: true,
  createdAt: true,
} as const;

const REFUND_NOTE_LINK_WHERE = (paymentId: string) =>
  ({
    localModel: "Payment",
    localId: paymentId,
    xeroObjectType: "CREDIT_NOTE",
    role: "REFUND_CREDIT_NOTE",
  }) as const;

async function planForPayment(
  payment: { id: string; bookingId: string; refundedAmountCents: number },
  db: Prisma.TransactionClient
): Promise<StripeRefundNoteLinkRepairPlan> {
  const links = await db.xeroObjectLink.findMany({
    where: REFUND_NOTE_LINK_WHERE(payment.id),
    select: LINK_SELECT,
  });
  const assessed = await assessLinks(payment.id, links, db);
  return buildPlan(payment, assessed);
}

/**
 * True when this payment needs to appear in the operator report at all:
 * either the planner proposes actions, or coverage diverges from the refunded
 * total with nothing automatic to do about it.
 */
function planNeedsAttention(plan: StripeRefundNoteLinkRepairPlan): boolean {
  return (
    plan.repairable ||
    plan.manualReviewReason !== null ||
    plan.activeCoveredCents !== plan.refundedAmountCents
  );
}

/**
 * Dry run: assess every refunded Stripe payment (or the given ids) and report
 * the payments whose refund-note link coverage needs repair or review.
 * Read-only — writes nothing anywhere.
 */
export async function findStripeRefundNoteLinkRepairs(options?: {
  paymentIds?: string[];
}): Promise<StripeRefundNoteLinkRepairReport> {
  const payments = await prisma.payment.findMany({
    where: {
      source: PaymentSource.STRIPE,
      refundedAmountCents: { gt: 0 },
      ...(options?.paymentIds && options.paymentIds.length > 0
        ? { id: { in: options.paymentIds } }
        : {}),
    },
    select: {
      id: true,
      bookingId: true,
      refundedAmountCents: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const plans: StripeRefundNoteLinkRepairPlan[] = [];
  for (const payment of payments) {
    const plan = await planForPayment(payment, prisma);
    if (planNeedsAttention(plan)) {
      plans.push(plan);
    }
  }

  return {
    generatedAt: new Date(),
    scannedPayments: payments.length,
    plans,
  };
}

/**
 * Apply the repairable plans, each payment in its own transaction. The plan is
 * rebuilt from a fresh in-transaction snapshot and applied only when it is
 * still repairable and proposes the same link ids the dry run showed the
 * operator; anything that moved is skipped with a reason instead of applied.
 */
export async function applyStripeRefundNoteLinkRepairs(options?: {
  paymentIds?: string[];
}): Promise<StripeRefundNoteLinkRepairApplyResult> {
  const report = await findStripeRefundNoteLinkRepairs(options);

  let appliedPayments = 0;
  let reactivatedLinks = 0;
  let deactivatedLinks = 0;
  const skippedPayments: Array<{ paymentId: string; reason: string }> = [];

  for (const plan of report.plans) {
    if (!plan.repairable) {
      skippedPayments.push({
        paymentId: plan.paymentId,
        reason: plan.manualReviewReason ?? "Nothing automatic to apply.",
      });
      continue;
    }

    const outcome = await prisma.$transaction(async (tx) => {
      // Re-read the payment and links inside the transaction and rebuild the
      // plan from that snapshot: the guarded updates below only ever run
      // against state the planner has just seen.
      const payment = await tx.payment.findUnique({
        where: { id: plan.paymentId },
        select: {
          id: true,
          bookingId: true,
          source: true,
          refundedAmountCents: true,
        },
      });
      if (!payment || payment.source !== PaymentSource.STRIPE) {
        return { skipped: "The payment no longer exists or is not Stripe-sourced." };
      }
      const freshPlan = await planForPayment(payment, tx);
      if (!freshPlan.repairable) {
        return {
          skipped:
            freshPlan.manualReviewReason ??
            "The payment's link state changed and is no longer automatically repairable.",
        };
      }
      const sameSets =
        freshPlan.reactivateLinkIds.join(",") === plan.reactivateLinkIds.join(",") &&
        freshPlan.deactivateLinkIds.join(",") === plan.deactivateLinkIds.join(",");
      if (!sameSets) {
        return {
          skipped:
            "The payment's link state changed since the dry-run plan; re-run the dry run and review again.",
        };
      }

      // Status-guarded claims: a row a concurrent writer already flipped
      // matches nothing.
      let reactivated = 0;
      if (freshPlan.reactivateLinkIds.length > 0) {
        const result = await tx.xeroObjectLink.updateMany({
          where: {
            id: { in: freshPlan.reactivateLinkIds },
            ...REFUND_NOTE_LINK_WHERE(payment.id),
            active: false,
          },
          data: { active: true },
        });
        reactivated = result.count;
      }
      let deactivated = 0;
      if (freshPlan.deactivateLinkIds.length > 0) {
        const result = await tx.xeroObjectLink.updateMany({
          where: {
            id: { in: freshPlan.deactivateLinkIds },
            ...REFUND_NOTE_LINK_WHERE(payment.id),
            active: true,
          },
          data: { active: false },
        });
        deactivated = result.count;
      }
      return { reactivated, deactivated };
    });

    if ("skipped" in outcome) {
      skippedPayments.push({ paymentId: plan.paymentId, reason: outcome.skipped });
      continue;
    }

    appliedPayments += 1;
    reactivatedLinks += outcome.reactivated;
    deactivatedLinks += outcome.deactivated;
    logger.info(
      {
        paymentId: plan.paymentId,
        reactivatedLinks: outcome.reactivated,
        deactivatedLinks: outcome.deactivated,
        refundedAmountCents: plan.refundedAmountCents,
      },
      "Repaired Stripe refund credit-note link coverage (#2901)"
    );
  }

  return {
    report,
    appliedPayments,
    reactivatedLinks,
    deactivatedLinks,
    skippedPayments,
  };
}

function formatCents(cents: number | null): string {
  if (cents === null) {
    return "unknown";
  }
  return `${(cents / 100).toFixed(2)}`;
}

/** Plain-text report for the operator script. */
export function formatStripeRefundNoteLinkRepairReport(
  report: StripeRefundNoteLinkRepairReport
): string {
  const lines: string[] = [
    `Scanned ${report.scannedPayments} refunded Stripe payment(s); ${report.plans.length} need repair or review.`,
  ];
  for (const plan of report.plans) {
    lines.push("");
    lines.push(
      `Payment ${plan.paymentId} (booking ${plan.bookingId}): refunded ${formatCents(plan.refundedAmountCents)}, active coverage ${formatCents(plan.activeCoveredCents)}, planned coverage ${formatCents(plan.plannedCoveredCents)} — ${
        plan.repairable
          ? "REPAIRABLE"
          : `MANUAL REVIEW: ${plan.manualReviewReason ?? "see links"}`
      }`
    );
    for (const link of plan.links) {
      lines.push(
        `  [${link.plannedAction}] note ${link.xeroObjectNumber ?? link.xeroObjectId} (${
          link.active ? "active" : "inactive"
        }${link.xeroStatus ? `, ${link.xeroStatus}` : ""}, ${formatCents(link.amountCents)}) — ${link.reason}`
      );
    }
  }
  return lines.join("\n");
}
