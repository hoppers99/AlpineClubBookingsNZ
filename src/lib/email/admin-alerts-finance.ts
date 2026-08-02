import {
  adminPaymentFailureTemplate,
  adminDuplicateCaptureRefundTemplate,
  adminManualSettlementConflictTemplate,
  adminManualRefundTaskTemplate,
  adminXeroSyncErrorTemplate,
  adminXeroRepeatedFailureTemplate,
  adminXeroReconciliationReportTemplate,
  adminCreditSyncDriftTemplate,
  adminRefundRequestTemplate,
  type XeroReconciliationReportEmail,
  type CreditSyncDriftReportEmail,
} from "../email-templates";
import {
  composeOptionalEmailLine,
  duplicateCaptureRefundOutcomeParagraph,
} from "../email-message-notes";
import { CLUB_BOOKINGS_NAME } from "@/config/club-identity";
import { formatNZDate } from "../nzst-date";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { applyXeroOrgShortCode } from "@/lib/xero-links";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";
import { sendToAdmins } from "./admin-alerts-shared";

/**
 * Stamp the club's Xero organisation onto an outbound deep link, at SEND time
 * (#2314, owner decision 1 Aug 2026).
 *
 * The URLs reaching these alerts are organisation-agnostic: some are read
 * straight off a `XeroSyncOperation` / `XeroObjectLink` row, which #2314
 * deliberately keeps generic so a reconnect to a different Xero organisation
 * cannot leave stored links aimed at books the club no longer owns. A screen can
 * re-render and pick the current organisation up; an email cannot. So an email
 * is the surface that most needs the organisation named, and send time is the
 * last honest moment to name it — the alert is already a point-in-time snapshot
 * of everything else it reports.
 *
 * The organisation is CONFIRMED with Xero at send time rather than read from
 * the 12-hour cache (`confirmLive`, #2314 review). The cache is per process and
 * its invalidation only reaches the process that handled a reconnect, so a cron
 * or worker process can otherwise hold the previous organisation's short code
 * for hours — and an email stamped with it is stamped forever.
 *
 * Failure degrades, never blocks: no short code (Xero disconnected, the
 * organisation read failed, or Xero reported none) leaves the generic
 * `go.xero.com` link, which is live — it may just ask a multi-organisation
 * admin which organisation they meant. It also STRIPS any organisation the
 * stored URL already carried, so an unconfirmable organisation is never the one
 * an email points at.
 */
async function stampXeroOrganisation(
  url: string | null | undefined,
): Promise<string | null> {
  if (!url) return null;
  return applyXeroOrgShortCode(url, {
    shortCode: await getXeroOrgShortCode({ confirmLive: true }),
  });
}

// N-04: Admin alert - payment failure
export async function sendAdminPaymentFailureAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  errorMessage: string;
  paymentIntentId: string;
}) {
  await sendToAdmins({
    subject: `Payment Failed — ${CLUB_BOOKINGS_NAME}`,
    html: adminPaymentFailureTemplate(data),
    templateName: "admin-payment-failure",
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      amount: formatMoneyCents(data.amountCents),
    },
    preferenceKey: "adminPaymentFailure",
  });
}

