"use client";

import { Info } from "lucide-react";

/**
 * "The money-owing check was not run for you" (#2402).
 *
 * ## Why this exists at all
 *
 * The review queue's unpaid-invoice check is a live Xero read on a metered daily
 * quota, and its whole purpose is to warn a reviewer before they press Approve.
 * Since #2402 it runs only for an admin who can actually approve, which saves the
 * quota — and takes something away: a view-only membership admin no longer sees
 * that money is owing on a participant. The owner chose that trade knowingly.
 *
 * Only THAT half is withheld. Outstanding bookings and guest appearances are two
 * local database reads costing nothing external, so they are still loaded and
 * still shown to everybody, and the wording below is careful to claim no more
 * than the Xero half — a note that implied the whole row went unchecked would be
 * as misleading in the other direction.
 *
 * ## Why a notice rather than nothing
 *
 * The two options were "show nothing at all" and "show a cheap, non-Xero hint
 * that the check was skipped". Nothing was rejected because the amber blocker
 * panel is ABSENT when there is nothing wrong, so an admin who has learned to
 * read a clean row as "this one is fine" would go on reading it that way — and
 * be wrong, silently, about money. The panel's absence would have quietly
 * changed meaning without changing appearance, which is the worst shape a UI
 * change can take.
 *
 * This costs nothing to produce: no Xero call, no extra database read, just one
 * boolean already in the queue payload. It states only what is true — that the
 * question was not asked — and never implies an answer in either direction.
 *
 * ## Why the explanation is per REQUEST and the marker is per participant
 *
 * The reason is identical for every row on the page — it is a fact about the
 * viewer's own permissions, not about any member — so repeating a full paragraph
 * beside each participant of a five-person family would bury the participants in
 * boilerplate. The explanation is rendered once at the top of each request card
 * that has affected rows; each affected row then carries a single short line, so
 * a reader can still tell WHICH participants it applies to.
 */
export function MembershipCancellationInvoiceCheckSkippedNotice({
  count,
}: {
  /** How many participants of this request had their invoice check skipped. */
  count: number;
}) {
  if (count <= 0) return null;

  return (
    <div className="rounded-md border border-info-6 bg-info-3 p-3 text-sm text-info-11">
      <div className="flex gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">
            {count === 1
              ? "The money-owing check was not run for one member below."
              : `The money-owing check was not run for ${count} members below.`}
          </p>
          <p className="mt-1">
            Your admin role can view cancellations but cannot approve them, so
            this queue did not ask Xero whether anything is owing, and did not
            work out whether a shared family invoice is involved. That silence
            does not mean the member owes nothing — it means the question was not
            asked. An admin who can approve sees both answers on this same page.
          </p>
          <p className="mt-1">
            Outstanding bookings and guest appearances are checked for everyone,
            so that part of the picture is complete and is shown beside each
            member as usual.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The per-row marker. Deliberately one short line: it exists to say WHICH
 * participants the explanation above applies to, not to repeat it.
 */
export function MembershipCancellationInvoiceCheckSkippedLine({
  skipped,
}: {
  skipped: boolean;
}) {
  if (!skipped) return null;

  return (
    <p className="mt-3 text-xs text-info-11">
      Money-owing check not run for this member — see the note at the top of this
      request.
    </p>
  );
}
