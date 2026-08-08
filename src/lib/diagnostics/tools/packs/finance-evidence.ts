/**
 * AI Diagnostics — AID-6C finance pack, part 3: THE AUTHORITATIVE BOOKING-FINANCE
 * CALCULATION (#2377, epic #2369).
 *
 * ONE `server_owned` evidence source, and the entry that reads it lives in
 * `finance-state.ts`. This module is the source itself.
 *
 * WHY THIS IS NOT A `select_only_sql` ENTRY, which is the question a reviewer
 * should ask first and which #2375 answers as a rule rather than a preference:
 * "Do not ask the model to infer finance state from raw rows where the
 * application already has authoritative services or stable reason codes. Reuse or
 * safely expose authoritative results." Every number and every classification
 * below already has exactly one definition in this codebase, and re-deriving any
 * of them in SQL would create a SECOND definition that can drift from the admin
 * screen a Finance Officer trusts:
 *
 *  - `deriveBookingAppliedCreditCents` (`member-credit.ts`) is the ledger truth of
 *    account credit applied to a booking. It is a signed aggregate over
 *    `MemberCredit` rows of type `BOOKING_APPLIED`, negated and floored at zero —
 *    NOT the denormalised `Payment."creditAppliedCents"` column. This module
 *    reports both, and their difference, precisely because they can disagree.
 *  - `getMemberCreditBalance` (`member-credit.ts`) is the one function every write
 *    path validates against before spending credit.
 *  - `hasCapturedPayment` and `getRemainingRefundableCents`
 *    (`booking-payment-state.ts`) decide whether money actually moved and how
 *    much of it can still be handed back. The refund-appeal review route uses the
 *    same two.
 *  - `getPaymentDisplayStatus` (`payment-status-display.ts`) is the label the
 *    admin screens render — "Paid", "Credit Issued + Card Refund", "Cancelled
 *    Before Payment". A diagnostic that invented its own vocabulary would send an
 *    operator looking for a state the UI never shows.
 *  - `deriveSettlementKind` and `deriveXeroState` (`admin-operational-state.ts`)
 *    are the stable classifications behind the `/admin/payments` filters. A
 *    diagnostic answer and the screen the operator then opens have to agree about
 *    what "invoice missing" means.
 *
 * A `server_owned` entry is NOT a way around the substrate's gates: registry
 * lookup, loop budget, fresh AND-ed authorization, `.strict()` argument parsing
 * with the reserved-key scan, the metering breaker, the fixed projection with
 * redaction and per-field caps, the row and byte ceilings, truncation honesty and
 * the approved-metadata audit row all apply identically. The only gate it skips is
 * the SELECT-only credential check, which does not govern it.
 *
 * WHAT THAT COSTS, STATED PLAINLY, because AID-6A's pack doc requires it of any
 * server-owned source. This one queries application tables on the application's
 * own FULL-PRIVILEGE Prisma connection, so unlike the SQL entries there is no
 * column grant behind it and the registry projection in `finance-state.ts` is the
 * ONLY boundary. Nothing leaks today — the row this source returns is built field
 * by field from named columns, and it never selects a note, a reason, a payload or
 * a person — but that makes every edit to this file or to that projection a
 * security-relevant change that needs the review a grant would get. Two specific
 * columns sit one `select` away and must never be added: `MemberCredit.description`
 * (free text, and it is READ here to classify the settlement — see
 * `readCancellationCredits` — but never returned) and
 * `Payment."manualPaymentNote"`.
 *
 * READ ONLY, AND NO PROVIDER. Every call below is a Prisma `findUnique`,
 * `findMany` or `aggregate`. There is no write, no transaction, no Stripe call, no
 * Xero call and no HTTP request of any kind. The two authoritative helpers that
 * are async are read-only aggregates over `MemberCredit`.
 *
 * MONEY IS INTEGER CENTS THROUGHOUT. Every value here is an `Int` column or a sum
 * of them. There is no division, no fixed-point rounding, no floating-point
 * parsing and no currency formatting in this module — a contract test scans this
 * file's source for all four.
 */

import "server-only";

