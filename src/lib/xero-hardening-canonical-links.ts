// Canonical Xero object-link cleanup: deactivates active canonical links whose
// local canonical field no longer points at them. Extracted verbatim from
// xero-hardening.ts (#1208 item 5). Import xero source modules directly, never
// the @/lib/xero facade (#1208).
//
// SOURCE-AWARE for payment refund credit notes (#2901): a `source: STRIPE`
// payment refunded in steps holds one active REFUND_CREDIT_NOTE link PER
// refund delta (INV-ADDPAY-020), so the scalar `Payment.xeroRefundCreditNoteId`
// is only "the latest note", never "the only note". Treating it as the sole
// canonical target made this cleanup deactivate live coverage, which the daily
// credit-reconciliation self-heal then rebuilt with ANOTHER provider document —
// an unbounded duplicate-note loop (a production payment accumulated 21
// alternating notes for one 100-cent refund). Stripe per-delta links are
// therefore exempt from single-canonical enforcement here, exactly as they are
// in `normalizePaymentRefundLinkWithClient` (xero-sync.ts). Non-Stripe payment
// sources still contract to a single refund note and keep the enforcement.
import { PaymentSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  CanonicalLinkExpectation,
  CanonicalLinkRecord,
  XeroCanonicalLinkCleanupResult,
} from "./xero-hardening-types";
import { buildCanonicalScopeKey } from "./xero-hardening-shared";

/**
 * The payment ids, among the given refund-note link owners, whose payment is
 * `source: STRIPE`. Queried from the LINKS' local ids rather than from the
 * canonical-field payment scan so a Stripe payment whose scalar pointer (and
 * even invoice pointer) is currently null still shields its per-delta links —
 * a null scalar previously produced "no expectation", which deactivated every
 * active note link for that payment. Shared by cleanup and the drift report.
 */
export async function findStripeSourcePaymentIds(
  paymentIds: string[]
): Promise<Set<string>> {
  if (paymentIds.length === 0) {
    return new Set();
  }
  const stripePayments = await prisma.payment.findMany({
    where: {
      id: { in: paymentIds },
      source: PaymentSource.STRIPE,
    },
    select: { id: true },
  });
  return new Set(stripePayments.map((payment) => payment.id));
}

/**
 * True when this active link is a Stripe per-delta refund credit note link,
 * which the multi-note contract (INV-ADDPAY-020) keeps active alongside its
 * siblings — single-canonical cleanup must not touch it. A REFUND_CREDIT_NOTE
 * link with the wrong xeroObjectType is malformed (the pipeline only writes
 * CREDIT_NOTE) and stays subject to cleanup, as does a link whose payment does
 * not exist or is not Stripe-sourced.
 */
export function isStripePerDeltaRefundCreditNoteLink(
  link: Pick<CanonicalLinkRecord, "localModel" | "localId" | "role" | "xeroObjectType">,
  stripePaymentIds: ReadonlySet<string>
): boolean {
  return (
    link.localModel === "Payment" &&
    link.role === "REFUND_CREDIT_NOTE" &&
    link.xeroObjectType === "CREDIT_NOTE" &&
    stripePaymentIds.has(link.localId)
  );
}

function getCanonicalCleanupCategory(
  link: Pick<CanonicalLinkRecord, "localModel" | "role">
): keyof XeroCanonicalLinkCleanupResult["byCategory"] {
  if (link.localModel === "Member" && link.role === "CONTACT") {
    return "memberContacts";
  }
  if (link.localModel === "Payment" && link.role === "PRIMARY_INVOICE") {
    return "paymentInvoices";
  }
  if (link.localModel === "Payment" && link.role === "REFUND_CREDIT_NOTE") {
    return "paymentRefundCreditNotes";
  }
  if (link.localModel === "MemberSubscription" && link.role === "SUBSCRIPTION_INVOICE") {
    return "subscriptionInvoices";
  }
  return "otherCanonicalLinks";
}

