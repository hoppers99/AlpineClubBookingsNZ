// Historical Xero object-link backfill: reconstructs canonical xeroObjectLink
// rows (and their bookkeeping BACKFILL_LINK operations) from the local
// canonical Xero id fields. Extracted verbatim from xero-hardening.ts (#1208
// item 5). Import xero source modules directly, never the @/lib/xero facade
// (#1208).
import { prisma } from "@/lib/prisma";
import {
  lockMemberForXeroContactLink,
  XeroMemberUnavailableError,
} from "@/lib/xero-contact-create-recovery";
import { buildXeroObjectUrl, stripXeroOrgShortCode } from "@/lib/xero-links";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import type {
  XeroHistoricalBackfillResult,
  XeroLinkBackfillCategoryResult,
} from "./xero-hardening-types";

const XERO_BACKFILL_OPERATION_TYPE = "BACKFILL_LINK";

interface CanonicalLinkTarget {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  role: string;
  metadata?: unknown;
  sourceField: string;
}

function buildBackfillCorrelationKey(target: CanonicalLinkTarget) {
  return [
    "xero-backfill",
    target.localModel,
    target.localId,
    target.role,
    target.xeroObjectType,
    target.xeroObjectId,
  ].join(":");
}

function buildLinkKey(target: {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  role: string;
}) {
  return [
    target.localModel,
    target.localId,
    target.xeroObjectType,
    target.xeroObjectId,
    target.role,
  ].join(":");
}

function buildBackfillOperationData(target: CanonicalLinkTarget, now: Date) {
  const correlationKey = buildBackfillCorrelationKey(target);

  return {
    direction: "OUTBOUND",
    entityType: target.xeroObjectType,
    operationType: XERO_BACKFILL_OPERATION_TYPE,
    localModel: target.localModel,
    localId: target.localId,
    status: "SUCCEEDED",
    idempotencyKey: correlationKey,
    correlationKey,
    attemptCount: 1,
    replayable: false,
    requestPayload: {
      source: "historical-canonical-xero-id-backfill",
      sourceField: target.sourceField,
      role: target.role,
    },
    responsePayload: {
      backfilled: true,
    },
    xeroObjectType: target.xeroObjectType,
    xeroObjectId: target.xeroObjectId,
    xeroObjectNumber: target.xeroObjectNumber ?? null,
    xeroObjectUrl:
      target.xeroObjectUrl ??
      buildXeroObjectUrl(target.xeroObjectType, target.xeroObjectId),
    createdByMemberId: null,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

async function backfillCanonicalLinkTargets(
  targets: CanonicalLinkTarget[]
): Promise<XeroLinkBackfillCategoryResult> {
  if (targets.length === 0) {
    return {
      scanned: 0,
      existingLinks: 0,
      createdLinks: 0,
      existingOperations: 0,
      createdOperations: 0,
    };
  }

  const existingLinks = await prisma.xeroObjectLink.findMany({
    where: {
      OR: targets.map((target) => ({
        localModel: target.localModel,
        localId: target.localId,
        xeroObjectType: target.xeroObjectType,
        xeroObjectId: target.xeroObjectId,
        role: target.role,
      })),
    },
    select: {
      localModel: true,
      localId: true,
      xeroObjectType: true,
      xeroObjectId: true,
      role: true,
    },
  });
  const existingLinkKeys = new Set(existingLinks.map(buildLinkKey));
  const linksToCreate = targets.filter(
    (target) => !existingLinkKeys.has(buildLinkKey(target))
  );

  const backfillOperationKeys = targets.map(buildBackfillCorrelationKey);
  const existingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      operationType: XERO_BACKFILL_OPERATION_TYPE,
      correlationKey: { in: backfillOperationKeys },
    },
    select: {
      correlationKey: true,
    },
  });
  const existingOperationKeys = new Set(
    existingOperations
      .map((operation) => operation.correlationKey)
      .filter((value): value is string => Boolean(value))
  );
  const now = new Date();
  const operationsToCreate = targets
    .filter((target) => !existingOperationKeys.has(buildBackfillCorrelationKey(target)))
    .map((target) => buildBackfillOperationData(target, now));

  // #2314: the backfill writes both columns in bulk, so it cannot go through
  // `upsertXeroObjectLink` / `completeXeroSyncOperation` — a per-row upsert is
  // the wrong shape for a `createMany({ skipDuplicates })` reconstruction of
  // thousands of historical rows. It carries the organisation-agnostic
  // invariant itself instead: the strip happens AT the write, where
  // `xero-object-url-write-guard.test.ts` can see it, not in the row builders.
  const createdLinks =
    linksToCreate.length > 0
      ? (
          await prisma.xeroObjectLink.createMany({
            data: linksToCreate.map((target) => ({
              localModel: target.localModel,
              localId: target.localId,
              xeroObjectType: target.xeroObjectType,
              xeroObjectId: target.xeroObjectId,
              xeroObjectNumber: target.xeroObjectNumber ?? null,
              xeroObjectUrl: stripXeroOrgShortCode(
                target.xeroObjectUrl ??
                  buildXeroObjectUrl(target.xeroObjectType, target.xeroObjectId),
              ),
              role: target.role,
              active: true,
              metadata: target.metadata ?? undefined,
            })),
            skipDuplicates: true,
          })
        ).count
      : 0;

  const createdOperations =
    operationsToCreate.length > 0
      ? (
          await prisma.xeroSyncOperation.createMany({
            data: operationsToCreate.map((operation) => ({
              ...operation,
              xeroObjectUrl: stripXeroOrgShortCode(operation.xeroObjectUrl),
            })),
            skipDuplicates: true,
          })
        ).count
      : 0;

  return {
    scanned: targets.length,
    existingLinks: targets.length - linksToCreate.length,
    createdLinks,
    existingOperations: targets.length - operationsToCreate.length,
    createdOperations,
  };
}

