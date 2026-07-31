/**
 * Unpaid-invoice blocker for membership cancellation approvals (#2392).
 *
 * ## Why this exists
 *
 * Approving a cancellation queues a Xero CONTACT ARCHIVE when
 * `xeroArchiveContactsOnCancellation` is on (`membership-cancellation-xero.ts`).
 * Archiving a contact that still owes the club money takes the contact out of
 * every Xero picker and stops new invoices, credit notes and payments being
 * raised against it — the accounts still need it. The pre-existing approval
 * blockers only looked at future bookings, so nothing stopped that. Since #2383
 * made organisation accounts cancellable this became likelier still, because an
 * organisation is usually the billing contact for its booking invoices rather
 * than just its own membership.
 *
 * The owner's decision (recorded on #2392) is to BLOCK the approval while
 * anything is owing, not merely to warn.
 *
 * ## What "unpaid" means here
 *
 * An invoice blocks when Xero says it is **AUTHORISED or SUBMITTED with an
 * amount still due**. That is the same "open invoice" definition the finance
 * dashboard already uses (`FINANCE_AGED_INVOICE_STATUSES`), so the club has one
 * meaning of "open" across the app, and it is what an operator means by "the
 * accounts still need this contact":
 *
 * - **DRAFT does not block.** A draft has never been issued, creates no
 *   obligation on either side, and does not appear in Xero's receivables. The
 *   app's own pipelines leave drafts around; blocking on them would refuse
 *   cancellations for no financial reason.
 * - **SUBMITTED blocks.** It is an issued invoice awaiting internal approval,
 *   with a real balance, and Xero ages it as a receivable.
 * - **VOIDED and DELETED never block.** They are cancelled documents with
 *   nothing due — and voiding is one of the three resolutions this blocker
 *   tells the approver to use.
 * - **PAID never blocks**, because Xero flips an invoice to PAID once payments
 *   and credit notes fully settle it, taking the amount due to zero.
 * - **A credit note that only partly offsets an invoice still blocks**, on the
 *   residual balance. Xero subtracts `AmountCredited` from `AmountDue` and
 *   leaves the invoice AUTHORISED while anything remains, and the residual is
 *   exactly what the accounts are still waiting for — so that, not the original
 *   total, is the figure shown to the approver.
 * - **Bills (ACCPAY) block too.** The question is "does the ledger still need
 *   this contact", which does not care which way the money flows: archiving a
 *   contact the club still owes is the same mistake.
 *
 * ## What is deliberately NOT counted
 *
 * The member's own current-season subscription invoice, when the cancellation
 * itself is about to credit it. `queueApprovedMembershipCancellationXeroOperations`
 * raises an allocated credit note against an UNPAID/OVERDUE subscription invoice
 * on approval — that is the documented refund policy. Counting it would deadlock
 * the single most common cancellation there is: the thing that clears the
 * invoice is the very approval being refused. The exclusion mirrors that queue's
 * own rule (current season, status UNPAID or OVERDUE, invoice linked) and is
 * applied per member, so one member's subscription invoice never excuses another
 * member who happens to share the same Xero contact.
 *
 * ## When the check runs at all
 *
 * Only when BOTH are true:
 *
 * 1. `xeroArchiveContactsOnCancellation` is ON. With it off, approval never
 *    archives anything — the contact and every invoice on it stay exactly as
 *    they are — so there is nothing to protect and blocking would be pure
 *    friction. It also means a Xero outage cannot stop cancellations at a club
 *    that chose not to archive.
 * 2. The member actually has a linked Xero contact. With none,
 *    `syncXeroMembershipCancellationContact` skips with
 *    `member_has_no_xero_contact` and no Xero object is touched, so a club that
 *    does not use Xero is never blocked and never triggers a Xero call.
 *
 * ## Fail-safe: an unknown answer BLOCKS
 *
 * If Xero cannot be asked — disconnected, rate limited, or unreachable — the
 * approval is refused with an `invoice_check_unavailable` blocker rather than
 * allowed through. "We could not find out" is not "nothing is owing", and the
 * two outcomes are not symmetrical: a refusal is temporary, reversible and
 * loses nothing (the request stays in the queue and approves the moment Xero
 * answers), whereas letting it through queues an archive that runs later,
 * silently, against a contact the accounts still need — found weeks afterwards
 * by whoever chases the debt. During a Xero outage the archive would fail and
 * sit in the outbox anyway, so waiting costs the club almost nothing.
 *
 * "Disconnected" and "temporarily unreachable" get different words because they
 * need different actions: a disconnected Xero needs an admin to reconnect it
 * (or to turn the archive setting off, which lifts the check honestly, since it
 * really does mean no contact will be archived), whereas an unreachable Xero
 * just needs another try in a few minutes. Either way the approver is never
 * stranded: turning the setting off is always an available, admin-controlled
 * route forward.
 */

