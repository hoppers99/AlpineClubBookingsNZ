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
 * Deliberately not a blocker — it adds no reason to refuse — but it does NOT
 * promise the approval will go through. The family's invoice is raised to the
 * charge RECIPIENT's Xero contact, so in the commonest shape (a parent leaving
 * while the children stay) that uncredited balance sits on a contact the
 * approval would archive, and the unpaid-invoice blocker refuses the approval
 * outright. `notice.blocksApproval` says which of the two this is, and both the
 * heading here and the sentence built in `membership-cancellation-blocker-
 * messages.ts` follow it, so the panel never tells a reviewer to press a button
 * that is going to bounce (#2400 review, F2).
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
            {notice.blocksApproval
              ? "This cancellation credits nothing, and the invoice it leaves behind is blocking the approval."
              : "No Xero credit note will be raised for this cancellation."}
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