// #1992 / #2007: Admin alert — duplicate-capture auto-refund. A second, distinct
// Stripe capture landed on a booking already settled by another intent, so the
// duplicate charge is auto-refunded. A DEDICATED template (not the generic
// payment-anomaly alert) so the copy states the real situation on each outcome.
// `refundFailed` selects the wording (one-template-with-boolean precedent, like
// adminSplitSettlementUnpaidTemplate's parentUnpaid). Gated by the same
// adminPaymentFailure preference as its siblings; NOT delivery-locked (the
// #1994 adjudication: no direct money loss from muting — the refund already
// happened or is durably queued for the recovery cron).
export async function sendAdminDuplicateCaptureRefundAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  paymentIntentId: string;
  settledPaymentIntentId: string | null;
  operationReference: string;
  errorMessage?: string | null;
  refundFailed: boolean;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;

  await sendToAdmins({
    subject: data.refundFailed
      ? `Duplicate capture auto-refund failed — retry queued: ${data.memberName}`
      : `Duplicate capture auto-refunded: ${data.memberName}`,
    html: adminDuplicateCaptureRefundTemplate({
      memberName: data.memberName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      amountCents: data.amountCents,
      paymentIntentId: data.paymentIntentId,
      settledPaymentIntentId: data.settledPaymentIntentId,
      operationReference: data.operationReference,
      errorMessage: data.errorMessage ?? null,
      reviewUrl,
      refundFailed: data.refundFailed,
    }),
    templateName: "admin-duplicate-capture-refund",
    templateData: {
      memberName: data.memberName,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      amount: formatMoneyCents(data.amountCents),
      paymentIntentId: data.paymentIntentId,
      operation: data.operationReference,
      errorMessage: data.errorMessage ?? "",
      // #2268: the outcome-dependent lead paragraph, built from the same
      // helper as the hand-built HTML, with the failure detail appended when
      // there is one. The flat body used to state the success wording
      // unconditionally and park the failure wording in an authoring note, so
      // an admin who saved that default was told a duplicate charge had been
      // refunded even when the refund had failed.
      refundOutcomeNote:
        duplicateCaptureRefundOutcomeParagraph(data.refundFailed) +
        (data.refundFailed && data.errorMessage
          ? " Failure detail: " + data.errorMessage
          : ""),
      reviewUrl,
      refundFailed: data.refundFailed,
    },
    preferenceKey: "adminPaymentFailure",
  });
}

/**
 * B5 (#2262): the reciprocal fence's alert. An inbound Xero PAID landed on a
 * booking this system already recorded as settled in cash / off-Xero, so the
 * club may be holding the same money twice. Admin audience, so it is exempt
 * from the per-booking "No emails" switch (#2258 rule 2) — that switch silences
 * the MEMBER, and an operator must still hear about unreconciled money.
 *
 * Repeat sends are throttled by the caller with a cross-instance
 * AlertCooldown claim keyed on (payment, invoice), so webhook replays re-count
 * the conflict without re-spamming.
 */
export async function sendAdminManualSettlementConflictAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  bookingId: string;
  bookingStatus: string;
  xeroInvoiceNumber: string | null;
  xeroInvoiceUrl: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const xeroInvoiceUrl = await stampXeroOrganisation(data.xeroInvoiceUrl);

  await sendToAdmins({
    subject: `Cash settlement vs Xero payment — reconcile: ${data.memberName}`,
    html: adminManualSettlementConflictTemplate({
      ...data,
      xeroInvoiceUrl,
      reviewUrl,
    }),
    templateName: "admin-manual-settlement-conflict",
    templateData: {
      memberName: data.memberName,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      amount: formatMoneyCents(data.amountCents),
      bookingId: data.bookingId,
      status: data.bookingStatus,
      xeroInvoiceNumber: data.xeroInvoiceNumber ?? "",
      xeroObjectUrl: xeroInvoiceUrl ?? "",
      reviewUrl,
    },
    preferenceKey: "adminPaymentFailure",
  });
}

/**
 * B5 (#2262): a cash-settled booking was cancelled, so the refund has to be
 * paid back by hand. Admin audience (exempt from the #2258 switch); the durable
 * ManualRefundTask row is the record, this is the nudge.
 */
export async function sendAdminManualRefundTaskAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  refundAmountCents: number;
  bookingId: string;
  reason: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;

  await sendToAdmins({
    subject: `Manual refund needed — cash booking cancelled: ${data.memberName}`,
    html: adminManualRefundTaskTemplate({ ...data, reviewUrl }),
    templateName: "admin-manual-refund-task",
    templateData: {
      memberName: data.memberName,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      refundAmount: formatMoneyCents(data.refundAmountCents),
      bookingId: data.bookingId,
      reason: data.reason,
      reviewUrl,
    },
    preferenceKey: "adminPaymentFailure",
  });
}

