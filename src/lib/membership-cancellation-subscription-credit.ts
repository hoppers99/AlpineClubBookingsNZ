/**
 * What a membership cancellation will actually credit — and who else that
 * invoice still covers (#2400).
 *
 * ## The problem this exists to solve
 *
 * A family (or any billing group) is billed with ONE Xero invoice covering
 * everyone in it, and `xero-subscription-invoices.ts` writes that same
 * `xeroInvoiceId` onto every covered member's `MemberSubscription` row. The
 * cancellation credit note then credited `invoice.amountDue` — the invoice's
 * WHOLE remaining balance — so cancelling one child wiped the entire family's
 * bill, including the portion belonging to members who were staying. The club
 * lost that revenue silently: the invoice simply went to zero and nothing said
 * why.
 *
 * ## The owner's decision (31 Jul 2026, recorded on #2400)
 *
 * Credit the full balance **only when the leaving member is the last covered
 * member still with the club**. If anyone else the invoice covers is staying,
 * raise nothing automatically and tell the admin, who settles it deliberately in
 * Xero. Splitting the invoice per member was rejected: the invoice's lines are
 * one per FEE COMPONENT, not one per member (see the component snapshot in
 * `xero-subscription-invoices.ts`), so there is no honest per-member share to
 * credit — and a family fee is a fee for the family, which does not necessarily
 * shrink because one person left.
 *
 * ## Who counts as "still covered"
 *
 * Two records say who an invoice covers, and they are written in the same
 * transaction:
 *
 * 1. `MemberSubscription.xeroInvoiceId` — stamped on every covered member;
 * 2. the charge's `MembershipSubscriptionChargeCoverage` rows that are still
 *    ACTIVE (`releasedAt` is null) — the claim that says this member's season is
 *    already billed on this charge.
 *
 * Normally they agree. They can disagree: rows minted before coverage claims
 * existed carry only the first, and the void-release path
 * (`releaseVoidedSubscriptionInvoice`) runs per member, so a family invoice
 * observed VOIDED can briefly have one member released while the rest are still
 * linked. This module therefore takes the **union** of the two. A disagreement
 * means the covered set is not certain, and an uncertain answer must never be
 * the licence to wipe a balance: over-counting only ever means "do not credit
 * automatically", which an admin can undo by hand in Xero, whereas
 * under-counting destroys revenue silently — which is the whole defect.
 *
 * A covered member keeps the invoice alive unless they have themselves been
 * cancelled, which the app records as `Member.cancelledAt` being set (the same
 * predicate the admin member list uses for its "Cancelled" filter). Deliberately
 * NOT `active`: a member can be deactivated without being cancelled, and their
 * season membership is still billed on that invoice, so the money is still owed.
 * Cancelled-but-not-yet-archived members do not keep it alive, which is what
 * lets a whole family leave: each approval cancels one member, and the LAST one
 * approved finds nobody else live on the invoice and credits it in full.
 *
 * ## When the question is asked
 *
 * Every time, afresh, at the moment it is acted on — never snapshotted when the
 * cancellation was requested. A family's composition changes: members join,
 * leave, are rebilled, or are cancelled between a request being made, approved,
 * and the outbox draining. The only answer safe to act on is the one true at the
 * instant of the action, so the approval gate asks at approval and the credit
 * note asks again when it is about to be raised. Both call this module.
 *
 * ## Reads only the database
 *
 * No Xero call. The covered set and the members' lifecycle state are local
 * records, so the review queue can show this for a page of participants without
 * touching Xero's quota, and the credit-note path can decide to skip before it
 * authenticates.
 */

import { memberName } from "@/lib/member-serialization";
import type { MembershipCancellationSharedInvoiceNotice } from "@/lib/membership-cancellation-blocker-messages";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";

/**
 * Subscription states whose invoice a cancellation credits. The same rule
 * `createXeroMembershipCancellationCreditNote` applies before it raises the
 * note — a PAID subscription is never auto-refunded.
 */
export const MEMBERSHIP_CANCELLATION_CREDITABLE_SUBSCRIPTION_STATUSES = [
  "UNPAID",
  "OVERDUE",
] as const;

/** A member an invoice still covers, named so an admin can recognise them. */
export type MembershipCancellationCoveredMember = {
  memberId: string;
  name: string;
};