import {
  deriveSettlementKind,
  deriveXeroState,
  emptyXeroActivitySummary,
  type XeroActivitySummary,
} from "@/lib/admin-operational-state";
import {
  getRemainingRefundableCents,
  hasCapturedPayment,
  isSettledBookingStatus,
} from "@/lib/booking-payment-state";
import { formatBookingReference } from "@/lib/booking-reference";
import {
  deriveBookingAppliedCreditCents,
  getMemberCreditBalance,
} from "@/lib/member-credit";
import { getPaymentDisplayStatus } from "@/lib/payment-status-display";
import { prisma } from "@/lib/prisma";

import type { DiagnosticsToolRawRow } from "../define";

/**
 * This source's OWN deadline, below the executor's 15-second wait.
 *
 * The executor's `Promise.race` does not cancel the loser and nothing propagates
 * a cancellation into Prisma, so a source that can be slow has to bound its own
 * WORK. This one's fan-out is constant — six point reads and aggregates, all on
 * indexed columns, for exactly one booking — so the deadline is a backstop for a
 * database that has stopped answering rather than for a query that is doing too
 * much. It REFUSES rather than returning a partial row: a finance state assembled
 * from some of its inputs would be a fabricated answer, not an absent one, and
 * `evidence_unavailable` is the honest outcome.
 */
const BOOKING_FINANCE_DEADLINE_MS = 10_000;

/**
 * The maximum attempts the payment-recovery cron makes before a `FAILED`
 * operation is terminal. Mirrors `MAX_PAYMENT_RECOVERY_ATTEMPTS` in
 * `payment-recovery-constants.ts`; kept as a local constant so this module does
 * not drag the recovery module's Stripe imports into the diagnostics graph, and
 * pinned by a test against the real constant so the two cannot drift.
 */
export const FINANCE_RECOVERY_ATTEMPT_CEILING = 5;

/**
 * The stable blocker codes this source can emit, in the PRIORITY ORDER an
 * operator should act on them.
 *
 * A closed, ordered, server-owned catalogue is what #2377 asks for in place of
 * asking a model to read a blocker out of raw columns. The order is the whole
 * point: several of these can be true at once, and telling a Finance Officer that
 * "the Xero invoice is missing" when the real problem is that a refund the
 * platform owes has exhausted its retries sends them to the wrong screen. So the
 * projection reports the FIRST code in this order as the primary blocker and the
 * full list beside it.
 *
 * `none` is not in this list: an empty list IS "nothing is blocking", and a code
 * meaning "no code" would let a caller treat the healthy case as a finding.
 */
export const FINANCE_BLOCKER_CODES = [
  /** The booking has no payment record at all — nothing can settle. */
  "payment_record_missing",
  /**
   * A refund this platform undertook to execute has FAILED at the attempt
   * ceiling. It will never retry on its own. This is the most urgent state in the
   * pack: a member is owed money and nothing automatic will move it.
   */
  "refund_execution_exhausted",
  /** A refund is queued but has not executed yet. The money has NOT moved. */
  "refund_execution_pending",
  /** Money must be handed back by a human — there is no card to refund. */
  "manual_refund_open",
  /** A member asked for a refund and nobody has decided. */
  "refund_appeal_pending",
  /** A Xero sync operation for this booking or payment failed. */
  "xero_operation_failed",
  /** A Xero sync operation partially completed. */
  "xero_operation_partial",
  /** A Xero sync operation is still queued or running. */
  "xero_operation_pending",
  /** The booking has reached a settled status but has no Xero invoice linked. */
  "xero_invoice_missing",
  /** An upward modification was never collected. */
  "additional_payment_outstanding",
  /** The payment attempt failed at the provider. */
  "payment_failed",
  /** A charge is in flight and unconfirmed. */
  "payment_processing",
  /** No charge has been attempted or captured yet. */
  "payment_pending",
  /**
   * The stored ledger identity does not hold:
   * `amountCents + creditAppliedCents + uncollectedAdditionalCents` is not
   * `finalPriceCents`. An integer-cent discrepancy that no other code explains.
   */
  "ledger_variance",
  /**
   * The denormalised `Payment."creditAppliedCents"` disagrees with the
   * `MemberCredit` ledger. One of the two is wrong and a human has to say which.
   */
  "credit_ledger_variance",
] as const;

export type FinanceBlockerCode = (typeof FINANCE_BLOCKER_CODES)[number];

/**
 * The raw row this source hands the executor. Every field is a flat scalar
 * already — a `Date` is not one, so the instants are formatted here.
 */