// N-05: Admin alert - Xero sync error
export async function sendAdminXeroSyncErrorAlert(data: {
  errorType: string;
  operation: string;
  errorMessage: string;
  timestamp: Date;
}) {
  await sendToAdmins({
    subject: `Xero Sync Error — ${CLUB_BOOKINGS_NAME}`,
    html: adminXeroSyncErrorTemplate(data),
    templateName: "admin-xero-sync-error",
    templateData: {
      ...data,
      timestamp: data.timestamp.toISOString(),
    },
    preferenceKey: "adminXeroSyncError",
  });
}

export async function sendAdminXeroRepeatedFailureAlert(data: {
  subject: string;
  correlationKey: string;
  failureCount: number;
  windowHours: number;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectUrl: string | null;
  latestErrorMessage: string | null;
  timestamp: Date;
}) {
  // #2314: the operation's stored `xeroObjectUrl` is organisation-agnostic, so
  // the club's organisation is stamped on here, at send time.
  const xeroObjectUrl = await stampXeroOrganisation(data.xeroObjectUrl);
  const stamped = { ...data, xeroObjectUrl };

  await sendToAdmins({
    subject: data.subject,
    html: adminXeroRepeatedFailureTemplate(stamped),
    templateName: "admin-xero-repeated-failure",
    templateData: {
      ...stamped,
      localModel: data.localModel ?? "",
      localId: data.localId ?? "",
      latestErrorMessage: data.latestErrorMessage ?? "",
      // #2268: pre-composed optional lines. Every one of these five values is
      // nullable, and the flat body has no conditional syntax, so each whole
      // line is built here or omitted entirely — the body used to carry
      // "OR Unavailable" and bare unclickable "Open local record" labels.
      localRecordNote: composeOptionalEmailLine(
        "Local Record",
        [data.localModel, data.localId].filter(Boolean).join(" "),
        { trailing: "\n" },
      ),
      latestErrorNote: composeOptionalEmailLine(
        "Latest Error",
        data.latestErrorMessage,
        { trailing: "\n" },
      ),
      xeroLinksNote: composeOptionalEmailLine(
        null,
        composeOptionalEmailLine("Open local record", data.localUrl, {
          trailing: "\n",
        }) +
          composeOptionalEmailLine("Open Xero object", xeroObjectUrl, {
            trailing: "\n",
          }),
      ),
      timestamp: data.timestamp.toISOString(),
    },
    preferenceKey: "adminXeroSyncError",
  });
}

/**
 * #2314: stamp the club's organisation onto every Xero link the reconciliation
 * report carries — issue items, repeated failures and unsupported partials all
 * render one, and each is either a stored (organisation-agnostic) URL or one
 * rebuilt from the object's type and id. ONE confirmed organisation read for
 * the whole report (see `stampXeroOrganisation` on why it is confirmed rather
 * than cached).
 *
 * A null short code is not an early return: `applyXeroOrgShortCode` strips in
 * that case, and a report is the surface where a legacy row still carrying a
 * previous organisation would be most durable. Every link degrades to the
 * generic form instead — live, just not organisation-scoped.
 */
async function stampXeroOrganisationOnReport(
  report: XeroReconciliationReportEmail,
): Promise<XeroReconciliationReportEmail> {
  const shortCode = await getXeroOrgShortCode({ confirmLive: true });

  const stamp = <T extends { xeroObjectUrl?: string | null }>(item: T): T => ({
    ...item,
    xeroObjectUrl: applyXeroOrgShortCode(item.xeroObjectUrl, { shortCode }),
  });

  return {
    ...report,
    issueSections: report.issueSections?.map((section) => ({
      ...section,
      items: section.items.map(stamp),
    })),
    repeatedFailures: report.repeatedFailures.map(stamp),
    unsupportedPartials: report.unsupportedPartials.map(stamp),
  };
}

