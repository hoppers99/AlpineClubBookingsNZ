import { prisma } from "@/lib/prisma";
import {
  BookingEventType,
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import {
  findPaymentTransactionByIntentId,
  planStripeRefundAllocation,
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import {
  enqueueCapacityClaimFailedRefundRecovery,
  enqueueDuplicateCaptureRefundRecovery,
  enqueuePaymentIntentCancellationRecovery,
  findOtherDuplicateCaptureRefundOperation,
  markCapacityClaimFailedRefundRecoverySucceeded,
  markDuplicateCaptureRefundRecoverySucceeded,
  recordCapacityClaimFailedRefundRecoveryInlineError,
  recordDuplicateCaptureRefundRecoveryInlineError,
} from "@/lib/payment-recovery";
import {
  buildBookingModificationRefundMetadata,
  buildCapacityClaimFailedRefundStripeKeyPrefix,
  buildDuplicateCaptureRefundRecoveryIdempotencyKey,
  buildDuplicateCaptureRefundStripeKeyPrefix,
} from "@/lib/payment-recovery-keys";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  deriveBookingAppliedCreditCents,
  lockMemberCreditLedger,
  restoreCreditFromBooking,
} from "@/lib/member-credit";
import { createAuditLog } from "@/lib/audit";
import { cancelPaymentIntentIfCancellable } from "@/lib/stripe";
import {
  MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND,
  MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
  type ManualSettlementReversalEventSnapshot,
} from "@/lib/manual-settlement-reversal-event";
import {
  recordBookingEvent,
  recordDuplicateCaptureRefundEvent,
} from "@/lib/booking-events";
import {
  sendAdminDuplicateCaptureRefundAlert,
  sendAdminPaymentFailureAlert,
} from "@/lib/email";
import logger from "@/lib/logger";
import { clearStaleCreditElection } from "@/lib/booking-credit-election";
import { reportUnappliedCreditElection } from "@/lib/booking-credit-election-report";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { getDefaultLodgeId } from "@/lib/lodges";
import {
  bookingHasCapacityOverride,
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
} from "@/lib/booking-status";

type ReconciliationBooking = Prisma.BookingGetPayload<{
  include: {
    guests: true;
    member: true;
  };
}>;

export type MarkBookingPaymentSucceededResult = {
  outcome:
    | "paid"
    | "already_paid"
    | "cancelled_refunded"
    | "cancelled_refund_failed"
    // #1992 — a SECOND, distinct Stripe capture arrived on an already-PAID
    // booking (the residual #1967 split-child window). The duplicate capture
    // was auto-refunded (or a durable refund operation is pending for the
    // recovery cron when the inline attempt failed). The booking itself stays
    // settled by the other capture, so callers that only branch on the
    // cancelled_* outcomes keep treating these as "settled".
    | "duplicate_capture_refunded"
    | "duplicate_capture_refund_failed";
  bookingId: string;
  bumpedBookingIds: string[];
  refundError?: string;
};

const PAYABLE_SUCCESS_STATUS_LIST = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PENDING,
  BookingStatus.DRAFT,
] as const;

const PAYABLE_SUCCESS_STATUSES = new Set<string>(PAYABLE_SUCCESS_STATUS_LIST);

// #1992 (superseded-handoff exclusion) — the pre-existing superseded-intent
// machinery (booking-payment-cleanup queues a CANCEL_PAYMENT_INTENT recovery
// operation; when the cancel loses to a late capture, payment-recovery's
// handoff marks that transaction SUCCEEDED and queues a
// REFUND_SUPERSEDED_PAYMENT operation for the cron) transiently produces
// EXACTLY the shape the duplicate-capture predicate below hunts for: another
// SUCCEEDED PRIMARY Stripe capture with net cash under a different intent id,
// with no duplicate_capture adjudication marker (the handoff never passes
// through markBookingPaymentSucceeded). That capture's money is already spoken
// for — the recovery cron will refund it under its
// `payment_recovery_refund_<txn>_<pi>` key — so treating it as "the
// settlement" would refund the REAL settlement as the duplicate and, once the
// cron also refunds the superseded capture, leave the booking PAID at zero net
// cash. A superseded-machinery operation counts as LIVE while it is not
// SUCCEEDED: PENDING, PROCESSING and FAILED (retrying or exhausted, where the
// money is still adjudicated to that machinery and admins were alerted). A
// SUCCEEDED cancel operation either actually cancelled the intent (its
// transaction is FAILED — never a predicate candidate) or handed off to a
// refund operation that is enqueued BEFORE the cancel operation completes; a
// SUCCEEDED refund operation leaves the transaction REFUNDED, which predicate
// (b) already excludes. So `status != SUCCEEDED` across both types covers the
// whole handoff window with no gap.
const SUPERSEDED_INTENT_OPERATION_TYPES = [
  PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
  PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
] as const;

/**
 * Guard (b′): every intent id on this payment whose money a live
 * superseded-intent recovery operation already owns. Run under lock(1) inside
 * the reconciliation transaction; the result feeds the `notIn` exclusion of
 * the duplicate-capture candidate query.
 */
async function listLiveSupersededIntentIds(
  tx: Prisma.TransactionClient,
  paymentId: string
): Promise<string[]> {
  const operations = await tx.paymentRecoveryOperation.findMany({
    where: {
      paymentId,
      type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    select: { paymentIntentId: true },
  });
  return [...new Set(operations.map((operation) => operation.paymentIntentId))];
}

/**
 * Guard (c′), belt-and-braces sibling of (b′) with a deliberately DIFFERENT
 * query shape (direct intent-id lookup, not scoped to a payment): does a live
 * superseded-intent recovery operation own this specific intent's money? Used
 * to re-check the matched "settlement" candidate so that even if it slipped
 * the (b′) exclusion, the arriving capture stays plain already_paid.
 */
async function findLiveSupersededIntentOperation(
  tx: Prisma.TransactionClient,
  paymentIntentId: string
) {
  return tx.paymentRecoveryOperation.findFirst({
    where: {
      paymentIntentId,
      type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    select: { id: true },
  });
}

async function alertRefundFailure({
  booking,
  paymentIntentId,
  amountCents,
  error,
}: {
  booking: ReconciliationBooking;
  paymentIntentId: string;
  amountCents: number;
  error: unknown;
}) {
  const errorMessage = error instanceof Error ? error.message : String(error);

  sendAdminPaymentFailureAlert({
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    amountCents,
    errorMessage: `Payment succeeded but final capacity claim failed and automatic refund failed: ${errorMessage}`,
    paymentIntentId,
  }).catch((alertErr) =>
    logger.error(
      { err: alertErr, bookingId: booking.id, paymentIntentId },
      "Failed to alert admins about capacity refund failure"
    )
  );
}

/**
 * B5 (#2262) — a booking settlement is now described by its SOURCE, so the one
 * settlement body below serves both the Stripe capture and the admin recording
 * a cash / off-Xero bank transfer. Guard 1 of #2262 is discharged structurally:
 * there is no second path that could drift from this one's lock ordering,
 * capacity check, status fence, bed reconciliation or event recording.
 */
type StripeSettlementSource = {
  kind: "stripe";
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId: string | null;
};

type ManualSettlementSource = {
  kind: "manual";
  actingAdminMemberId: string;
  note: string | null;
  /**
   * The amount the admin was shown in the dialog. The settlement amount itself
   * is NEVER taken from the client — it is recomputed under the locks — but a
   * mismatch means the price or the applied credit moved since the dialog
   * rendered, so the settle is refused rather than recorded at a figure the
   * admin never agreed to.
   */
  expectedAmountCents: number;
  notifyMember: boolean;
};

type BookingSettlementSource = StripeSettlementSource | ManualSettlementSource;

/**
 * B5 (#2262): a domain refusal from the manual booking-payment paths, carrying
 * the HTTP status the route should answer with. Lives here (rather than in
 * manual-booking-payment.ts) so the settlement core can throw it without a
 * circular import.
 */
export class ManualBookingPaymentError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ManualBookingPaymentError";
    this.status = status;
  }
}

const MANUAL_XERO_INVOICE_REFUSAL =
  "This booking has an outstanding Xero invoice — record the payment against the invoice in Xero instead.";
const MANUAL_XERO_QUEUED_MINT_REFUSAL =
  "A Xero invoice for this booking is already queued — let it finish, then record the payment against the invoice in Xero.";
const MANUAL_GROUP_SETTLEMENT_REFUSAL =
  "This booking was settled as part of a group booking — record the payment against the group settlement instead.";

/**
 * B5 (#2262) guard 2, read side. Every piece of evidence that a Xero invoice
 * exists — or is about to — for this payment. Run under lock(1) inside the
 * settlement/reversal transaction, before any write.
 *
 * The payment-level and transaction-level conditions are ALSO re-asserted in
 * the fenced write, because an invoice can be minted between this read and that
 * write. The object-link and outbox-operation evidence are read-time refusals:
 * they cannot be expressed as a Payment WHERE, and the settle-time refusal plus
 * the choke-point and handler fences in the Xero mint path close that race from
 * the other side.
 */