/**
 * What the cancellation of one member will do to their current-season
 * subscription invoice.
 */
export type MembershipCancellationSubscriptionCreditPlan = {
  subscriptionId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  /** Deep link to the invoice in Xero, for the admin who has to act on it. */
  xeroUrl: string;
  /**
   * Everyone else this invoice still covers whose membership has not been
   * cancelled. Empty means the leaver is the last one out.
   */
  sharedWith: MembershipCancellationCoveredMember[];
  /**
   * True when the cancellation will credit this invoice's full remaining
   * balance — i.e. `sharedWith` is empty. This is the ONE predicate the credit
   * note and the unpaid-invoice blocker must agree on: the blocker excludes an
   * invoice from its refusal exactly when this is true, so an invoice nobody is
   * going to credit can never be silently ignored (#2400, #2392).
   */
  creditsInFull: boolean;
};

function compareCoveredMembers(
  left: MembershipCancellationCoveredMember,
  right: MembershipCancellationCoveredMember,
): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return left.memberId < right.memberId ? -1 : 1;
}

/**
 * Members whose membership is still live, per subscription invoice id.
 *
 * Always returns an entry for every invoice asked about, so a caller can never
 * read "no key" as "nobody is covered".
 */
export async function loadLiveMembersCoveredBySubscriptionInvoices(
  invoiceIds: readonly string[],
): Promise<Map<string, MembershipCancellationCoveredMember[]>> {
  const uniqueInvoiceIds = [...new Set(invoiceIds)].filter(Boolean);
  const coveredByInvoiceId = new Map<
    string,
    MembershipCancellationCoveredMember[]
  >(uniqueInvoiceIds.map((invoiceId) => [invoiceId, []]));
  if (uniqueInvoiceIds.length === 0) return coveredByInvoiceId;

  const [subscriptions, coverage] = await Promise.all([
    prisma.memberSubscription.findMany({
      where: { xeroInvoiceId: { in: uniqueInvoiceIds } },
      select: { memberId: true, xeroInvoiceId: true },
    }),
    // The active coverage claim is the other half of the same fact. A charge
    // owns exactly one Xero invoice (`MembershipSubscriptionCharge.xeroInvoiceId`
    // is unique), so this cannot pull in a member billed on a different invoice.
    prisma.membershipSubscriptionChargeCoverage.findMany({
      where: {
        releasedAt: null,
        charge: { xeroInvoiceId: { in: uniqueInvoiceIds } },
      },
      select: { memberId: true, charge: { select: { xeroInvoiceId: true } } },
    }),
  ]);

  const memberIdsByInvoiceId = new Map<string, Set<string>>(
    uniqueInvoiceIds.map((invoiceId) => [invoiceId, new Set<string>()]),
  );
  for (const subscription of subscriptions) {
    if (!subscription.xeroInvoiceId) continue;
    memberIdsByInvoiceId
      .get(subscription.xeroInvoiceId)
      ?.add(subscription.memberId);
  }
  for (const row of coverage) {
    const invoiceId = row.charge.xeroInvoiceId;
    if (!invoiceId) continue;
    memberIdsByInvoiceId.get(invoiceId)?.add(row.memberId);
  }

  const memberIds = [
    ...new Set([...memberIdsByInvoiceId.values()].flatMap((set) => [...set])),
  ];
  if (memberIds.length === 0) return coveredByInvoiceId;

  const members = await prisma.member.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, firstName: true, lastName: true, cancelledAt: true },
  });
  const liveMemberById = new Map<string, MembershipCancellationCoveredMember>();
  for (const member of members) {
    // Cancelled members do not keep an invoice alive — see the module note.
    if (member.cancelledAt) continue;
    liveMemberById.set(member.id, {
      memberId: member.id,
      name: memberName(member),
    });
  }

  for (const [invoiceId, ids] of memberIdsByInvoiceId) {
    const live = [...ids]
      .map((memberId) => liveMemberById.get(memberId))
      .filter(
        (member): member is MembershipCancellationCoveredMember =>
          member !== undefined,
      )
      .sort(compareCoveredMembers);
    coveredByInvoiceId.set(invoiceId, live);
  }

  return coveredByInvoiceId;
}

