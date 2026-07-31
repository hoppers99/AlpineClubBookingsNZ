"use client";

import { Info } from "lucide-react";

/**
 * "The approval checks were not run for you" (#2402).
 *
 * ## Why this exists at all
 *
 * The review queue's unpaid-invoice check is a live Xero read on a metered daily
 * quota, and its whole purpose is to warn a reviewer before they press Approve.
 * Since #2402 it runs only for an admin who can actually approve, which saves
 * the quota — and takes something away: a view-only membership admin no longer
 * sees that money is owing on a participant. The owner chose that trade knowingly.
 *
 * ## Why a notice rather than nothing
 *
 * The two options were "show nothing at all" and "show a cheap, non-Xero hint
 * that the check was skipped". Nothing was rejected because the blocker panel is
 * ABSENT when there is nothing wrong, so an admin who has learned to read a
 * clean row as "this one is fine" would go on reading it that way — and be
 * wrong, silently, about money. The panel's absence would have quietly changed
 * meaning without changing appearance, which is the worst shape a UI change can
 * take.
 *
 * This line costs nothing to produce: no Xero call, no extra database read, just
 * one boolean already in the queue payload. It states only what is true — that
 * nothing was asked — and never implies an answer in either direction.
 */
export function MembershipCancellationCheckSkippedNotice({
  skipped,
}: {
  skipped: boolean;
}) {
  if (!skipped) return null;

  return (
    <div className="mt-3 rounded-md border border-info-6 bg-info-3 p-3 text-sm text-info-11">
      <div className="flex gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">
            Approval checks were not run for this member.
          </p>
          <p className="mt-1">
            Your admin role can view cancellations but cannot approve them, so
            this queue did not ask Xero whether anything is owing, and did not
            work out whether a shared family invoice is involved. An empty panel
            here does not mean the member owes nothing — it means the question
            was not asked. An admin who can approve sees both checks on this
            page.
          </p>
        </div>
      </div>
    </div>
  );
}