async function assertNoXeroInvoiceEvidence(
  tx: Prisma.TransactionClient,
  payment: {
    id: string;
    xeroInvoiceId: string | null;
    xeroRefundCreditNoteId: string | null;
  }
) {
  if (payment.xeroInvoiceId || payment.xeroRefundCreditNoteId) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  // Transaction-stamped-but-payment-null is a MODELED drift state, not a
  // hypothesis: the zero-cash inbound arm stamps the transaction rows in writes
  // that do not also stamp the payment, and the repair classifier backfills the
  // payment-level id from exactly that transaction-level evidence. A
  // payment-level check alone is a hole.
  const stampedTransaction = await tx.paymentTransaction.findFirst({
    where: { paymentId: payment.id, xeroInvoiceId: { not: null } },
    select: { id: true },
  });
  if (stampedTransaction) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  const activeInvoiceLink = await tx.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: payment.id,
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });
  if (activeInvoiceLink) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  const completedMint = await tx.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: payment.id,
      status: "SUCCEEDED",
    },
    select: { id: true },
  });
  if (completedMint) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  // An invoice mint that is queued but has not fired yet. Without this the
  // common ordering — an operation enqueued minutes before the cron picks it up
  // — lets a mark-paid commit while a real awaiting-payment invoice is about to
  // be created AND EMAILED to the member for money already collected in cash.
  // The repair classifier already models this exact state as its own finding
  // (BLOCKED_BY_XERO_OPERATION), so it is a real, observed state.
  //
  // Deliberately a SUPERSET of the choke point's own predicate: WAITING_PAYMENT
  // is included alongside PENDING/RUNNING because such an operation is
  // unambiguously a mint that has not happened yet and will fire later.
  const inFlightMint = await tx.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: payment.id,
      status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
    },
    select: { id: true },
  });
  if (inFlightMint) {
    throw new ManualBookingPaymentError(MANUAL_XERO_QUEUED_MINT_REFUSAL, 409);
  }
}

/**
 * B5 (#2262): everything the manual path decides BEFORE the shared settlement
 * body writes anything — the third lock tier, every refusal, and the settlement
 * amount. Split out only so the shared body below stays readable; every step
 * the four guards care about (locks, capacity, fences, bed reconciliation,
 * events) still lives in the one settlement body.
 *
 * Runs under lock(1) + the per-lodge lock, and takes the MEMBER-CREDIT lock as
 * the third tier (global -> lodge -> member-credit, the same composition
 * switch-to-internet-banking uses) before deriving the amount, so the derived
 * figure cannot race an applied-credit writer.
 */
async function prepareManualSettlement(
  tx: Prisma.TransactionClient,
  booking: ReconciliationBooking,
  settlement: ManualSettlementSource
) {
  // Third lock tier. Credit writers serialise on a per-member key, not lock(1),
  // so the switch-to-internet-banking precedent deliberately refuses to rely on
  // other writers holding lock(1); this path does the same.
  await lockMemberCreditLedger(booking.memberId, tx);

  if (booking.status === BookingStatus.PAID) {
    // Refusal, never the duplicate-adjudication branch: no manual money fact
    // has been written yet, so rolling back is exact and the admin keeps the
    // cash rather than the club recording it twice.
    throw new ManualBookingPaymentError(
      "This booking is already paid — nothing was recorded.",
      409
    );
  }

  if (!PAYABLE_SUCCESS_STATUSES.has(booking.status)) {
    throw new ManualBookingPaymentError(
      `This booking cannot be paid from status ${booking.status}.`,
      409
    );
  }

  // Guard 2, conservative v1 group fence (owner-decided 28 Jul). organiserSettled
  // is set once, under lock(1), by the group-settlement path, so the post-lock
  // re-read decides it permanently. Each-pays group members and the organiser's
  // own parent booking are deliberately NOT fenced.
  if (booking.organiserSettled) {
    throw new ManualBookingPaymentError(MANUAL_GROUP_SETTLEMENT_REFUSAL, 409);
  }

  const payment = await tx.payment.findUnique({
    where: { bookingId: booking.id },
    select: {
      id: true,
      xeroInvoiceId: true,
      xeroRefundCreditNoteId: true,
      manuallyMarkedPaidAt: true,
      refundedAmountCents: true,
    },
  });

  if (payment) {
    if (payment.manuallyMarkedPaidAt) {
      throw new ManualBookingPaymentError(
        "This booking's payment is already recorded as a manual settlement.",
        409
      );
    }
    // L7 (#2262): a manually settled payment carries NO prior refund history.
    // Money already handed back through the ledger cannot be reconciled with a
    // cash settlement recorded over the top of it — the reversal's fences and
    // the settle's own mirror both assume refundedAmountCents starts at 0 —
    // so the settle refuses rather than recording an irreconcilable row. The
    // fenced write below re-asserts this as a WHERE condition.
    if (payment.refundedAmountCents !== 0) {
      throw new ManualBookingPaymentError(
        "This booking's payment already carries refund history — it cannot be recorded as a manual settlement. Cancel and rebook, or resolve the refund first.",
        409
      );
    }
    await assertNoXeroInvoiceEvidence(tx, payment);
  }

  // The amount law. The manual path NEVER accepts a client-supplied settlement
  // amount: it recomputes the effective price under the full lock set.
  const creditAppliedCents = await deriveBookingAppliedCreditCents(
    booking.id,
    tx
  );
  const effectiveAmountCents = booking.finalPriceCents - creditAppliedCents;

  if (!Number.isSafeInteger(effectiveAmountCents)) {
    throw new ManualBookingPaymentError(
      "This booking's amount owing is not a whole number of cents — refresh and check the booking's price.",
      409
    );
  }
  if (effectiveAmountCents <= 0) {
    // Verified: no $0 booking is stranded without one of these paths.
    throw new ManualBookingPaymentError(
      "This booking has nothing owing — use Force confirm / Confirm pending guests instead.",
      409
    );
  }
  if (effectiveAmountCents !== settlement.expectedAmountCents) {
    throw new ManualBookingPaymentError(
      "The amount owing changed while you were recording this payment — refresh and check the figure before recording it.",
      409
    );
  }

  // The ledger mirror holds by construction (effective = final - credit), but
  // assert it explicitly so a future change to either derivation is caught here
  // rather than in the ledger.
  if (effectiveAmountCents + creditAppliedCents !== booking.finalPriceCents) {
    throw new ManualBookingPaymentError(
      "This booking's payment ledger does not reconcile — refresh and try again.",
      409
    );
  }

  return { effectiveAmountCents, creditAppliedCents, paymentId: payment?.id ?? null };
}

/**
 * B5 (#2262) Stripe-intent hygiene for a manual settlement. Any Stripe intent
 * on this payment that has NOT reached a terminal state is still capable of
 * capturing — the member's `/pay` tab may hold a live client secret — so a
 * durable CANCEL_PAYMENT_INTENT recovery operation is enqueued for each,
 * ATOMICALLY with the settlement and BEFORE any Stripe call. The best-effort
 * Stripe cancel itself runs after commit, never inside this transaction.
 *
 * Returns the intent ids so the caller can attempt the cancel, and so the
 * reversal can name exactly what it disarmed.
 */
async function enqueueManualSettlementIntentCancellations(
  tx: Prisma.TransactionClient,
  { bookingId, paymentId }: { bookingId: string; paymentId: string }
): Promise<string[]> {
  const liveTransactions = await tx.paymentTransaction.findMany({
    where: {
      paymentId,
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: { not: null },
      // Non-terminal only. A SUCCEEDED row is money already in the ledger (and
      // the duplicate-capture machinery's business), and FAILED/REFUNDED rows
      // have nothing left to cancel.
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
    },
    select: { id: true, stripePaymentIntentId: true, amountCents: true },
  });

  const intentIds: string[] = [];
  for (const transaction of liveTransactions) {
    if (!transaction.stripePaymentIntentId) continue;
    await enqueuePaymentIntentCancellationRecovery({
      bookingId,
      paymentId,
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
      store: tx,
    });
    intentIds.push(transaction.stripePaymentIntentId);
  }
  return intentIds;
}

/**
 * The ONE booking-settlement body (#2262 guard 1). Both the Stripe capture and
 * the admin's manual cash settlement execute it, so the lock ordering, the
 * post-lock re-read, the capacity check with its #1771 override carve-out, the
 * status-fenced PAID claim and the bed reconciliation are literally the same
 * lines for both — there is no sibling path that can drift.
 *
 * Runs INSIDE a caller-provided transaction; every provider call (Stripe
 * refunds/cancels, email) belongs to the callers, after commit.
 */