import type { Invoice } from "xero-node";
import {
  toOptionalDateOnlyText,
  toOptionalText,
} from "@/lib/finance-sync-xero-datasets/date-format";
import {
  getInvoiceAmountDue,
  getInvoiceCurrency,
} from "@/lib/finance-sync-xero-datasets/invoice-helpers";
import logger from "@/lib/logger";
import type {
  MembershipCancellationInvoiceBlocker,
  MembershipCancellationInvoiceCheckUnavailableReason,
  MembershipCancellationUnpaidInvoiceBlocker,
} from "@/lib/membership-cancellation-blocker-messages";
import { loadMembershipCancellationSettings } from "@/lib/membership-cancellation-settings";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "@/lib/xero-api-client";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import { buildXeroContactUrl, buildXeroInvoiceUrl } from "@/lib/xero-links";

/**
 * The same "open invoice" statuses the finance dashboard ages
 * (`FINANCE_AGED_INVOICE_STATUSES`). One definition of open across the app.
 */
export const MEMBERSHIP_CANCELLATION_OPEN_INVOICE_STATUSES = [
  "AUTHORISED",
  "SUBMITTED",
] as const;

/** Subscription states whose invoice this approval is itself about to credit. */
const SELF_CREDITED_SUBSCRIPTION_STATUSES = ["UNPAID", "OVERDUE"] as const;

const XERO_PAGE_SIZE = 100;
/**
 * A contact with more than this many open invoices is emphatically blocked
 * already; the cap only stops a pathological contact from walking Xero forever
 * while an admin waits on a page render.
 */
const MAX_INVOICE_PAGES = 5;

/**
 * The review queue re-reads this on every page load, filter change and refresh.
 * A short in-process memo keeps that off Xero's quota, in the same spirit as the
 * connection probe's 45s cache. The approval guard passes `fresh` and never
 * reads it, so an approval is always decided on a live answer; a stale entry can
 * therefore only make the queue's advisory panel briefly out of date, never let
 * an approval through on stale data. Failures are never cached, so a transient
 * blip clears on the next attempt.
 */
const INVOICE_CHECK_CACHE_TTL_MS = 60_000;

type InvoiceCheckCacheEntry = {
  expiresAtMs: number;
  blockers: MembershipCancellationUnpaidInvoiceBlocker[];
};

/**
 * Keyed on the Xero contact id alone. Contact ids are per-tenant GUIDs, so a
 * collision across two tenants is not a real possibility, and the 60s TTL bounds
 * it regardless.
 */
const invoiceCheckCache = new Map<string, InvoiceCheckCacheEntry>();

/** test seam */
export function resetMembershipCancellationInvoiceBlockerCacheForTests(): void {
  invoiceCheckCache.clear();
}

export interface MembershipCancellationInvoiceBlockerOptions {
  /** Bypass and refresh the memo. The approval guard always sets this. */
  fresh?: boolean;
  /** Injectable clock, for the memo TTL and the current season year. */
  nowMs?: number;
}