/**
 * Everyone OTHER than the leaving member that this subscription invoice still
 * covers and whose membership has not been cancelled. Empty means the leaver is
 * the last one out and the invoice can be credited in full.
 */
export async function findOtherLiveMembersCoveredBySubscriptionInvoice(params: {
  invoiceId: string;
  leavingMemberId: string;
}): Promise<MembershipCancellationCoveredMember[]> {
  const covered = await loadLiveMembersCoveredBySubscriptionInvoices([
    params.invoiceId,
  ]);
  return (covered.get(params.invoiceId) ?? []).filter(
    (member) => member.memberId !== params.leavingMemberId,
  );
}

/**
 * Per member: the current-season subscription invoice their cancellation is
 * about to act on, and whether it will actually be credited.
 *
 * `null` for a member with nothing to credit — no current-season subscription,
 * one already PAID or never invoiced, or no linked Xero invoice. Every member
 * asked about gets an entry, so "no key" is never mistaken for "nothing to do".
 */
export async function loadMembershipCancellationSubscriptionCreditPlansByMemberId(
  memberIds: readonly string[],
  options: { nowMs?: number } = {},
): Promise<Map<string, MembershipCancellationSubscriptionCreditPlan | null>> {
  const uniqueMemberIds = [...new Set(memberIds)].filter(Boolean);
  const plansByMemberId = new Map<
    string,
    MembershipCancellationSubscriptionCreditPlan | null
  >(uniqueMemberIds.map((memberId) => [memberId, null]));
  if (uniqueMemberIds.length === 0) return plansByMemberId;

  // The season is read from NOW, which is the same moment the credit note's own
  // gate reads it. A member has at most one subscription per season
  // (`@@unique([memberId, seasonYear])`), so this yields at most one plan each.
  const seasonYear = getSeasonYear(new Date(options.nowMs ?? Date.now()));
  const subscriptions = await prisma.memberSubscription.findMany({
    where: {
      memberId: { in: uniqueMemberIds },
      seasonYear,
      status: {
        in: [...MEMBERSHIP_CANCELLATION_CREDITABLE_SUBSCRIPTION_STATUSES],
      },
      NOT: { xeroInvoiceId: null },
    },
    select: {
      id: true,
      memberId: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
    },
  });
  if (subscriptions.length === 0) return plansByMemberId;

  const coveredByInvoiceId = await loadLiveMembersCoveredBySubscriptionInvoices(
    subscriptions
      .map((subscription) => subscription.xeroInvoiceId)
      .filter((invoiceId): invoiceId is string => Boolean(invoiceId)),
  );

  for (const subscription of subscriptions) {
    const invoiceId = subscription.xeroInvoiceId;
    if (!invoiceId) continue;
    const sharedWith = (coveredByInvoiceId.get(invoiceId) ?? []).filter(
      (member) => member.memberId !== subscription.memberId,
    );
    plansByMemberId.set(subscription.memberId, {
      subscriptionId: subscription.id,
      invoiceId,
      invoiceNumber: subscription.xeroInvoiceNumber,
      xeroUrl: buildXeroInvoiceUrl(invoiceId),
      sharedWith,
      creditsInFull: sharedWith.length === 0,
    });
  }

  return plansByMemberId;
}

/**
 * The review queue's per-participant shared-invoice notice: present only where
 * the cancellation would credit an invoice that other, staying members are also
 * covered by — which is exactly the case where it now credits nothing.
 *
 * Every member asked about gets an entry, `null` meaning "nothing to say".
 */
export async function loadMembershipCancellationSharedInvoiceNoticesByMemberId(
  memberIds: readonly string[],
  options: { nowMs?: number } = {},
): Promise<Map<string, MembershipCancellationSharedInvoiceNotice | null>> {
  const plans =
    await loadMembershipCancellationSubscriptionCreditPlansByMemberId(
      memberIds,
      options,
    );

  return new Map(
    [...plans].map(([memberId, plan]) => [
      memberId,
      plan && !plan.creditsInFull
        ? {
            invoiceId: plan.invoiceId,
            invoiceNumber: plan.invoiceNumber,
            xeroUrl: plan.xeroUrl,
            sharedWith: plan.sharedWith.map((member) => ({
              memberId: member.memberId,
              name: member.name,
            })),
          }
        : null,
    ]),
  );
}
