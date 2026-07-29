import {
  adminPaymentFailureTemplate,
  adminDuplicateCaptureRefundTemplate,
  adminXeroSyncErrorTemplate,
  adminXeroRepeatedFailureTemplate,
  adminXeroReconciliationReportTemplate,
  adminRefundRequestTemplate,
  type XeroReconciliationReportEmail,
} from "../email-templates";
import {
  composeOptionalEmailLine,
  duplicateCaptureRefundOutcomeParagraph,
} from "../email-message-notes";
import { CLUB_BOOKINGS_NAME } from "@/config/club-identity";
import { formatNZDate } from "../nzst-date";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendToAdmins } from "./admin-alerts-shared";

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
  await sendToAdmins({
    subject: data.subject,
    html: adminXeroRepeatedFailureTemplate(data),
    templateName: "admin-xero-repeated-failure",
    templateData: {
      ...data,
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
          composeOptionalEmailLine("Open Xero object", data.xeroObjectUrl, {
            trailing: "\n",
          }),
      ),
      timestamp: data.timestamp.toISOString(),
    },
    preferenceKey: "adminXeroSyncError",
  });
}

export async function sendAdminXeroReconciliationReportAlert(
  report: XeroReconciliationReportEmail,
) {
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