/**
 * Classify why the check could not run. Name-keyed like the connection probe, so
 * the classification does not depend on `instanceof` surviving module mocking.
 */
export function classifyMembershipCancellationInvoiceCheckFailure(
  error: unknown,
): MembershipCancellationInvoiceCheckUnavailableReason {
  if (error instanceof Error) {
    if (error.name === "XeroDailyLimitError") {
      return "rate_limited";
    }
    if (
      error.name === "XeroReconnectRequiredError" ||
      // A stored token that no longer decrypts is a reconnect, not an outage.
      error.name === "XeroTokenDecryptError"
    ) {
      return "disconnected";
    }
  }

  const statusCode = getXeroErrorStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return "disconnected";
  }
  if (statusCode === 429) {
    return "rate_limited";
  }

  return "unavailable";
}

function normaliseContactKey(contactId: string): string {
  return contactId.trim().toLowerCase();
}

function toUnpaidInvoiceBlocker(
  invoice: Invoice,
): MembershipCancellationUnpaidInvoiceBlocker | null {
  const invoiceId = toOptionalText(invoice.invoiceID);
  if (!invoiceId) {
    return null;
  }
  const contactId = toOptionalText(invoice.contact?.contactID);

  const status = toOptionalText(invoice.status)?.toUpperCase() ?? "";
  // Belt and braces: the API call already filters by status, but a blocker that
  // can refuse a lifecycle action should not depend on a remote filter alone.
  if (
    !(MEMBERSHIP_CANCELLATION_OPEN_INVOICE_STATUSES as readonly string[]).includes(
      status,
    )
  ) {
    return null;
  }

  // getInvoiceAmountDue reports dollars, falling back to
  // total - paid - credited when Xero omits AmountDue. A part-allocated credit
  // note therefore leaves the residual here, and a fully settled invoice leaves
  // zero, which is not a blocker.
  const amountDueCents = Math.round(getInvoiceAmountDue(invoice) * 100);
  if (amountDueCents <= 0) {
    return null;
  }

  const direction =
    toOptionalText(invoice.type)?.toUpperCase() === "ACCPAY"
      ? "payable"
      : "receivable";

  return {
    type: "unpaid_invoice",
    invoiceId,
    invoiceNumber: toOptionalText(invoice.invoiceNumber),
    invoiceStatus: status,
    direction,
    amountDueCents,
    currency: getInvoiceCurrency(invoice),
    dueDate: toOptionalDateOnlyText(invoice.dueDate),
    // The deep-link path is the receivables one; a bill has no equivalent
    // helper, so it is left without a link rather than pointed somewhere wrong.
    xeroUrl: direction === "receivable" ? buildXeroInvoiceUrl(invoiceId) : null,
    // ...and the contact page picks up what the invoice link cannot: a bill, and
    // any invoice Xero never numbered. A treasurer cannot search Xero by GUID,
    // so without a link those rows name something they cannot find (#2392
    // review, H1).
    xeroContactUrl: contactId ? buildXeroContactUrl(contactId) : null,
  };
}

function compareInvoiceBlockers(
  left: MembershipCancellationUnpaidInvoiceBlocker,
  right: MembershipCancellationUnpaidInvoiceBlocker,
): number {
  const leftDue = left.dueDate ?? "9999-12-31";
  const rightDue = right.dueDate ?? "9999-12-31";
  if (leftDue !== rightDue) {
    return leftDue < rightDue ? -1 : 1;
  }
  const leftNumber = left.invoiceNumber ?? "";
  const rightNumber = right.invoiceNumber ?? "";
  if (leftNumber !== rightNumber) {
    return leftNumber < rightNumber ? -1 : 1;
  }
  return left.invoiceId < right.invoiceId ? -1 : 1;
}