/**
 * Reconstruct one Member CONTACT link under the lifecycle-conflicting row lock.
 *
 * The caller's contact id comes from a lock-free census and is only a
 * candidate. Merge may delete the member and deletion may anonymise or relink
 * it before this short transaction starts. Re-read the canonical pointer under
 * `FOR UPDATE`, then commit the FK-less link and synthetic ledger together so
 * lifecycle teardown either follows this complete write or wins and this
 * writer creates nothing.
 */
export async function backfillMemberContactLink(
  memberId: string,
  expectedXeroContactId: string,
  db: typeof prisma = prisma,
): Promise<XeroLinkBackfillCategoryResult> {
  const target: CanonicalLinkTarget = {
    localModel: "Member",
    localId: memberId,
    xeroObjectType: "CONTACT",
    xeroObjectId: expectedXeroContactId,
    role: "CONTACT",
    sourceField: "Member.xeroContactId",
  };

  try {
    return await db.$transaction(async (tx) => {
      const locked = await lockMemberForXeroContactLink(tx, memberId);
      if (locked.xeroContactId !== expectedXeroContactId) {
        return {
          scanned: 1,
          existingLinks: 0,
          createdLinks: 0,
          existingOperations: 0,
          createdOperations: 0,
        };
      }

      const correlationKey = buildBackfillCorrelationKey(target);
      const [existingLink, existingOperation] = await Promise.all([
        tx.xeroObjectLink.findFirst({
          where: {
            localModel: target.localModel,
            localId: target.localId,
            xeroObjectType: target.xeroObjectType,
            xeroObjectId: target.xeroObjectId,
            role: target.role,
          },
          select: { id: true },
        }),
        tx.xeroSyncOperation.findFirst({
          where: {
            operationType: XERO_BACKFILL_OPERATION_TYPE,
            correlationKey,
          },
          select: { id: true },
        }),
      ]);

      if (!existingLink) {
        await upsertXeroObjectLink(
          {
            localModel: target.localModel,
            localId: target.localId,
            xeroObjectType: target.xeroObjectType,
            xeroObjectId: target.xeroObjectId,
            role: target.role,
          },
          { store: tx },
        );
      }
      if (!existingOperation) {
        const operation = buildBackfillOperationData(target, new Date());
        await tx.xeroSyncOperation.create({
          data: {
            ...operation,
            xeroObjectUrl: stripXeroOrgShortCode(operation.xeroObjectUrl),
          },
          select: { id: true },
        });
      }

      return {
        scanned: 1,
        existingLinks: existingLink ? 1 : 0,
        createdLinks: existingLink ? 0 : 1,
        existingOperations: existingOperation ? 1 : 0,
        createdOperations: existingOperation ? 0 : 1,
      };
    });
  } catch (error) {
    if (
      error instanceof XeroMemberUnavailableError ||
      (error instanceof Error && error.message === `Member not found: ${memberId}`)
    ) {
      return {
        scanned: 1,
        existingLinks: 0,
        createdLinks: 0,
        existingOperations: 0,
        createdOperations: 0,
      };
    }
    throw error;
  }
}