export async function sendAdminXeroReconciliationReportAlert(
  reportInput: XeroReconciliationReportEmail,
) {
  const report = await stampXeroOrganisationOnReport(reportInput);
  const subject =
    report.summary.issueCategoryCount === 0
      ? "Xero Reconciliation Report - clean"
      : `Xero Reconciliation Report - action needed: ${report.summary.issueCategoryCount} categor${report.summary.issueCategoryCount === 1 ? "y" : "ies"}, ${report.summary.issueTotalCount} item${report.summary.issueTotalCount === 1 ? "" : "s"}`;

  await sendToAdmins({
    subject,
    html: adminXeroReconciliationReportTemplate(report),
    templateName: "admin-xero-reconciliation-report",
    templateData: {
      generatedAt: report.generatedAt.toISOString(),
      lookbackHours: report.lookbackHours,
      stalePendingMinutes: report.stalePendingMinutes,
      issueCategoryCount: report.summary.issueCategoryCount,
      issueTotalCount: report.summary.issueTotalCount,
      count: report.summary.issueTotalCount,
    },
    preferenceKey: "adminXeroSyncError",
  });
}

/**
 * #2501: warn admins that BookingApp's stamped applied credit and Xero's live
 * invoice allocation have drifted, with the exact per-booking amount. The
 * checker (xero-credit-sync-checker.ts) only calls this when at least one drift
 * was found, so the content-only delivery default never suppresses a real
 * warning. The invoice deep links are org-agnostic, so stamp the club's Xero
 * organisation on at send time (#2314), one confirmed read for the whole report.
 */
export async function sendAdminCreditSyncDriftAlert(
  report: CreditSyncDriftReportEmail,
) {
  const shortCode = await getXeroOrgShortCode({ confirmLive: true });
  const stampedReport: CreditSyncDriftReportEmail = {
    ...report,
    drifts: report.drifts.map((drift) => ({
      ...drift,
      invoiceUrl: applyXeroOrgShortCode(drift.invoiceUrl, { shortCode }),
    })),
  };

  const driftCount = stampedReport.drifts.length;
  const subject = `Xero Credit Sync Drift — ${driftCount} booking${driftCount === 1 ? "" : "s"}, ${formatMoneyCents(stampedReport.totalDriftCents)} — ${CLUB_BOOKINGS_NAME}`;

  await sendToAdmins({
    subject,
    html: adminCreditSyncDriftTemplate(stampedReport),
    templateName: "admin-credit-sync-drift",
    templateData: {
      generatedAt: stampedReport.generatedAt.toISOString(),
      scannedBookings: String(stampedReport.scannedBookings),
      checkedBookings: String(stampedReport.checkedBookings),
      deferredBookings: String(stampedReport.deferredBookings),
      driftCount: String(driftCount),
      totalDrift: formatMoneyCents(stampedReport.totalDriftCents),
      count: String(driftCount),
    },
    preferenceKey: "adminXeroSyncError",
  });
}

export async function sendAdminRefundRequestAlert(data: {
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  reason: string;
  requestedAmountCents: number | null;
  paidAmountCents: number;
  refundedAmountCents: number;
}) {
  await sendToAdmins({
    subject: `Refund Appeal: ${data.memberName}`,
    html: adminRefundRequestTemplate(data),
    templateName: "admin-refund-request",
    templateData: {
      ...data,
      checkIn: formatNZDate(data.checkIn),
      checkOut: formatNZDate(data.checkOut),
      paidAmount: formatMoneyCents(data.paidAmountCents),
      refundedAmount: formatMoneyCents(data.refundedAmountCents),
      remainingAmount: formatMoneyCents(
        data.paidAmountCents - data.refundedAmountCents,
      ),
      requestedAmount:
        data.requestedAmountCents === null
          ? ""
          : formatMoneyCents(data.requestedAmountCents),
      // #2268: pre-composed optional line — an appeal that names no amount
      // must not print a dangling "Requested:".
      requestedAmountNote: composeOptionalEmailLine(
        "Requested",
        data.requestedAmountCents === null
          ? null
          : formatMoneyCents(data.requestedAmountCents),
        { trailing: "\n" },
      ),
    },
    preferenceKey: "adminRefundRequest",
  });
}