export interface BookingFinanceStateRow extends DiagnosticsToolRawRow {
  booking_id: string;
  booking_reference: string;
  booking_status: string;
  payment_ref: string | null;
  payment_status: string | null;
  payment_source: string | null;
  payment_display_label: string;
  settlement_kind: string;
  xero_state: string;
  amount_due_cents: number;
  credit_applied_cents: number;
  amount_paid_cents: number;
  refunded_amount_cents: number;
  outstanding_cents: number;
  uncollected_additional_cents: number;
  remaining_refundable_cents: number;
  ledger_variance_cents: number;
  credit_ledger_variance_cents: number;
  member_credit_balance_cents: number;
  blocker_codes: string;
  blocker_count: number;
  manually_marked_paid: boolean;
  observed_at_utc: string;
}

/** The booking columns this source reads. Named explicitly, never `include`. */
const BOOKING_SELECT = {
  id: true,
  memberId: true,
  status: true,
  finalPriceCents: true,
} as const;

/** The payment columns this source reads. */
const PAYMENT_SELECT = {
  id: true,
  status: true,
  source: true,
  amountCents: true,
  refundedAmountCents: true,
  creditAppliedCents: true,
  additionalAmountCents: true,
  additionalPaymentStatus: true,
  xeroInvoiceId: true,
  manuallyMarkedPaidAt: true,
} as const;

/**
 * The cancellation-credit rows the authoritative display-status and
 * settlement-kind helpers need.
 *
 * `description` is READ and never RETURNED. Those two helpers classify a
 * settlement by matching the description against two server-written prefixes
 * ("Cancellation refund for booking…", "Credit restored from cancelled
 * booking…"), so the classification cannot be reproduced without it. It is
 * consumed inside this function and dropped; nothing downstream of
 * `readBookingFinanceStateEvidence` ever sees it, and the registry projection has
 * no field for it.
 */
async function readCancellationCredits(
  bookingId: string,
): Promise<{ amountCents: number; description: string | null }[]> {
  const rows = await prisma.memberCredit.findMany({
    where: { sourceBookingId: bookingId },
    select: { amountCents: true, description: true },
    // Bounded: a booking's own credit rows are a handful, and a ceiling means a
    // pathological one cannot make this read unbounded.
    take: 50,
  });
  return rows.map((row) => ({
    amountCents: row.amountCents,
    description: row.description,
  }));
}

/**
 * The Xero sync operations for this booking and its payment, summarised with the
 * SAME classification `/admin/payments` uses.
 *
 * Both `localModel` values are read because a booking's invoice work is recorded
 * against the booking and its payment adjustments against the payment, and an
 * operator asking "why has this not reached Xero" means both.
 */