async function settleBookingPaymentInTransaction(
  tx: Prisma.TransactionClient,
  bookingId: string,
  settlement: BookingSettlementSource
) {
    // Two-tier lock protocol (#1881). A Stripe capture does BOTH tiers of work:
    // it flips the booking's status + moves money (the booking-status/money
    // tier), AND it claims capacity (the per-lodge tier). It must therefore
    // hold BOTH locks, and the global lock(1) is taken FIRST — always
    // global-before-per-lodge, so the ordering is deadlock-free against every
    // other two-lock writer (invoice-paid-effects, confirm-pending-guests).
    // Without lock(1) this capture no longer mutually excluded the cancel /
    // hold-release / settlement paths (which serialise on lock(1)); a concurrent
    // cancel could interleave and the bare PAID write below could resurrect a
    // just-cancelled booking. The per-lodge lock still serialises the capacity
    // claim against per-lodge creators.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    // Pre-lock read: only the lodge lock key. lodgeId is immutable, so keying
    // the per-lodge lock from this read is safe; every status/capacity-relevant
    // field is taken from the post-lock re-read below.
    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });

    if (!lockTarget) {
      throw new Error("Booking not found");
    }

    const bookingLodgeId = lockTarget.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    // Re-read the full booking under the lock; the status/amount checks, the
    // capacity check and the PAID/CANCELLED claim below consume ONLY this
    // post-lock snapshot.
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        guests: { include: { nights: true } }, // per-night sets (issue #713)
        member: true,
      },
    });

    if (!booking) {
      throw new Error("Booking not found");
    }

    // B5 (#2262): the manual path's third lock tier, every guard-2 refusal and
    // the amount law, all decided from this same post-lock snapshot and all
    // BEFORE the first write below.
    const manual =
      settlement.kind === "manual"
        ? await prepareManualSettlement(tx, booking, settlement)
        : null;

    // The amount this settlement moves. The Stripe path takes the captured
    // amount as given (and validates it against the booking below); the manual
    // path recomputed it under the locks and never accepts one from a client.
    const settlementAmountCents =
      manual !== null
        ? manual.effectiveAmountCents
        : (settlement as StripeSettlementSource).amountCents;

    // #1641 — split the captured amount into cash + credit so the mirror invariant
    // `amountCents + creditAppliedCents = finalPriceCents` holds for BOTH a new
    // effective capture (credit = applied) and a legacy full-price capture
    // (credit = 0, repaired locally by the audit — never a Xero over-allocation).
    // This is derived from the captured amount alone; the ledger is only read below
    // when the amount is NOT the full price (to admit the effective capture).
    // The manual path already derived both halves under the MEMBER-CREDIT lock.
    const mirrorCreditAppliedCents =
      manual !== null
        ? manual.creditAppliedCents
        : Math.max(0, booking.finalPriceCents - settlementAmountCents);

    const payment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents: settlementAmountCents,
        creditAppliedCents: mirrorCreditAppliedCents,
        status: PaymentStatus.PENDING,
      },
      update: {},
    });

    let refundedIntentHistory = false;

    if (settlement.kind === "stripe") {
      // #1765 — refund history is immutable: an intent whose transaction was
      // refunded (fully or partially) must never be re-admitted as settlement,
      // whichever path (intent-route recovery, confirm-payment, webhook
      // redelivery, payment link) carries the succeeded intent back here.
      // Without this guard a redelivered success event for a refunded intent
      // would clobber the transaction row back to SUCCEEDED and, when the
      // booking price never changed, settle the booking at zero net cash. The
      // lookup backfills pre-ledger payments so legacy refund history is caught
      // too. Crashed-webhook recovery is untouched: its transaction is still
      // PENDING/PROCESSING (success was never recorded locally).
      const priorTransaction = await findPaymentTransactionByIntentId({
        paymentIntentId: settlement.paymentIntentId,
        store: tx,
      });
      refundedIntentHistory =
        priorTransaction !== null &&
        (priorTransaction.status === PaymentStatus.REFUNDED ||
          priorTransaction.status === PaymentStatus.PARTIALLY_REFUNDED);

      if (!refundedIntentHistory) {
        await upsertPaymentIntentTransaction({
          paymentId: payment.id,
          kind: PaymentTransactionKind.PRIMARY,
          paymentIntentId: settlement.paymentIntentId,
          amountCents: settlement.amountCents,
          status: PaymentStatus.SUCCEEDED,
          paymentMethodId: settlement.paymentMethodId,
          store: tx,
        });
      }
    } else {
      // B5 (#2262) manual transaction mint. Shaped after the inbound-Xero mint
      // (an INTERNET_BANKING PRIMARY row, no Stripe intent id) minus the
      // invoice stamping, because this settlement has no invoice by definition.
      //
      // DELIBERATE DIVERGENCE 1 — FAILED rows are excluded from the update
      // predicate, where the inbound mint excludes only REFUNDED /
      // PARTIALLY_REFUNDED. A reversal marks this feature's manual row FAILED at
      // the old amount; resurrecting it would settle the booking at a stale
      // figure. Do not "restore" the inbound predicate here.
      //
      // DELIBERATE DIVERGENCE 2 — on count 0 this CREATES UNCONDITIONALLY. The
      // inbound mint first looks for ANY existing IB PRIMARY row and only
      // creates when none exists; copied here that fallback would find the
      // reversal's FAILED row and mint nothing, leaving a PAID payment with no
      // settled transaction. Refund history on the payment is left untouched
      // (#1765 / #1357 raise-only spirit).
      const mintedUpdate = await tx.paymentTransaction.updateMany({
        where: {
          paymentId: payment.id,
          source: PaymentSource.INTERNET_BANKING,
          kind: PaymentTransactionKind.PRIMARY,
          status: {
            notIn: [
              PaymentStatus.REFUNDED,
              PaymentStatus.PARTIALLY_REFUNDED,
              PaymentStatus.FAILED,
            ],
          },
        },
        data: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: settlementAmountCents,
          reason: "manual_mark_paid",
        },
      });

      if (mintedUpdate.count === 0) {
        await tx.paymentTransaction.create({
          data: {
            paymentId: payment.id,
            kind: PaymentTransactionKind.PRIMARY,
            source: PaymentSource.INTERNET_BANKING,
            stripePaymentIntentId: null,
            amountCents: settlementAmountCents,
            status: PaymentStatus.SUCCEEDED,
            reason: "manual_mark_paid",
          },
        });
      }
    }

    if (booking.status === BookingStatus.PAID) {
      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      // #1992 — duplicate-capture detection. `already_paid` is the normal
      // exactly-once replay outcome for a success that carries the SAME intent
      // the booking settled with (webhook redelivery, the confirm-payment
      // route racing the webhook, payment-link reconcile, charge-saved-method
      // and cron-confirm-pending reruns replaying their `pending_charge_`
      // Stripe idempotency key, confirm-pending-guests retries). But a
      // DIFFERENT intent capturing against an already-PAID booking is double
      // money: the residual #1967 split-child window, where the /pay link
      // intent (client secret already in the member's browser) and the
      // settlement cron's saved-card charge both capture. Refund the arriving
      // duplicate automatically instead of stranding it behind a manual
      // reconcile. The refund debt is enqueued here, ATOMIC with this
      // transaction and BEFORE any Stripe call (the #1349 pattern); the Stripe
      // refund itself executes after commit, below.
      //
      // Distinctness predicate — refund the arriving intent ONLY when all of:
      //   (a) the arriving intent has no refund history (#1765 guard above —
      //       an already-(partly-)refunded replay stays plain already_paid);
      //   (b) ANOTHER captured PRIMARY transaction with net cash (SUCCEEDED or
      //       PARTIALLY_REFUNDED — deliberately NOT fully REFUNDED, so a #1765
      //       repay-generation replay arriving alongside its refunded
      //       predecessor is never treated as a duplicate) exists on this
      //       payment: either a STRIPE row under a different intent id, or —
      //       since #2262 guard 3 — ANY non-Stripe settled PRIMARY row. A cash
      //       settlement recorded by an admin, and a Xero-inbound internet
      //       banking settlement, are both real money already collected; a
      //       later stray Stripe capture on top of either is double money, and
      //       before the widening it fell through to plain `already_paid` and
      //       was silently kept. The non-Stripe arm carries no arriving-row
      //       exclusion and does not need one: upsertPaymentIntentTransaction
      //       hardcodes source STRIPE on both its create and update arms, so
      //       the row this settlement just wrote can never match it (pinned by
      //       a test, so a future "derive the source from the payment" refactor
      //       fails loudly instead of making a capture refund itself);
      //   (b′) that other capture's money is NOT already owned by the
      //       superseded-intent machinery (a live CANCEL_PAYMENT_INTENT /
      //       REFUND_SUPERSEDED_PAYMENT recovery operation — see
      //       SUPERSEDED_INTENT_OPERATION_TYPES). The handoff of a superseded
      //       intent's late capture sets it SUCCEEDED with a queued refund
      //       WITHOUT ever passing through this function, so from the ledger
      //       alone it is indistinguishable from a settlement; refunding the
      //       arriving capture against it would refund the REAL settlement
      //       while the cron refunds the superseded one — zero net cash;
      //   (c) no duplicate-capture refund has already been adjudicated for
      //       this booking against a DIFFERENT intent. Without (c), webhook
      //       replays of BOTH captures would refund both sides (Y settles, X
      //       arrives → refund X; Y's redelivery then sees X SUCCEEDED-and-
      //       different → refund Y too) and settle the booking at zero net
      //       cash. lock(1), held by every caller of this function, serialises
      //       the check-then-enqueue, so exactly one side of the pair can ever
      //       open a refund operation;
      //   (c′) belt-and-braces re-check of (b′) against the matched candidate
      //       directly (different query shape) — if a live superseded-intent
      //       operation owns the candidate's money, the arriving capture is
      //       the settlement side and stays plain already_paid.
      // All of these run inside the same lock(1) transaction.
      if (!refundedIntentHistory && settlement.kind === "stripe") {
        const { paymentIntentId, amountCents } = settlement;
        const liveSupersededIntentIds = await listLiveSupersededIntentIds(
          tx,
          payment.id
        );
        const otherSettledCapture = await tx.paymentTransaction.findFirst({
          where: {
            paymentId: payment.id,
            kind: PaymentTransactionKind.PRIMARY,
            status: {
              in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED],
            },
            OR: [
              {
                source: PaymentSource.STRIPE,
                stripePaymentIntentId: {
                  not: paymentIntentId,
                  notIn: liveSupersededIntentIds,
                },
                NOT: { stripePaymentIntentId: null },
              },
              { source: { not: PaymentSource.STRIPE } },
            ],
          },
          select: { id: true, stripePaymentIntentId: true },
        });

        if (otherSettledCapture) {
          const adjudicatedElsewhere =
            await findOtherDuplicateCaptureRefundOperation({
              bookingId: booking.id,
              paymentIntentId,
              store: tx,
            });

          // (c′) — the candidate's own intent id re-checked against the live
          // superseded-machinery operations. Skipped when (c) already settled
          // the adjudication.
          const supersededOwnsOtherCapture =
            adjudicatedElsewhere || !otherSettledCapture.stripePaymentIntentId
              ? null
              : await findLiveSupersededIntentOperation(
                  tx,
                  otherSettledCapture.stripePaymentIntentId
                );

          // Re-read the arriving duplicate's row AFTER the upsert above so the
          // frozen refund slice targets exactly this capture's transaction and
          // its outstanding captured amount — never a newest-first allocation
          // that could touch the settlement capture.
          const duplicateTransaction =
            adjudicatedElsewhere || supersededOwnsOtherCapture
              ? null
              : await findPaymentTransactionByIntentId({
                  paymentIntentId,
                  store: tx,
                });
          const duplicateRefundCents = duplicateTransaction
            ? Math.min(
                amountCents,
                duplicateTransaction.amountCents -
                  duplicateTransaction.refundedAmountCents
              )
            : 0;

          if (duplicateTransaction && duplicateRefundCents > 0) {
            const refundPlan = [
              {
                paymentTransactionId: duplicateTransaction.id,
                amountCents: duplicateRefundCents,
              },
            ];
            await enqueueDuplicateCaptureRefundRecovery({
              bookingId: booking.id,
              paymentId: payment.id,
              paymentIntentId,
              amountCents: duplicateRefundCents,
              allocationPlan: refundPlan,
              store: tx,
            });

            return {
              outcome: "duplicate_capture" as const,
              booking,
              paymentId: payment.id,
              bumpedBookingIds: [] as string[],
              refundPlan,
              plannedRefundCents: duplicateRefundCents,
              settledPaymentIntentId: otherSettledCapture.stripePaymentIntentId,
            };
          }
        }
      }

      // A refunded-history redelivery on an already-PAID booking (e.g. a
      // Stripe event replay after a partial goodwill refund) stays benign —
      // and, with the guard above, no longer clobbers the refund marker.
      return {
        outcome: "already_paid" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
      };
    }

    if (refundedIntentHistory) {
      // #1765 — the booking is not settled and the carried intent's money was
      // handed back. Re-admitting it would settle the booking at zero net
      // cash; the member owes a fresh payment (the create-payment-intent
      // route mints the repay intent at the current effective price).
      throw new Error(
        "Refunded payment intent cannot be re-admitted as settlement; the booking needs a fresh payment (#1765)"
      );
    }

    if (!PAYABLE_SUCCESS_STATUSES.has(booking.status)) {
      throw new Error(`Booking is not payable from status ${booking.status}`);
    }

    // #1641 — accept EITHER the credit-reduced effective price (new intents) OR
    // the full finalPriceCents (legacy in-flight intents minted before the fix).
    // A wrong-amount capture (e.g. a stale intent from a since-changed price, #1161)
    // equals neither and is still rejected. Full price is always a legitimate
    // settlement of a full-price booking's invoice, so admitting it can never
    // under-charge the member; new bookings never mint a full-price intent, so the
    // leniency does not re-open the double-charge. The ledger read is skipped
    // entirely for a full-price capture.
    //
    // The manual path has no arriving amount to validate: it DERIVED the
    // effective price under the MEMBER-CREDIT lock in prepareManualSettlement,
    // asserted the mirror there, and refused a figure that had moved since the
    // admin's dialog rendered.
    if (
      settlement.kind === "stripe" &&
      settlement.amountCents !== booking.finalPriceCents
    ) {
      const appliedCreditCents = await deriveBookingAppliedCreditCents(
        booking.id,
        tx
      );
      if (settlement.amountCents !== booking.finalPriceCents - appliedCreditCents) {
        throw new Error("Payment amount does not match booking total");
      }
    }

    const capacity = await checkCapacityForGuestRanges(
      bookingLodgeId,
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      booking.id,
      tx
    );

    // Since #737/#738 a PENDING booking holds no capacity, so there is no
    // synchronous bump that could free a real bed. An all-member booking that
    // does not fit against committed bookings is cancelled-and-refunded here,
    // never bumped into a full lodge (issue #738, carried over from R1). The
    // non-member portion of a mixed party is now its own provisional booking.
    if (!capacity.available && bookingHasCapacityOverride(booking)) {
      // Persisted capacity override (#1771): this booking was deliberately
      // admitted above the ceiling by an admin. Settle it instead of cancelling
      // — fall through to the PAID update below.
      //
      // Whole-lodge hold (ADR-001, issue #118) is DELIBERATELY not enforced on
      // this settle path (and the other persisted-override settlements: cron-
      // confirm-pending, switch-to-internet-banking, charge-saved-method,
      // payment-link, xero-inbound invoice-paid-effects, group-settlement).
      // Those settle a PRE-EXISTING overridden booking; a hold may have been
      // placed over it AFTERWARDS. Per ADR-001 decision 1 (conflicts are
      // allowed, surfaced, and manually resolved — no auto-displacement/refusal)
      // an already-admitted booking is not a "new admission", so auto-refusing
      // it here would contradict decision 1. The hold blocks only NEW admissions
      // (decision 5), enforced at the admission choke points (booking-create,
      // date/modify-plan, and the admin allowOverbook routes force-confirm /
      // confirm-pending-guests / capacity-hold).
      logger.info(
        { bookingId: booking.id },
        "Settling an over-capacity booking with a persisted capacity override (#1771); skipping the capacity cancel"
      );
    }
    if (
      !capacity.available &&
      !bookingHasCapacityOverride(booking) &&
      settlement.kind === "manual"
    ) {
      // B5 (#2262), owner-decided 28 Jul: REFUSE, do not mirror the Stripe
      // path's cancel-and-refund. No in-system money fact exists yet — the
      // transaction throws, nothing is written, and the admin still holds the
      // cash — so refusal leaves zero debt, where a cancel-and-refund would
      // record a cancellation and then reach for Stripe machinery that cannot
      // hand back banknotes. The INVARIANT is unchanged: the same capacity
      // check runs at the same point under the same locks, so an unpaid-for
      // bed can never be admitted into a full or exclusively held lodge.
      throw new ManualBookingPaymentError(
        "This booking no longer fits the lodge — nothing was recorded; resolve capacity (or cancel the booking) before recording the payment.",
        409
      );
    }
    if (
      !capacity.available &&
      !bookingHasCapacityOverride(booking) &&
      settlement.kind === "stripe"
    ) {
      const { paymentIntentId, amountCents } = settlement;
      // Status-guarded void (#1881, defense in depth): claim the cancel only
      // while the booking is still in a payable state. Under lock(1) the
      // post-lock re-read already established that, so count 0 is a "cannot
      // happen" — but guarding the write means a concurrent status transition
      // that somehow slipped the lock can never be clobbered back to CANCELLED.
      const voided = await tx.booking.updateMany({
        where: { id: booking.id, status: { in: [...PAYABLE_SUCCESS_STATUS_LIST] } },
        data: {
          status: BookingStatus.CANCELLED,
          draftExpiresAt: null,
          ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
          // Best-effort field clearing (#177): this settlement capacity-cancel
          // has no per-booking audit context, so it mirrors the capacity-hold
          // sibling — clear the stale hold, no released audit. NB this is the
          // NON-override branch; the documented decision-1 carve-out settlement
          // (the override branch above) is untouched.
          ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
        },
      });
      if (voided.count === 0) {
        throw new Error(
          "Booking status changed concurrently during the capacity-failed void (#1881)"
        );
      }
      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      await restoreCreditFromBooking(booking.memberId, booking.id, tx);

      // Durable refund debt, ATOMIC with the cancel claim (mirrors the #1349
      // enqueue-then-execute pattern in booking-cancel): freeze the refund
      // allocation from this locked read and persist the recovery operation
      // BEFORE any Stripe call. A transient inline refund failure below — or
      // a process death between this commit and the refund — now leaves a
      // PENDING operation the recovery cron replays with backoff, instead of
      // the member's full charge stranded on a CANCELLED booking with only a
      // best-effort alert email as remediation. The frozen plan makes
      // inline-vs-cron replay exactly-once: both execute identical slices, so
      // both mint identical `capacity_claim_failed_<bookingId>_<pi>_<txn>_
      // <amount>` Stripe keys, Stripe answers repeats with the original
      // refunds, and the ledger dedupes on refund id.
      const { slices: refundPlan, plannedAmountCents: plannedRefundCents } =
        await planStripeRefundAllocation({
          paymentId: payment.id,
          amountCents,
          store: tx,
        });
      if (plannedRefundCents > 0) {
        await enqueueCapacityClaimFailedRefundRecovery({
          bookingId: booking.id,
          paymentId: payment.id,
          paymentIntentId,
          amountCents: plannedRefundCents,
          allocationPlan: refundPlan,
          store: tx,
        });
      }

      return {
        outcome: "capacity_failed" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
        refundPlan,
        plannedRefundCents,
      };
    }

    // B5 (#2262) — the manual settlement's own claim, and the analogue of the
    // subscription fence. Every guard-2 refusal condition that CAN be expressed
    // as a WHERE is re-asserted here, so an invoice minted (or a group
    // settlement flipped) between the read above and this write yields count 0
    // -> 409 rather than a double-apply. One clock read is shared by the
    // provenance columns, the audit row and the member's receipt.
    const manualSettledAt = new Date();
    if (settlement.kind === "manual") {
      const fenced = await tx.payment.updateMany({
        where: {
          id: payment.id,
          xeroInvoiceId: null,
          xeroRefundCreditNoteId: null,
          manuallyMarkedPaidAt: null,
          // M6 (#2262): the settled-FROM statuses, matching STATE_MACHINES.md.
          // PENDING/PROCESSING are the ordinary unsettled shapes; FAILED is a
          // legitimate settle-from too (a declined/expired card attempt is
          // exactly the case an admin remedies with cash at the lodge).
          // SUCCEEDED / (PARTIALLY_)REFUNDED can never be flipped here: an
          // already-settled or refund-bearing payment must refuse, not be
          // clobbered to a manual SUCCEEDED at a new amount.
          status: {
            in: [
              PaymentStatus.PENDING,
              PaymentStatus.PROCESSING,
              PaymentStatus.FAILED,
            ],
          },
          // L7: no refund history (re-asserting the read-time refusal).
          refundedAmountCents: 0,
          transactions: { none: { xeroInvoiceId: { not: null } } },
          booking: { organiserSettled: false },
        },
        data: {
          status: PaymentStatus.SUCCEEDED,
          // Guard 4: no new PaymentSource member. A manual settlement IS an
          // internet-banking payment as far as every two-way branch in the
          // codebase is concerned (refund method coercion, refund planning,
          // the reconciler); its manual-ness lives in the provenance columns.
          source: PaymentSource.INTERNET_BANKING,
          amountCents: settlementAmountCents,
          creditAppliedCents: mirrorCreditAppliedCents,
          manuallyMarkedPaidAt: manualSettledAt,
          manuallyMarkedPaidByMemberId: settlement.actingAdminMemberId,
          manualPaymentNote: settlement.note,
          manuallyMarkedPaidPreviousStatus: booking.status,
        },
      });
      if (fenced.count === 0) {
        throw new ManualBookingPaymentError(
          "This booking's payment changed while you were recording it — refresh and try again.",
          409
        );
      }
    }

    // Status-guarded PAID claim (#1881, defense in depth alongside lock(1)):
    // only settle a still-payable booking. Under lock(1) count 0 cannot happen
    // (the re-read above already gated on this), but the guard means a cancel
    // that somehow raced past the lock cannot be resurrected to PAID.
    const claimed = await tx.booking.updateMany({
      where: { id: booking.id, status: { in: [...PAYABLE_SUCCESS_STATUS_LIST] } },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
      },
    });
    if (claimed.count === 0) {
      throw new Error(
        "Booking status changed concurrently during the PAID claim (#1881)"
      );
    }

    // #2265 (#2319). This is the single settle door every card path funnels
    // through — the Stripe webhook, the session confirm, the public payment
    // link, the saved-card charge and the auto-confirm cron — and by the time it
    // runs, the money has been captured for the amount the intent was minted at.
    // A stored credit election can therefore no longer be honoured: applying it
    // now would debit the member's balance for cash already taken, which invents
    // a charge rather than honouring a choice. So clear it, and never leave a
    // PAID booking advertising an election nothing will act on.
    //
    // Nearly always a no-op, and that is the point. Every minter of a primary
    // intent either consumes the election first (the pay step, whose consumption
    // is what makes the intent smaller) or cannot reach a booking that carries
    // one (the payment link now refuses such a booking outright;
    // charge-saved-method requires PENDING, a status no election carrier is ever
    // in). Guarding HERE rather than in each of those callers means the invariant
    // "no settled booking carries a stored election" holds by construction at the
    // point of settlement, instead of resting on the provenance of five callers
    // staying true — which is exactly the kind of incidental safety that quietly
    // stops being safe.
    //
    // Guarded claim on the exact amount read, so a pay-step consumer racing this
    // writer is never clobbered; see clearStaleCreditElection.
    const staleCreditElectionCents = await clearStaleCreditElection(tx, booking);

    await reconcileBedAllocationsForBooking({
      bookingId: booking.id,
      db: tx,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    if (settlement.kind === "manual") {
      // Stripe-intent hygiene, belt-and-braces under guard 3. The member may
      // still hold a live /pay client secret for this booking; once the club
      // has the cash, that intent must not capture. Durable CANCEL_PAYMENT_INTENT
      // recovery operations are enqueued here, ATOMIC with the settlement and
      // BEFORE any Stripe call (the #1349 pattern, byte-for-byte the shape
      // booking-cancel uses); the best-effort Stripe cancel runs after commit.
      // If an intent captures first anyway, the widened duplicate-capture
      // predicate above auto-refunds it.
      const outstandingIntentIds =
        await enqueueManualSettlementIntentCancellations(tx, {
          bookingId: booking.id,
          paymentId: payment.id,
        });

      await createAuditLog(
        {
          action: "booking-payment.manual-payment.mark-paid",
          memberId: settlement.actingAdminMemberId,
          actorMemberId: settlement.actingAdminMemberId,
          subjectMemberId: booking.memberId,
          targetId: booking.id,
          entityType: "Payment",
          entityId: payment.id,
          category: "payment",
          severity: "important",
          outcome: "success",
          summary: "Booking payment manually marked paid (cash / off-Xero)",
          details: settlement.note,
          metadata: {
            bookingId: booking.id,
            paymentId: payment.id,
            effectiveAmountCents: settlementAmountCents,
            creditAppliedCents: mirrorCreditAppliedCents,
            previousStatus: booking.status,
            hasXeroInvoiceLink: false,
            cancelledPaymentIntentIds: outstandingIntentIds,
            // #2260 honesty rule: record the email decision BOTH ways, so a
            // reader can tell "chose not to email" from "no choice was offered".
            notifyMember: settlement.notifyMember,
          },
        },
        tx
      );

      return {
        outcome: "manual_paid" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
        effectiveAmountCents: settlementAmountCents,
        creditAppliedCents: mirrorCreditAppliedCents,
        previousStatus: booking.status,
        settledAt: manualSettledAt,
        outstandingIntentIds,
      };
    }

    return {
      outcome: "paid" as const,
      booking,
      paymentId: payment.id,
      bumpedBookingIds: [] as string[],
      staleCreditElectionCents,
    };
}

export async function markBookingPaymentSucceeded({
  bookingId,
  paymentIntentId,
  amountCents,
  paymentMethodId,
}: {
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId: string | null;
}): Promise<MarkBookingPaymentSucceededResult> {
  const reconciliation = await prisma.$transaction((tx) =>
    settleBookingPaymentInTransaction(tx, bookingId, {
      kind: "stripe",
      paymentIntentId,
      amountCents,
      paymentMethodId,
    })
  );

  if (reconciliation.outcome === "manual_paid") {
    // Unreachable: the Stripe settlement source never produces it. Narrowing
    // only, so the branches below keep their exact shapes.
    throw new Error("Unexpected manual settlement outcome on the Stripe path");
  }

  if (
    reconciliation.outcome === "paid" &&
    reconciliation.staleCreditElectionCents != null
  ) {
    // #2265 (#2319). Post-commit, outside the transaction: the member paid the
    // full price while holding credit they had asked to spend, so say so on
    // their booking history and put it in front of an operator who can decide
    // whether to refund the difference. Their balance is untouched either way.
    await reportUnappliedCreditElection({
      bookingId,
      memberId: reconciliation.booking.memberId,
      memberFirstName: reconciliation.booking.member.firstName,
      memberLastName: reconciliation.booking.member.lastName,
      checkIn: reconciliation.booking.checkIn,
      checkOut: reconciliation.booking.checkOut,
      electionCents: reconciliation.staleCreditElectionCents,
      paidAmountCents: amountCents,
      source: "payment-reconciliation",
      reference: paymentIntentId,
      extraDetails: { paymentIntentId },
    });
  }

  if (reconciliation.outcome === "paid") {
    // Single durable "paid" fact for every payment path (session, webhook,
    // payment link, cron auto-charge). A provisional non-member child booking
    // (parentBookingId set) is recorded as confirmed/charged; everything else
    // is the member paying up front (issue #740).
    await recordBookingEvent({
      bookingId,
      type: reconciliation.booking.parentBookingId
        ? BookingEventType.NON_MEMBER_CONFIRMED
        : BookingEventType.MEMBER_PAID,
      actorMemberId: reconciliation.booking.memberId,
      amountCents,
    });
  }

  if (reconciliation.outcome === "duplicate_capture") {
    // #1992 — the arriving capture is duplicate money on a booking already
    // settled by a different intent. The durable refund debt committed with
    // the transaction above; everything below is the inline attempt at the
    // same frozen slice, executed OUTSIDE any database transaction. Loud on
    // purpose: money is moving automatically.
    const { refundPlan, plannedRefundCents, settledPaymentIntentId } =
      reconciliation;
    logger.error(
      {
        bookingId,
        duplicatePaymentIntentId: paymentIntentId,
        settledPaymentIntentId,
        refundCents: plannedRefundCents,
      },
      "Duplicate Stripe capture on an already-paid booking (#1992); auto-refunding the duplicate capture"
    );

    // #2008 — a durable, ADMIN-ONLY BookingEvent IS recorded for this refund
    // once its recovery operation reaches SUCCEEDED (see below), but it is a
    // REFUNDED event carrying the `duplicate_capture_refund` discriminator so
    // resolveBookingNarrative EXCLUDES it (isDuplicateCaptureRefundEvent) and
    // it can never masquerade as the settlement clause of a LATER member
    // cancellation. The rest of the audit trail is unchanged: the
    // PaymentRecoveryOperation row, the PaymentRefund ledger entries, this log
    // line and the admin alert below.
    try {
      await refundPaymentTransactions({
        paymentId: reconciliation.paymentId,
        amountCents: plannedRefundCents,
        reason: "requested_by_customer",
        allocation: refundPlan,
        // Shared with the recovery cron's replay (via
        // bookingModificationRefundReasonForKeyPrefix) so the two send a
        // byte-identical request body under the same
        // `duplicate_capture_refund_<bookingId>_<paymentIntentId>` key prefix
        // — Stripe replays the original refund instead of rejecting the
        // reused key with idempotency_error.
        metadata: buildBookingModificationRefundMetadata(
          bookingId,
          "duplicate_capture"
        ),
        idempotencyKeyPrefix: buildDuplicateCaptureRefundStripeKeyPrefix(
          bookingId,
          paymentIntentId
        ),
      });

      // Happy-path close of the pre-persisted operation. Best-effort: a lost
      // close leaves a PENDING row whose replay re-requests the identical
      // slice/keys, which Stripe answers with the original refund.
      const markResult = await markDuplicateCaptureRefundRecoverySucceeded({
        bookingId,
        paymentIntentId,
      }).catch((markErr) => {
        logger.error(
          { err: markErr, bookingId, paymentIntentId },
          "Failed to mark duplicate-capture refund recovery succeeded; the cron will replay the frozen plan idempotently"
        );
        return null;
      });

      // #2008 — record the admin-only history event EXACTLY ONCE, gated on this
      // call being the one that flipped the operation to SUCCEEDED (count > 0).
      // If the mark was lost or the cron already closed the operation, this
      // path records nothing and the cron-replay path owns the event, so the
      // inline and cron paths never double-record. Post-commit, base client.
      if (markResult && markResult.count > 0) {
        await recordDuplicateCaptureRefundEvent({
          bookingId,
          amountCents: plannedRefundCents,
          duplicatePaymentIntentId: paymentIntentId,
          settledPaymentIntentId: settledPaymentIntentId ?? null,
        });
      }

      // Alert the admins even on success: an automatic refund of a duplicate
      // charge is an anomaly worth eyes, and the alert is the operator's cue
      // to check how the double capture happened. Dedicated template (#2007)
      // whose success variant states the duplicate was refunded in full.
      sendAdminDuplicateCaptureRefundAlert({
        memberName: `${reconciliation.booking.member.firstName} ${reconciliation.booking.member.lastName}`,
        checkIn: reconciliation.booking.checkIn,
        checkOut: reconciliation.booking.checkOut,
        amountCents: plannedRefundCents,
        paymentIntentId,
        settledPaymentIntentId: settledPaymentIntentId ?? null,
        operationReference: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
          bookingId,
          paymentIntentId
        ),
        refundFailed: false,
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, bookingId, paymentIntentId },
          "Failed to alert admins about the auto-refunded duplicate capture"
        )
      );

      return {
        outcome: "duplicate_capture_refunded",
        bookingId,
        bumpedBookingIds: [],
      };
    } catch (refundError) {
      // The refund debt already committed with the frozen slice, so nothing
      // needs enqueueing here: the recovery cron replays it with backoff and
      // alerts on exhaustion. Record the inline error for operator visibility
      // and alert immediately as well.
      logger.error(
        { err: refundError, bookingId, paymentIntentId },
        "Failed to auto-refund a duplicate capture; the pre-persisted recovery operation will replay the refund"
      );
      await recordDuplicateCaptureRefundRecoveryInlineError({
        bookingId,
        paymentIntentId,
        message:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
      }).catch((recordErr) =>
        logger.error(
          { err: recordErr, bookingId, paymentIntentId },
          "Failed to record inline duplicate-capture refund failure on the recovery operation"
        )
      );
      sendAdminDuplicateCaptureRefundAlert({
        memberName: `${reconciliation.booking.member.firstName} ${reconciliation.booking.member.lastName}`,
        checkIn: reconciliation.booking.checkIn,
        checkOut: reconciliation.booking.checkOut,
        amountCents: plannedRefundCents,
        paymentIntentId,
        settledPaymentIntentId: settledPaymentIntentId ?? null,
        operationReference: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
          bookingId,
          paymentIntentId
        ),
        errorMessage:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
        refundFailed: true,
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, bookingId, paymentIntentId },
          "Failed to alert admins about the failed duplicate-capture refund"
        )
      );

      return {
        outcome: "duplicate_capture_refund_failed",
        bookingId,
        bumpedBookingIds: [],
        refundError:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
      };
    }
  }

  if (reconciliation.outcome === "capacity_failed") {
    // Payment succeeded but the final capacity claim failed: the booking was
    // cancelled inside the transaction and is auto-refunded here (issue #740).
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: reconciliation.booking.memberId,
      amountCents,
      reason:
        "These dates filled up before payment could be secured, so the booking was cancelled and refunded.",
      snapshot: {
        policySummary:
          "These dates were no longer available when payment completed, so the full amount was refunded.",
        refundMethod: "card",
        refundPercentage: 100,
        paidAmountCents: amountCents,
        settledAmountCents: amountCents,
        retainedAmountCents: 0,
      },
    });

    // The refund debt was persisted INSIDE the claim transaction with the
    // frozen allocation plan (see the enqueue above): everything below is the
    // inline attempt at the same slices, and any failure leaves the PENDING
    // operation for the recovery cron — never a stranded charge that only an
    // alert email knows about.
    const { refundPlan, plannedRefundCents } = reconciliation;
    if (plannedRefundCents < amountCents) {
      // Mirror-vs-ledger drift (same guard as booking-cancel): refund what
      // the payment ledger actually shows refundable and surface the gap.
      logger.error(
        { bookingId, paymentIntentId, amountCents, plannedRefundCents },
        "Capacity-race refund plan covers less than the captured amount; refunding what the payment ledger shows refundable"
      );
    }

    try {
      if (refundPlan.length === 0 || plannedRefundCents <= 0) {
        throw new Error(
          "Capacity-race refund plan is empty: no captured Stripe transaction to refund"
        );
      }

      await refundPaymentTransactions({
        paymentId: reconciliation.paymentId,
        amountCents: plannedRefundCents,
        reason: "requested_by_customer",
        allocation: refundPlan,
        // Shared with the recovery cron's replay (via
        // bookingModificationRefundReasonForKeyPrefix) so the two send a
        // byte-identical request body under the same
        // `capacity_claim_failed_<bookingId>_<paymentIntentId>` key prefix —
        // Stripe replays the original refund instead of rejecting the reused
        // key with idempotency_error. The metadata deliberately carries only
        // values the cron can reconstruct from the persisted operation.
        metadata: buildBookingModificationRefundMetadata(
          bookingId,
          "capacity_claim_failed"
        ),
        idempotencyKeyPrefix: buildCapacityClaimFailedRefundStripeKeyPrefix(
          bookingId,
          paymentIntentId
        ),
      });

      // Happy-path close of the pre-persisted operation. Best-effort: a lost
      // close leaves a PENDING row whose replay re-requests the identical
      // slices/keys, which Stripe answers with the original refunds.
      await markCapacityClaimFailedRefundRecoverySucceeded({
        bookingId,
        paymentIntentId,
      }).catch((markErr) =>
        logger.error(
          { err: markErr, bookingId, paymentIntentId },
          "Failed to mark capacity-race refund recovery succeeded; the cron will replay the frozen plan idempotently"
        )
      );

      await recordBookingEvent({
        bookingId,
        type: BookingEventType.REFUNDED,
        actorMemberId: reconciliation.booking.memberId,
        amountCents,
        reason: "Automatic refund after lodge capacity was no longer available.",
      });

      return {
        outcome: "cancelled_refunded",
        bookingId,
        bumpedBookingIds: [],
      };
    } catch (refundError) {
      // The cancel claim already committed together with the recovery
      // operation, so nothing needs enqueueing here: the cron replays the
      // frozen plan with backoff and alerts on exhaustion. A partial success
      // has recorded its completed slices; the replay re-requests the SAME
      // slices/keys, so completed slices are replayed by Stripe, not
      // repeated, and only the remainder moves money. Record the inline
      // error on the operation and keep the immediate admin alert.
      logger.error(
        { err: refundError, bookingId, paymentIntentId },
        "Failed to auto-refund booking after final capacity claim failed; the pre-persisted recovery operation will replay the refund"
      );
      await recordCapacityClaimFailedRefundRecoveryInlineError({
        bookingId,
        paymentIntentId,
        message:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
      }).catch((recordErr) =>
        logger.error(
          { err: recordErr, bookingId, paymentIntentId },
          "Failed to record inline capacity-race refund failure on the recovery operation"
        )
      );
      await alertRefundFailure({
        booking: reconciliation.booking,
        paymentIntentId,
        amountCents,
        error: refundError,
      });

      return {
        outcome: "cancelled_refund_failed",
        bookingId,
        bumpedBookingIds: [],
        refundError:
          refundError instanceof Error ? refundError.message : String(refundError),
      };
    }
  }

  return {
    outcome: reconciliation.outcome,
    bookingId,
    bumpedBookingIds: reconciliation.bumpedBookingIds,
  };
}