export async function cleanupStaleCanonicalXeroObjectLinks(): Promise<XeroCanonicalLinkCleanupResult> {
  const [members, payments, subscriptions, links] = await Promise.all([
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
        xeroInvoiceId: true,
      },
    }),
    prisma.xeroObjectLink.findMany({
      where: {
        active: true,
        OR: [
          {
            localModel: "Member",
            role: "CONTACT",
          },
          {
            localModel: "Payment",
            role: {
              in: ["PRIMARY_INVOICE", "REFUND_CREDIT_NOTE"],
            },
          },
          {
            localModel: "MemberSubscription",
            role: "SUBSCRIPTION_INVOICE",
          },
        ],
      },
      select: {
        id: true,
        localModel: true,
        localId: true,
        xeroObjectType: true,
        xeroObjectId: true,
        role: true,
      },
    }),
  ]);

  const expectations: CanonicalLinkExpectation[] = [
    ...members.flatMap((member) =>
      member.xeroContactId
        ? [
            {
              localModel: "Member",
              localId: member.id,
              role: "CONTACT",
              xeroObjectType: "CONTACT",
              xeroObjectId: member.xeroContactId,
            },
          ]
        : []
    ),
    ...payments.flatMap((payment) =>
      [
        payment.xeroInvoiceId
          ? {
              localModel: "Payment",
              localId: payment.id,
              role: "PRIMARY_INVOICE",
              xeroObjectType: "INVOICE",
              xeroObjectId: payment.xeroInvoiceId,
            }
          : null,
        payment.xeroRefundCreditNoteId
          ? {
              localModel: "Payment",
              localId: payment.id,
              role: "REFUND_CREDIT_NOTE",
              xeroObjectType: "CREDIT_NOTE",
              xeroObjectId: payment.xeroRefundCreditNoteId,
            }
          : null,
      ].filter((value): value is CanonicalLinkExpectation => value !== null)
    ),
    ...subscriptions.flatMap((subscription) =>
      subscription.xeroInvoiceId
        ? [
            {
              localModel: "MemberSubscription",
              localId: subscription.id,
              role: "SUBSCRIPTION_INVOICE",
              xeroObjectType: "SUBSCRIPTION",
              xeroObjectId: subscription.xeroInvoiceId,
            },
          ]
        : []
    ),
  ];

  const expectationByScope = new Map(
    expectations.map((expectation) => [
      buildCanonicalScopeKey(expectation),
      expectation,
    ])
  );
  // #2901: resolve payment sources from the LINKS, not from the canonical-field
  // payment scan above, so per-delta links survive even when the payment's
  // scalar pointers are null and it therefore has no expectation row.
  const stripePaymentIds = await findStripeSourcePaymentIds(
    Array.from(
      new Set(
        links
          .filter(
            (link) =>
              link.localModel === "Payment" && link.role === "REFUND_CREDIT_NOTE"
          )
          .map((link) => link.localId)
      )
    )
  );
  let preservedStripeRefundCreditNoteLinks = 0;
  const staleLinks = links.filter((link) => {
    // Stripe payments legitimately hold one ACTIVE refund note per refund
    // delta (INV-ADDPAY-020); the scalar pointer is only the latest of them.
    // Single-canonical enforcement is retained ONLY for sources whose contract
    // genuinely permits one note (#2901).
    if (isStripePerDeltaRefundCreditNoteLink(link, stripePaymentIds)) {
      preservedStripeRefundCreditNoteLinks += 1;
      return false;
    }

    const expectation = expectationByScope.get(buildCanonicalScopeKey(link));
    if (!expectation) {
      return true;
    }

    return (
      expectation.xeroObjectType !== link.xeroObjectType ||
      expectation.xeroObjectId !== link.xeroObjectId
    );
  });
  const staleLinkIds = staleLinks.map((link) => link.id);

  let deactivatedLinks = 0;
  if (staleLinkIds.length > 0) {
    const updateResult = await prisma.xeroObjectLink.updateMany({
      where: {
        id: {
          in: staleLinkIds,
        },
        active: true,
      },
      data: {
        active: false,
      },
    });
    deactivatedLinks = updateResult.count;
  }

  const byCategory: XeroCanonicalLinkCleanupResult["byCategory"] = {
    memberContacts: 0,
    paymentInvoices: 0,
    paymentRefundCreditNotes: 0,
    subscriptionInvoices: 0,
    otherCanonicalLinks: 0,
  };

  for (const link of staleLinks) {
    byCategory[getCanonicalCleanupCategory(link)] += 1;
  }

  return {
    completedAt: new Date(),
    scannedActiveLinks: links.length,
    keptActiveLinks: links.length - deactivatedLinks,
    deactivatedLinks,
    preservedStripeRefundCreditNoteLinks,
    byCategory,
    deactivatedLinkIds: staleLinkIds,
  };
}