/**
 * Fetch open invoices for a batch of Xero contacts. Throws on any Xero failure;
 * the caller classifies it. One batched call covers the whole review queue page,
 * because Xero's getInvoices takes a list of contact ids.
 */
async function loadOpenInvoicesByContactKey(
  contactIds: readonly string[],
  options: MembershipCancellationInvoiceBlockerOptions,
): Promise<Map<string, MembershipCancellationUnpaidInvoiceBlocker[]>> {
  const nowMs = options.nowMs ?? Date.now();
  const byContactKey = new Map<
    string,
    MembershipCancellationUnpaidInvoiceBlocker[]
  >();
  const contactIdsToFetch: string[] = [];

  for (const contactId of contactIds) {
    const key = normaliseContactKey(contactId);
    if (!options.fresh) {
      const cached = invoiceCheckCache.get(key);
      if (cached && cached.expiresAtMs > nowMs) {
        byContactKey.set(key, cached.blockers);
        continue;
      }
    }
    contactIdsToFetch.push(contactId);
  }

  if (contactIdsToFetch.length === 0) {
    return byContactKey;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const invoices: Invoice[] = [];

  for (let page = 1; page <= MAX_INVOICE_PAGES; page += 1) {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.getInvoices(
          tenantId,
          undefined, // ifModifiedSince
          undefined, // where — statuses below are the whole filter
          "DueDate ASC", // order
          undefined, // iDs
          undefined, // invoiceNumbers
          contactIdsToFetch, // contactIDs
          [...MEMBERSHIP_CANCELLATION_OPEN_INVOICE_STATUSES], // statuses
          page,
          false, // includeArchived
          false, // createdByMyApp
          undefined, // unitdp
          false, // summaryOnly
          XERO_PAGE_SIZE,
        ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: "membershipCancellationInvoiceBlockers",
        context: `membershipCancellationInvoiceBlockers(page ${page})`,
        // An admin is waiting on this, and a slow answer is worse than a
        // "try again" they can act on: fail fast into the unavailable branch
        // rather than sitting in callXeroApi's default two-minute rate-limit
        // wait while the review queue hangs.
        maxRetries: 1,
        maxWaitSec: 15,
      },
    );

    const pageInvoices = response.body.invoices ?? [];
    invoices.push(...pageInvoices);
    if (pageInvoices.length < XERO_PAGE_SIZE) {
      break;
    }
  }

  const fetched = new Map<
    string,
    MembershipCancellationUnpaidInvoiceBlocker[]
  >();
  for (const contactId of contactIdsToFetch) {
    fetched.set(normaliseContactKey(contactId), []);
  }

  for (const invoice of invoices) {
    const contactId = toOptionalText(invoice.contact?.contactID);
    if (!contactId) continue;
    const bucket = fetched.get(normaliseContactKey(contactId));
    if (!bucket) continue;
    const blocker = toUnpaidInvoiceBlocker(invoice);
    if (blocker) {
      bucket.push(blocker);
    }
  }

  const expiresAtMs = nowMs + INVOICE_CHECK_CACHE_TTL_MS;
  for (const [key, blockers] of fetched) {
    blockers.sort(compareInvoiceBlockers);
    invoiceCheckCache.set(key, { expiresAtMs, blockers });
    byContactKey.set(key, blockers);
  }

  return byContactKey;
}

/**
 * Per-member unpaid-invoice blockers. Always returns an entry for every member
 * asked about, so a caller can never mistake "no key" for "nothing owing".
 */