export type ManualBookingSettlementResult = {
  bookingId: string;
  paymentId: string;
  effectiveAmountCents: number;
  creditAppliedCents: number;
  previousStatus: BookingStatus;
  settledAt: Date;
  /** Live Stripe intents this settlement queued a cancellation for. */
  outstandingIntentIds: string[];
  memberFirstName: string;
  memberEmail: string | null;
};

/**
 * B5 (#2262) — record a cash / off-Xero bank-transfer settlement for a booking.
 *
 * A SIBLING ENTRY POINT into the settlement core above, not a second settlement
 * path: it executes the same lock ordering, the same post-lock re-read, the
 * same capacity check with its #1771 override carve-out, the same status-fenced
 * PAID claim and the same bed reconciliation as a Stripe capture, diverging only
 * where a Stripe intent id is intrinsically involved.
 *
 * NEVER calls Xero and NEVER creates or voids an invoice; it refuses outright
 * when any Xero invoice evidence — including a queued mint — exists.
 */
export async function markBookingPaymentManuallySettled({
  bookingId,
  actingAdminMemberId,
  note,
  expectedAmountCents,
  notifyMember,
}: {
  bookingId: string;
  actingAdminMemberId: string;
  note: string | null;
  expectedAmountCents: number;
  notifyMember: boolean;
}): Promise<ManualBookingSettlementResult> {
  const reconciliation = await prisma.$transaction((tx) =>
    settleBookingPaymentInTransaction(tx, bookingId, {
      kind: "manual",
      actingAdminMemberId,
      note,
      expectedAmountCents,
      notifyMember,
    })
  );

  if (reconciliation.outcome !== "manual_paid") {
    // Unreachable: the manual settlement source produces exactly this outcome
    // or throws. Narrowing only.
    throw new Error(
      `Unexpected settlement outcome on the manual path: ${reconciliation.outcome}`
    );
  }

  // The single durable "paid" fact, recorded by the same helper and with the
  // same event types every other settlement path uses — with the ACTING ADMIN
  // as the actor, so the history says who recorded it.
  await recordBookingEvent({
    bookingId,
    type: reconciliation.booking.parentBookingId
      ? BookingEventType.NON_MEMBER_CONFIRMED
      : BookingEventType.MEMBER_PAID,
    actorMemberId: actingAdminMemberId,
    amountCents: reconciliation.effectiveAmountCents,
    reason: "manual_mark_paid",
    snapshot: {
      kind: "manual_mark_paid",
      actingAdminMemberId,
      note,
      effectiveAmountCents: reconciliation.effectiveAmountCents,
    },
  });

  // Best-effort Stripe cancels, OUTSIDE the transaction. The durable
  // CANCEL_PAYMENT_INTENT operations committed with the settlement, so a
  // failure here only means the recovery cron does the work instead.
  for (const paymentIntentId of reconciliation.outstandingIntentIds) {
    await cancelPaymentIntentIfCancellable(paymentIntentId).catch((err) =>
      logger.warn(
        { err, bookingId, paymentIntentId },
        "Manual mark-paid: best-effort Stripe intent cancel failed; the recovery cron will retry"
      )
    );
  }

  return {
    bookingId,
    paymentId: reconciliation.paymentId,
    effectiveAmountCents: reconciliation.effectiveAmountCents,
    creditAppliedCents: reconciliation.creditAppliedCents,
    previousStatus: reconciliation.previousStatus,
    settledAt: reconciliation.settledAt,
    outstandingIntentIds: reconciliation.outstandingIntentIds,
    memberFirstName: reconciliation.booking.member.firstName,
    memberEmail: reconciliation.booking.member.email ?? null,
  };
}

