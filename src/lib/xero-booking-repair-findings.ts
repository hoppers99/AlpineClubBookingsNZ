// Action and finding builders (including Xero amount-evidence mismatch
// detection and booking summary assembly) for the booking-vs-Xero repair tool.
// Extracted verbatim from xero-booking-repair.ts (#1208 item 2).
import type { XeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import type {
  BookingClassificationContext,
  BookingXeroRepairAction,
  BookingXeroRepairBookingSummary,
  MutableFinding,
  ResolvedLocalObject,
  XeroAmountEvidence,
  XeroObjectLinkRecord,
  XeroOperationRecord,
} from "./xero-booking-repair-types";
import { buildMemberName } from "./xero-booking-repair-analysis";
import {
  readStoredXeroAmountCents,
  toIsoDate,
} from "./xero-booking-repair-utils";
import { asRecord, readString } from "@/lib/xero-json";

export function addAction(
  actionMap: Map<string, BookingXeroRepairAction>,
  action: Omit<BookingXeroRepairAction, "status" | "resultMessage">
) {
  const existing = actionMap.get(action.key);
  if (existing) {
    return existing;
  }

  const nextAction: BookingXeroRepairAction = {
    ...action,
    status: action.type === "MARK_MANUAL_REVIEW" ? "manual_review" : "planned",
    resultMessage: null,
  };
  actionMap.set(action.key, nextAction);
  return nextAction;
}

export function addFinding(
  findings: MutableFinding[],
  input: MutableFinding
) {
  findings.push(input);
}

export function buildRetryAction(
  bookingId: string,
  operation: XeroOperationRecord,
  retryMeta: XeroOperationRetryMeta
) {
  return {
    key: `retry:${operation.id}`,
    bookingId,
    type: "REQUEUE_XERO_OPERATION" as const,
    description: `Requeue Xero operation ${operation.id} (${operation.entityType}/${operation.operationType}).`,
    safeToAutoApply: retryMeta.supported,
    payload: {
      operationId: operation.id,
    },
  };
}

export function buildManualReviewAction(bookingId: string, reason: string) {
  return {
    key: `manual:${bookingId}:${reason}`,
    bookingId,
    type: "MARK_MANUAL_REVIEW" as const,
    description: reason,
    safeToAutoApply: false,
    payload: {
      reason,
    },
  };
}

function collectXeroAmountEvidence(params: {
  resolved: ResolvedLocalObject;
  links: XeroObjectLinkRecord[];
  operations: XeroOperationRecord[];
  xeroObjectType: string;
  role: string;
  entityType: string;
  operationType: string;
}): XeroAmountEvidence[] {
  const evidence: XeroAmountEvidence[] = [];

  for (const link of params.links) {
    if (
      link.xeroObjectType !== params.xeroObjectType ||
      link.role !== params.role ||
      link.xeroObjectId !== params.resolved.objectId
    ) {
      continue;
    }

    const amountCents = readStoredXeroAmountCents(link.metadata);
    if (amountCents !== null) {
      evidence.push({
        source: "link",
        amountCents,
        linkId: link.id,
      });
    }
  }

  for (const operation of params.operations) {
    if (
      operation.entityType !== params.entityType ||
      operation.operationType !== params.operationType ||
      !["SUCCEEDED", "PARTIAL"].includes(operation.status) ||
      (operation.xeroObjectId && operation.xeroObjectId !== params.resolved.objectId)
    ) {
      continue;
    }

    const requestAmountCents = readStoredXeroAmountCents(operation.requestPayload);
    if (requestAmountCents !== null) {
      evidence.push({
        source: "operation-request",
        amountCents: requestAmountCents,
        operationId: operation.id,
      });
    }

    const responseAmountCents = readStoredXeroAmountCents(operation.responsePayload);
    if (responseAmountCents !== null) {
      evidence.push({
        source: "operation-response",
        amountCents: responseAmountCents,
        operationId: operation.id,
      });
    }
  }

  return evidence;
}

// #1427: recover the amount a Xero money object was actually enqueued or
// executed with. The policy-limited settlement a modification credit note
// carries is NOT reconstructable from the modification row (the
// cancellation-policy tier depended on days-until-check-in at modification
// time), so the stored ledger is the record of record — the enqueue-time
// operation payload first (#1356 queued-payload-first; replaying that amount
// also rebuilds the identical amount-embedding correlation key, keeping
// Xero-side dedup intact on a requeue), then link metadata, then an executed
// object's response totals. Unlike collectXeroAmountEvidence this reads
// operations in ANY status: a FAILED or CANCELLED attempt still records what
// the app decided the settlement was. When `payloadQueueType` is given, only
// operations whose payload carries that exact queueType count — a
// modification can hold BOTH an invoice-applied credit-note op and an
// account-credit-note op (same entityType/operationType, different amounts),
// and a payload too old or too bare to name its queueType is ambiguous
// between them, so it is skipped rather than guessed at.
export function recoverStoredXeroAmountCents(params: {
  links: XeroObjectLinkRecord[];
  operations: XeroOperationRecord[];
  xeroObjectType: string;
  role: string;
  entityType: string;
  operationType: string;
  objectId?: string | null;
  payloadQueueType?: string;
}): {
  amountCents: number;
  source: "operation-request" | "link" | "operation-response";
} | null {
  const operations = params.operations
    .filter(
      (operation) =>
        operation.entityType === params.entityType &&
        operation.operationType === params.operationType &&
        (!params.objectId ||
          !operation.xeroObjectId ||
          operation.xeroObjectId === params.objectId) &&
        (!params.payloadQueueType ||
          readString(asRecord(operation.requestPayload)?.queueType) ===
            params.payloadQueueType)
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  for (const operation of operations) {
    const amountCents = readStoredXeroAmountCents(operation.requestPayload);
    if (amountCents !== null) {
      return { amountCents, source: "operation-request" };
    }
  }

  for (const link of params.links) {
    if (
      link.xeroObjectType !== params.xeroObjectType ||
      link.role !== params.role ||
      (params.objectId ? link.xeroObjectId !== params.objectId : false)
    ) {
      continue;
    }

    const amountCents = readStoredXeroAmountCents(link.metadata);
    if (amountCents !== null) {
      return { amountCents, source: "link" };
    }
  }

  for (const operation of operations) {
    const amountCents = readStoredXeroAmountCents(operation.responsePayload);
    if (amountCents !== null) {
      return { amountCents, source: "operation-response" };
    }
  }

  return null;
}

export function addXeroAmountMismatchFinding(params: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  bookingId: string;
  expectedAmountCents: number;
  resolved: ResolvedLocalObject;
  links: XeroObjectLinkRecord[];
  operations: XeroOperationRecord[];
  xeroObjectType: string;
  role: string;
  entityType: string;
  operationType: string;
  summary: string;
  details: Record<string, unknown>;
}) {
  const evidence = collectXeroAmountEvidence({
    resolved: params.resolved,
    links: params.links,
    operations: params.operations,
    xeroObjectType: params.xeroObjectType,
    role: params.role,
    entityType: params.entityType,
    operationType: params.operationType,
  });
  const mismatches = evidence.filter(
    (item) => item.amountCents !== params.expectedAmountCents
  );

  if (mismatches.length === 0) {
    return;
  }

  const action = addAction(
    params.actionMap,
    buildManualReviewAction(params.bookingId, params.summary)
  );

  addFinding(params.findings, {
    code: "XERO_AMOUNT_MISMATCH",
    severity: "manual_review",
    summary: params.summary,
    safeToAutoApply: false,
    details: {
      ...params.details,
      xeroObjectType: params.xeroObjectType,
      xeroObjectId: params.resolved.objectId,
      expectedAmountCents: params.expectedAmountCents,
      evidence,
      mismatches,
    },
    actionKeys: [action.key],
  });
}

export function buildLinkRepairAction(params: {
  bookingId: string;
  localModel: "Payment" | "Booking" | "BookingModification";
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  role: string;
  description: string;
}): Omit<BookingXeroRepairAction, "status" | "resultMessage"> {
  return {
    key: `link:${params.localModel}:${params.localId}:${params.xeroObjectType}:${params.role}:${params.xeroObjectId}`,
    bookingId: params.bookingId,
    type: "SYNC_BOOKING_SCOPED_LINK",
    description: params.description,
    safeToAutoApply: true,
    payload: {
      localModel: params.localModel,
      localId: params.localId,
      xeroObjectType: params.xeroObjectType,
      xeroObjectId: params.xeroObjectId,
      xeroObjectNumber: params.xeroObjectNumber ?? null,
      xeroObjectUrl: params.xeroObjectUrl ?? null,
      role: params.role,
    },
  };
}

export function buildBookingSummary(
  context: BookingClassificationContext,
  findings: MutableFinding[],
  actionMap: Map<string, BookingXeroRepairAction>
): BookingXeroRepairBookingSummary {
  const actions = [...actionMap.values()];
  return {
    bookingId: context.booking.id,
    bookingStatus: context.booking.status,
    paymentId: context.booking.payment?.id ?? null,
    paymentStatus: context.booking.payment?.status ?? null,
    memberId: context.booking.memberId,
    memberName: buildMemberName(context.booking),
    memberEmail: context.booking.member.email,
    checkIn: toIsoDate(context.booking.checkIn),
    checkOut: toIsoDate(context.booking.checkOut),
    findings: findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      summary: finding.summary,
      safeToAutoApply: finding.safeToAutoApply,
      details: finding.details,
      actions: finding.actionKeys
        .map((actionKey) => actionMap.get(actionKey))
        .filter((action): action is BookingXeroRepairAction => Boolean(action)),
    })),
    actions,
  };
}