async function backfillMemberContactLinks(
  members: Array<{ id: string; xeroContactId: string | null }>,
): Promise<XeroLinkBackfillCategoryResult> {
  const result: XeroLinkBackfillCategoryResult = {
    scanned: 0,
    existingLinks: 0,
    createdLinks: 0,
    existingOperations: 0,
    createdOperations: 0,
  };
  for (const member of [...members].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!member.xeroContactId) continue;
    const memberResult = await backfillMemberContactLink(
      member.id,
      member.xeroContactId,
    );
    result.scanned += memberResult.scanned;
    result.existingLinks += memberResult.existingLinks;
    result.createdLinks += memberResult.createdLinks;
    result.existingOperations += memberResult.existingOperations;
    result.createdOperations += memberResult.createdOperations;
  }
  return result;
}

export async function backfillHistoricalXeroObjectLinks(): Promise<XeroHistoricalBackfillResult> {
  const [members, payments, subscriptions] = await Promise.all([
    prisma.member.findMany({
      where: {
        xeroContactId: {
          not: null,
        },
      },
      select: {
        id: true,
        xeroContactId: true,
      },
    }),
    prisma.payment.findMany({
      where: {
        OR: [
          {
            xeroInvoiceId: {
              not: null,
            },
          },
          {
            xeroRefundCreditNoteId: {
              not: null,
            },
          },
        ],
      },
      select: {
        id: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        xeroRefundCreditNoteId: true,
      },
    }),
    prisma.memberSubscription.findMany({
      where: {
        xeroInvoiceId: {
          not: null,
        },
      },
      select: {
        id: true,
        seasonYear: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        xeroOnlineInvoiceUrl: true,
      },
    }),
  ]);

  const memberResult = await backfillMemberContactLinks(members);

  const paymentInvoiceResult = await backfillCanonicalLinkTargets(
    payments.flatMap((payment) =>
      payment.xeroInvoiceId
        ? [
            {
              localModel: "Payment",
              localId: payment.id,
              xeroObjectType: "INVOICE",
              xeroObjectId: payment.xeroInvoiceId,
              xeroObjectNumber: payment.xeroInvoiceNumber ?? null,
              role: "PRIMARY_INVOICE",
              sourceField: "Payment.xeroInvoiceId",
            },
          ]
        : []
    )
  );

  const paymentRefundResult = await backfillCanonicalLinkTargets(
    payments.flatMap((payment) =>
      payment.xeroRefundCreditNoteId
        ? [
            {
              localModel: "Payment",
              localId: payment.id,
              xeroObjectType: "CREDIT_NOTE",
              xeroObjectId: payment.xeroRefundCreditNoteId,
              role: "REFUND_CREDIT_NOTE",
              sourceField: "Payment.xeroRefundCreditNoteId",
            },
          ]
        : []
    )
  );

  const subscriptionResult = await backfillCanonicalLinkTargets(
    subscriptions.flatMap((subscription) =>
      subscription.xeroInvoiceId
        ? [
            {
              localModel: "MemberSubscription",
              localId: subscription.id,
              xeroObjectType: "SUBSCRIPTION",
              xeroObjectId: subscription.xeroInvoiceId,
              xeroObjectNumber: subscription.xeroInvoiceNumber ?? null,
              xeroObjectUrl:
                buildXeroObjectUrl("SUBSCRIPTION", subscription.xeroInvoiceId) ?? null,
              role: "SUBSCRIPTION_INVOICE",
              metadata: {
                seasonYear: subscription.seasonYear,
                onlineInvoiceUrl: subscription.xeroOnlineInvoiceUrl ?? null,
              },
              sourceField: "MemberSubscription.xeroInvoiceId",
            },
          ]
        : []
    )
  );

  return {
    completedAt: new Date(),
    members: memberResult,
    paymentInvoices: paymentInvoiceResult,
    paymentRefundCreditNotes: paymentRefundResult,
    subscriptionInvoices: subscriptionResult,
    totals: {
      scanned:
        memberResult.scanned +
        paymentInvoiceResult.scanned +
        paymentRefundResult.scanned +
        subscriptionResult.scanned,
      createdLinks:
        memberResult.createdLinks +
        paymentInvoiceResult.createdLinks +
        paymentRefundResult.createdLinks +
        subscriptionResult.createdLinks,
      createdOperations:
        memberResult.createdOperations +
        paymentInvoiceResult.createdOperations +
        paymentRefundResult.createdOperations +
        subscriptionResult.createdOperations,
    },
  };
}