export async function loadMembershipCancellationInvoiceBlockersByMemberId(
  memberIds: readonly string[],
  options: MembershipCancellationInvoiceBlockerOptions = {},
): Promise<Map<string, MembershipCancellationInvoiceBlocker[]>> {
  const uniqueMemberIds = [...new Set(memberIds)].filter(Boolean);
  const blockersByMemberId = new Map<
    string,
    MembershipCancellationInvoiceBlocker[]
  >(uniqueMemberIds.map((memberId) => [memberId, []]));

  if (uniqueMemberIds.length === 0) {
    return blockersByMemberId;
  }

  // Gate 1: nothing is archived, so nothing is at risk. No Xero call at all,
  // which is also what keeps a Xero outage from blocking a club that has
  // deliberately turned archiving off.
  //
  // `loadMembershipCancellationSettings` falls back to the defaults (archiving
  // OFF) if its own read fails, so a database blip skips this check — but the
  // archive itself re-reads the same setting through the same loader when the
  // outbox operation runs, so a failure window that hides the check also hides
  // the archive. Both halves read one source of truth, which is what keeps them
  // from disagreeing.
  const settings = await loadMembershipCancellationSettings();
  if (!settings.xeroArchiveContactsOnCancellation) {
    return blockersByMemberId;
  }

  // Gate 2: no linked Xero contact means the contact operation skips with
  // `member_has_no_xero_contact` — there is no Xero object to endanger.
  const members = await prisma.member.findMany({
    where: { id: { in: uniqueMemberIds } },
    select: { id: true, xeroContactId: true },
  });
  const contactIdByMemberId = new Map<string, string>();
  for (const member of members) {
    if (member.xeroContactId) {
      contactIdByMemberId.set(member.id, member.xeroContactId);
    }
  }
  const memberIdsWithContact = [...contactIdByMemberId.keys()];
  if (memberIdsWithContact.length === 0) {
    return blockersByMemberId;
  }

  // The invoice this approval will itself credit, per member — see the module
  // note: counting it would deadlock the ordinary unpaid-subscription case.
  const seasonYear = getSeasonYear(new Date(options.nowMs ?? Date.now()));
  const selfCreditedSubscriptions = await prisma.memberSubscription.findMany({
    where: {
      memberId: { in: memberIdsWithContact },
      seasonYear,
      status: { in: [...SELF_CREDITED_SUBSCRIPTION_STATUSES] },
      NOT: { xeroInvoiceId: null },
    },
    select: { memberId: true, xeroInvoiceId: true },
  });
  const selfCreditedByMemberId = new Map<string, Set<string>>();
  for (const subscription of selfCreditedSubscriptions) {
    if (!subscription.xeroInvoiceId) continue;
    const existing = selfCreditedByMemberId.get(subscription.memberId);
    if (existing) {
      existing.add(subscription.xeroInvoiceId);
    } else {
      selfCreditedByMemberId.set(
        subscription.memberId,
        new Set([subscription.xeroInvoiceId]),
      );
    }
  }

  const contactIds = [...new Set(contactIdByMemberId.values())];
  let openInvoicesByContactKey: Map<
    string,
    MembershipCancellationUnpaidInvoiceBlocker[]
  >;
  try {
    openInvoicesByContactKey = await loadOpenInvoicesByContactKey(
      contactIds,
      options,
    );
  } catch (error) {
    const reason = classifyMembershipCancellationInvoiceCheckFailure(error);
    logger.warn(
      { err: error, reason, contactCount: contactIds.length },
      "Membership cancellation unpaid-invoice check could not be completed; approvals for these members are blocked until it can",
    );
    for (const memberId of memberIdsWithContact) {
      blockersByMemberId.set(memberId, [
        { type: "invoice_check_unavailable", reason },
      ]);
    }
    return blockersByMemberId;
  }

  for (const memberId of memberIdsWithContact) {
    const contactId = contactIdByMemberId.get(memberId);
    if (!contactId) continue;
    const selfCredited = selfCreditedByMemberId.get(memberId);
    const openInvoices =
      openInvoicesByContactKey.get(normaliseContactKey(contactId)) ?? [];
    blockersByMemberId.set(
      memberId,
      selfCredited
        ? openInvoices.filter((blocker) => !selfCredited.has(blocker.invoiceId))
        : [...openInvoices],
    );
  }

  return blockersByMemberId;
}
