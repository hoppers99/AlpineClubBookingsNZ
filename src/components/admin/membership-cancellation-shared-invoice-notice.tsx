"use client";

import { Info } from "lucide-react";
import {
  describeMembershipCancellationSharedInvoiceParts,
  type MembershipCancellationSharedInvoiceNotice as SharedInvoiceNotice,
} from "@/lib/membership-cancellation-blocker-messages";

/**
 * What approving this participant will do to a SHARED subscription invoice — in
 * the one case where the answer is "nothing" (#2400).
 *
 * A family or billing group is billed with one Xero invoice covering everyone in
 * it. Cancelling one member used to credit that invoice's whole balance, wiping
 * the share belonging to the members who were staying. It no longer does; but a
 * cancellation that quietly leaves an invoice untouched, when the standing
 * policy says unpaid subscriptions are credited, needs saying out loud — so the
 * reviewer reads it here, before they approve, with the invoice linked.
 *
 * Deliberately informational rather than a blocker: the club is still owed that
 * money by the members who remain, so there is nothing to resolve and nothing to
 * refuse. Where the invoice sits on THIS member's own Xero contact, the unpaid
 * invoice blocker refuses the approval independently — because approving would
 * archive a contact with a real balance on it.
 */
export function MembershipCancellationSharedInvoiceNotice({
  notice,
}: {
  notice: SharedInvoiceNotice | null;
}) {
  if (!notice || notice.sharedWith.length === 0) return null;

  const { before, label, href, after } =
    describeMembershipCancellationSharedInvoiceParts(notice);

  return (
    <div className="mt-3 rounded-md border border-info-6 bg-info-3 p-3 text-sm text-info-11">
      <div className="flex gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">
            No Xero credit note will be raised for this cancellation.
          </p>
          <p className="mt-1">
            {before}
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline underline-offset-2"
            >
              {label}
            </a>
            {after}
          </p>
        </div>
      </div>
    </div>
  );
}