export type ManualBookingReversalResult = {
  bookingId: string;
  paymentId: string;
  previousStatus: BookingStatus;
  restoredStatus: BookingStatus;
  reversedAmountCents: number;
  closedRecoveryOperationIds: string[];
  clearedInternetBankingHold: boolean;
};

const MANUAL_REVERSAL_REFUSAL =
  "This payment can no longer be reversed — cancel the booking instead.";

/**
 * B5 (#2262) — reverse a manual mark-paid (direction "unpaid").
 *
 * Only ever permitted on a payment THIS feature marked paid, and only while
 * nothing has happened since that a reversal could not undo: no refund, no
 * settled Stripe money, no open hand-back task, and no Xero invoice or queued
 * mint acquired since the settle. Anything else is a cancellation, not a
 * reversal.
 *
 * HIGH #1 — the reversal DISARMS ITS OWN HYGIENE OPERATIONS. The mark-paid may
 * have queued CANCEL_PAYMENT_INTENT (and, via the cron's handoff,
 * REFUND_SUPERSEDED_PAYMENT) operations for a then-live intent X.
 * processCancelPaymentIntentOperation hands ANY succeeded intent to the refund
 * handoff with no booking-status check, so mark-paid -> reversal -> the
 * member's stale /pay tab captures X and legitimately settles the booking ->
 * the cron processes the now-stale cancel op would REFUND THE REAL SETTLEMENT,
 * leaving a PAID booking at zero net cash. Those operations must not outlive
 * the settlement they were minted to protect, so the reversal DELETES every
 * non-terminal one inside its own transaction (deletion, not a terminal
 * status flip: every webhook-side liveness predicate keys on
 * `status != SUCCEEDED`, so only a deleted row is invisible to all of them —
 * see the disarm comment in the body).
 *
 * The disarm is idempotent by construction: it is a status-fenced conditional
 * delete, so a replayed reversal deletes zero rows — and the reversal's own
 * fenced payment write has already 409'd by then. It can never close an
 * operation the reversal itself depends on: the reversal enqueues no recovery
 * work of its own and runs strictly after the settle whose operations it closes.
 */