async function readXeroActivity(
  bookingId: string,
  paymentId: string | null,
): Promise<XeroActivitySummary> {
  const localIds = paymentId ? [bookingId, paymentId] : [bookingId];
  const operations = await prisma.xeroSyncOperation.findMany({
    where: {
      localModel: { in: ["Booking", "Payment"] },
      localId: { in: localIds },
      // An operation an administrator resolved by hand in Xero is deliberately
      // excluded from the failure counts, exactly as the admin overview excludes
      // it — otherwise a fixed problem keeps being reported as a live one.
      manuallyResolvedAt: null,
    },
    select: { id: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const summary = emptyXeroActivitySummary();
  for (const operation of operations) {
    if (operation.status === "FAILED") summary.failed += 1;
    else if (operation.status === "PARTIAL") summary.partial += 1;
    else if (
      operation.status === "PENDING" ||
      operation.status === "RUNNING" ||
      operation.status === "WAITING_PAYMENT"
    ) {
      summary.pending += 1;
    }
    if (
      !summary.latestOperationAt ||
      operation.createdAt > new Date(summary.latestOperationAt)
    ) {
      summary.latestOperationId = operation.id;
      summary.latestOperationStatus = operation.status;
      summary.latestOperationAt = operation.createdAt.toISOString();
    }
  }
  return summary;
}

/** The refund-side state that decides three of the blocker codes. */
async function readRefundPosture(
  bookingId: string,
  paymentId: string | null,
): Promise<{
  executionExhausted: boolean;
  executionPending: boolean;
  manualOpen: boolean;
  appealPending: boolean;
}> {
  const [recovery, manualOpen, appealPending] = await Promise.all([
    paymentId
      ? prisma.paymentRecoveryOperation.findMany({
          where: {
            paymentId,
            type: { not: "CREATE_ADDITIONAL_PAYMENT_INTENT" },
            status: { in: ["PENDING", "PROCESSING", "FAILED"] },
          },
          select: { status: true, attempts: true },
          take: 50,
        })
      : Promise.resolve([]),
    paymentId
      ? prisma.manualRefundTask.count({
          where: { paymentId, status: "OPEN" },
        })
      : Promise.resolve(0),
    prisma.refundRequest.count({
      where: { bookingId, status: "PENDING" },
    }),
  ]);

  return {
    executionExhausted: recovery.some(
      (row) =>
        row.status === "FAILED" &&
        row.attempts >= FINANCE_RECOVERY_ATTEMPT_CEILING,
    ),
    executionPending: recovery.some(
      (row) => row.status === "PENDING" || row.status === "PROCESSING",
    ),
    manualOpen: manualOpen > 0,
    appealPending: appealPending > 0,
  };
}

/**
 * Assemble the authoritative booking-finance state. Returns ZERO rows when the
 * booking does not exist — which the executor reports as `not_found`, the honest
 * "we looked and there is nothing" — and exactly one row otherwise, including
 * when the booking has no payment at all.
 *
 * It REJECTS rather than returning a partial row on any failure, so the executor
 * reports `evidence_unavailable`. A finance state assembled from some of its
 * inputs would read as authoritative and be wrong.
 */
async function assembleBookingFinanceState(
  bookingId: string,
): Promise<readonly BookingFinanceStateRow[]> {
  const observedAtUtc = new Date().toISOString();

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_SELECT,
  });
  if (!booking) return [];

  const payment = await prisma.payment.findUnique({
    where: { bookingId },
    select: PAYMENT_SELECT,
  });

  const [appliedCreditCents, credits, memberCreditBalanceCents] =
    await Promise.all([
      deriveBookingAppliedCreditCents(bookingId),
      readCancellationCredits(bookingId),
      getMemberCreditBalance(booking.memberId),
    ]);

  const [xeroActivity, refundPosture] = await Promise.all([
    readXeroActivity(bookingId, payment?.id ?? null),
    readRefundPosture(bookingId, payment?.id ?? null),
  ]);

  // ---- Money. Integer cents only, no division anywhere. ------------------
  const amountDueCents = booking.finalPriceCents;
  const refundedAmountCents = payment?.refundedAmountCents ?? 0;
  const storedCreditAppliedCents = payment?.creditAppliedCents ?? 0;
  const capturedCents = hasCapturedPayment(
    payment
      ? {
          status: payment.status,
          amountCents: payment.amountCents,
          refundedAmountCents: payment.refundedAmountCents,
        }
      : null,
  )
    ? (payment?.amountCents ?? 0)
    : 0;
  const uncollectedAdditionalCents =
    payment && payment.additionalPaymentStatus !== "SUCCEEDED"
      ? payment.additionalAmountCents
      : 0;

  // The identity `prepareManualSettlement` asserts at write time:
  //   amountCents + creditAppliedCents + uncollectedAdditionalCents === finalPriceCents
  // Reported as a signed integer-cent variance rather than re-asserted, because a
  // diagnostic exists precisely for the rows where it does NOT hold.
  const ledgerVarianceCents = payment
    ? payment.amountCents +
      storedCreditAppliedCents +
      uncollectedAdditionalCents -
      amountDueCents
    : 0;

  // The denormalised column against the ledger truth. Signed, in cents.
  const creditLedgerVarianceCents = storedCreditAppliedCents - appliedCreditCents;

  const outstandingCents =
    amountDueCents - appliedCreditCents - capturedCents;

  const remainingRefundableCents = getRemainingRefundableCents(
    payment
      ? {
          status: payment.status,
          amountCents: payment.amountCents,
          refundedAmountCents: payment.refundedAmountCents,
        }
      : null,
  );

  // ---- Authoritative classifications, never re-derived here. -------------
  const displayStatus = getPaymentDisplayStatus({
    bookingStatus: booking.status,
    paymentStatus: payment?.status ?? "PENDING",
    refundedAmountCents,
    credits,
  });
  const settlementKind = deriveSettlementKind({
    refundedAmountCents,
    credits,
  });
  const xeroState = deriveXeroState({
    invoiceExpected: isSettledBookingStatus(booking.status),
    invoiceLinked: Boolean(payment?.xeroInvoiceId),
    activity: xeroActivity,
  });

  // ---- Blockers, in the declared priority order. -------------------------
  const blockers: FinanceBlockerCode[] = [];
  const add = (code: FinanceBlockerCode) => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  if (!payment) add("payment_record_missing");
  if (refundPosture.executionExhausted) add("refund_execution_exhausted");
  if (refundPosture.executionPending) add("refund_execution_pending");
  if (refundPosture.manualOpen) add("manual_refund_open");
  if (refundPosture.appealPending) add("refund_appeal_pending");
  if (xeroState === "operationFailed") add("xero_operation_failed");
  if (xeroState === "operationPartial") add("xero_operation_partial");
  if (xeroState === "operationPending") add("xero_operation_pending");
  if (xeroState === "invoiceMissing") add("xero_invoice_missing");
  if (uncollectedAdditionalCents > 0) add("additional_payment_outstanding");
  if (payment?.status === "FAILED") add("payment_failed");
  if (payment?.status === "PROCESSING") add("payment_processing");
  if (payment?.status === "PENDING") add("payment_pending");
  if (ledgerVarianceCents !== 0) add("ledger_variance");
  if (creditLedgerVarianceCents !== 0) add("credit_ledger_variance");

  // Sorted into the declared priority order rather than insertion order, so the
  // first code is always the one an operator should act on first even if the
  // checks above are ever reordered.
  blockers.sort(
    (left, right) =>
      FINANCE_BLOCKER_CODES.indexOf(left) - FINANCE_BLOCKER_CODES.indexOf(right),
  );

  return [
    {
      booking_id: booking.id,
      booking_reference: formatBookingReference(booking.id),
      booking_status: booking.status,
      payment_ref: payment?.id ?? null,
      payment_status: payment?.status ?? null,
      payment_source: payment?.source ?? null,
      payment_display_label: displayStatus.label,
      settlement_kind: settlementKind,
      xero_state: xeroState,
      amount_due_cents: amountDueCents,
      credit_applied_cents: appliedCreditCents,
      amount_paid_cents: capturedCents,
      refunded_amount_cents: refundedAmountCents,
      outstanding_cents: outstandingCents,
      uncollected_additional_cents: uncollectedAdditionalCents,
      remaining_refundable_cents: remainingRefundableCents,
      ledger_variance_cents: ledgerVarianceCents,
      credit_ledger_variance_cents: creditLedgerVarianceCents,
      member_credit_balance_cents: memberCreditBalanceCents,
      // A stable, comma-joined list in priority order — the same shape AID-6A's
      // readiness entry uses, so a consumer parses one convention.
      blocker_codes: blockers.length > 0 ? blockers.join(",") : "none",
      blocker_count: blockers.length,
      manually_marked_paid: payment?.manuallyMarkedPaidAt != null,
      observed_at_utc: observedAtUtc,
    },
  ];
}

/**
 * The evidence source the registry entry names, with this module's own deadline
 * wrapped around it.
 *
 * The work promise gets its own no-op `catch` BEFORE the race, so a rejection
 * that arrives after the deadline is handled rather than surfacing as an
 * unhandled rejection — the same discipline `invoke.ts` applies to the executor's
 * own race, and for the same reason: an unhandled rejection can take the process
 * down.
 *
 * READING THIS FUNCTION DIRECTLY IS OUTSIDE THE SUBSTRATE'S GUARANTEES. It is an
 * ordinary module export, and a server-side caller could import it and get none of
 * the ten gates. The module is marked `server-only`, so no such import can reach a
 * browser bundle, but the guarantee the substrate makes is about the registry
 * ENTRY — which exposes no handle on this function at all — not about the
 * reachability of the function.
 */
export async function readBookingFinanceStateEvidence(args: {
  bookingId: string;
}): Promise<readonly DiagnosticsToolRawRow[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = assembleBookingFinanceState(args.bookingId);
  void work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Booking finance state evidence did not assemble in time.",
              ),
            ),
          BOOKING_FINANCE_DEADLINE_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