export async function reverseManualBookingPayment({
  bookingId,
  actingAdminMemberId,
  note,
}: {
  bookingId: string;
  actingAdminMemberId: string;
  note: string | null;
}): Promise<ManualBookingReversalResult> {
  const reversal = await prisma.$transaction(async (tx) => {
    // Same two-tier ordering as the settlement body: global lock(1) first (this
    // moves booking status and money), then the per-lodge capacity lock,
    // because restoring a PAYMENT_PENDING booking RELEASES capacity.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });
    if (!lockTarget) {
      throw new ManualBookingPaymentError("Booking not found.", 404);
    }
    const bookingLodgeId = lockTarget.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true },
    });
    if (!booking) {
      throw new ManualBookingPaymentError("Booking not found.", 404);
    }
    const payment = booking.payment;
    if (!payment || !payment.manuallyMarkedPaidAt) {
      throw new ManualBookingPaymentError(
        "Only a manually recorded payment can be reversed here.",
        409
      );
    }
    if (booking.status !== BookingStatus.PAID) {
      throw new ManualBookingPaymentError(MANUAL_REVERSAL_REFUSAL, 409);
    }
    if (payment.refundedAmountCents !== 0) {
      throw new ManualBookingPaymentError(MANUAL_REVERSAL_REFUSAL, 409);
    }

    const refundRows = await tx.paymentRefund.count({
      where: { paymentId: payment.id },
    });
    if (refundRows > 0) {
      throw new ManualBookingPaymentError(MANUAL_REVERSAL_REFUSAL, 409);
    }

    const settledStripeTransaction = await tx.paymentTransaction.findFirst({
      where: {
        paymentId: payment.id,
        source: PaymentSource.STRIPE,
        status: {
          in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED],
        },
      },
      select: { id: true },
    });
    if (settledStripeTransaction) {
      throw new ManualBookingPaymentError(
        "A card payment has since settled this booking — reversing the manual record here would misstate the ledger.",
        409
      );
    }

    const openTask = await tx.manualRefundTask.findFirst({
      where: { paymentId: payment.id, status: "OPEN" },
      select: { id: true },
    });
    if (openTask) {
      throw new ManualBookingPaymentError(
        "There is an open manual refund task for this payment — resolve it before reversing the settlement.",
        409
      );
    }

    // Guard 2 again, for anything acquired SINCE the settle.
    await assertNoXeroInvoiceEvidence(tx, payment);

    // HIGH #1 — disarm, inside this transaction, before anything else is
    // written. The disarmed operations are DELETED, not flipped to a terminal
    // status: every webhook-side liveness predicate keys on
    // `status != SUCCEEDED` (queueSupersededPaymentIntentRefundRecovery,
    // listLiveSupersededIntentIds, findLiveSupersededIntentOperation), so a
    // FAILED "closed" row would still read as LIVE to all of them — a
    // post-reversal capture from a stale /pay tab would be handed to the
    // superseded-refund machinery (member charged, silently refunded, booking
    // never settles) and the intent id would sit in the duplicate-guard's
    // `notIn` exclusion forever. Deletion makes every one of those predicates
    // coherent at once, and it re-arms a later re-mark cleanly: the settle's
    // enqueue upsert finds no row and its CREATE arm fires with a fresh
    // PENDING status and nextRetryAt.
    //
    // Scope: every non-terminal CANCEL_PAYMENT_INTENT / REFUND_SUPERSEDED_
    // PAYMENT operation on this payment. That is exactly the set the settle
    // minted or adopted: the settle's own enqueue upserts on the shared
    // `payment_recovery_cancel_<txn>_<pi>` key, so a pre-existing cancel op
    // for a still-live intent IS the settle's op; and a member-owed
    // REFUND_SUPERSEDED_PAYMENT op can never be reached here, because the
    // handoff that creates one marks its transaction SUCCEEDED first and this
    // reversal already 409'd above on any settled Stripe transaction.
    //
    // The rows' full content is read first and preserved in the AuditLog
    // metadata and the reversal's BookingEvent snapshot (ids), so the audit
    // trail — not the queue — is where the closed operations live on.
    const doomedOperations = await tx.paymentRecoveryOperation.findMany({
      where: {
        paymentId: payment.id,
        type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
          ],
        },
      },
      select: {
        id: true,
        type: true,
        status: true,
        paymentIntentId: true,
        paymentTransactionId: true,
        amountCents: true,
        idempotencyKey: true,
        attempts: true,
        createdAt: true,
      },
    });
    // Status-fenced WRITE, idempotent by construction: a replayed reversal
    // deletes zero rows (and its own fenced payment write 409s). A worker that
    // already claimed one of these PROCESSING can no longer complete or hand
    // it off — its re-claim and its fenced completion both match nothing once
    // the row is gone (see handoffSucceededSupersededIntentToRefund /
    // completePaymentRecoveryOperation in payment-recovery.ts).
    await tx.paymentRecoveryOperation.deleteMany({
      where: {
        paymentId: payment.id,
        type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
          ],
        },
      },
    });

    // A stored DRAFT deliberately restores as PAYMENT_PENDING (owner-decided
    // 28 Jul). This is code-necessary, not taste: DRAFT is a payable status, so
    // a DRAFT booking CAN be settled, and the PAID claim cleared
    // `draftExpiresAt` — there is nothing left to restore, so a restored DRAFT
    // would be an expiry-less draft forever.
    const storedPreviousStatus =
      payment.manuallyMarkedPaidPreviousStatus ?? BookingStatus.PAYMENT_PENDING;
    const restoredStatus =
      storedPreviousStatus === BookingStatus.DRAFT
        ? BookingStatus.PAYMENT_PENDING
        : storedPreviousStatus;

    // IB hold-expiry carve-out. A restored CONFIRMED booking carrying an
    // already-passed internetBankingHoldUntil is exactly the shape
    // releaseExpiredInternetBankingHolds sweeps — the next cron run would
    // auto-cancel the booking and email the member minutes after a silent
    // reversal. Clear the deadline (rather than silently extending one the
    // member never agreed to): the booking keeps its beds with no expiry and an
    // admin must explicitly re-arm a hold if one is wanted.
    const clearInternetBankingHold =
      restoredStatus === BookingStatus.CONFIRMED &&
      payment.internetBankingHoldUntil !== null;

    const reversedPayment = await tx.payment.updateMany({
      where: {
        id: payment.id,
        manuallyMarkedPaidAt: { not: null },
        refundedAmountCents: 0,
      },
      data: {
        status: PaymentStatus.PENDING,
        // `source` is deliberately left as-is: the row is still an
        // internet-banking payment, it is simply no longer settled.
        manuallyMarkedPaidAt: null,
        manuallyMarkedPaidByMemberId: null,
        manualPaymentNote: null,
        manuallyMarkedPaidPreviousStatus: null,
        ...(clearInternetBankingHold ? { internetBankingHoldUntil: null } : {}),
      },
    });
    if (reversedPayment.count === 0) {
      throw new ManualBookingPaymentError(
        "This payment changed while you were reversing it — refresh and try again.",
        409
      );
    }

    const revertedBooking = await tx.booking.updateMany({
      where: { id: booking.id, status: BookingStatus.PAID },
      data: { status: restoredStatus },
    });
    if (revertedBooking.count === 0) {
      throw new ManualBookingPaymentError(
        "This booking changed while you were reversing the payment — refresh and try again.",
        409
      );
    }

    // History is preserved rather than deleted, and the row can never read
    // "unpaid (manual)". The settle mint's predicate deliberately skips FAILED
    // rows, so a later re-mark mints a FRESH row at the new amount instead of
    // resurrecting this one at a stale one.
    await tx.paymentTransaction.updateMany({
      where: {
        paymentId: payment.id,
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.INTERNET_BANKING,
        status: PaymentStatus.SUCCEEDED,
      },
      data: {
        status: PaymentStatus.FAILED,
        reason: "manual_mark_paid_reversed",
      },
    });

    // Releases the claimed beds only when the restore lands on
    // PAYMENT_PENDING; a restored CONFIRMED booking deliberately keeps holding
    // capacity, because that is what CONFIRMED means.
    await reconcileBedAllocationsForBooking({
      bookingId: booking.id,
      db: tx,
      previousRange: { checkIn: booking.checkIn, checkOut: booking.checkOut },
    });

    const closedRecoveryOperationIds = doomedOperations.map(
      (operation) => operation.id
    );
    // The deleted rows' content, preserved verbatim on the audit trail (the
    // queue row is gone by design — see the disarm above).
    const closedRecoveryOperations = doomedOperations.map((operation) => ({
      id: operation.id,
      type: operation.type,
      status: operation.status,
      paymentIntentId: operation.paymentIntentId,
      paymentTransactionId: operation.paymentTransactionId,
      amountCents: operation.amountCents,
      idempotencyKey: operation.idempotencyKey,
      attempts: operation.attempts,
      createdAt: operation.createdAt.toISOString(),
    }));

    await createAuditLog(
      {
        action: "booking-payment.manual-payment.mark-unpaid",
        memberId: actingAdminMemberId,
        actorMemberId: actingAdminMemberId,
        subjectMemberId: booking.memberId,
        targetId: booking.id,
        entityType: "Payment",
        entityId: payment.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "Manual booking payment reversed",
        details: note,
        metadata: {
          bookingId: booking.id,
          paymentId: payment.id,
          previousStatus: BookingStatus.PAID,
          storedPreviousStatus,
          restoredStatus,
          reversedAmountCents: payment.amountCents,
          closedRecoveryOperationIds,
          closedRecoveryOperations,
          clearedInternetBankingHold: clearInternetBankingHold,
          // #2260: a reversal never emails the member. Recorded under its own
          // key so a raw metadata render cannot be misread as an admin having
          // declined a choice they were never offered.
          notifyMemberOffered: false,
        },
      },
      tx
    );

    return {
      booking,
      paymentId: payment.id,
      storedPreviousStatus,
      restoredStatus,
      reversedAmountCents: payment.amountCents,
      closedRecoveryOperationIds,
      clearedInternetBankingHold: clearInternetBankingHold,
    };
  });

  // Recorded as a CANCELLED event carrying the reversal discriminator (#2008
  // pattern): durable and never pruned, rendered honestly on the admin
  // timeline, and EXCLUDED from the member/admin narrative so a later genuine
  // cancellation is not misdated by it.
  const reversalSnapshot: ManualSettlementReversalEventSnapshot = {
    kind: MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND,
    storedPreviousStatus: reversal.storedPreviousStatus,
    restoredStatus: reversal.restoredStatus,
    closedRecoveryOperationIds: reversal.closedRecoveryOperationIds,
    clearedInternetBankingHold: reversal.clearedInternetBankingHold,
    note,
  };
  await recordBookingEvent({
    bookingId,
    type: BookingEventType.CANCELLED,
    actorMemberId: actingAdminMemberId,
    amountCents: reversal.reversedAmountCents,
    reason: MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
    snapshot: reversalSnapshot as unknown as Prisma.InputJsonValue,
  });

  return {
    bookingId,
    paymentId: reversal.paymentId,
    previousStatus: BookingStatus.PAID,
    restoredStatus: reversal.restoredStatus,
    reversedAmountCents: reversal.reversedAmountCents,
    closedRecoveryOperationIds: reversal.closedRecoveryOperationIds,
    clearedInternetBankingHold: reversal.clearedInternetBankingHold,
  };
}

export async function markBookingSetupIntentSucceeded({
  bookingId,
  setupIntentId,
  paymentMethodId,
}: {
  bookingId: string;
  setupIntentId: string;
  paymentMethodId: string;
}) {
  await prisma.payment.update({
    where: { bookingId },
    data: {
      stripePaymentMethodId: paymentMethodId,
      stripeSetupIntentId: setupIntentId,
    },
  });
}
