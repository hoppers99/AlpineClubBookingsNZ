"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";

interface AdminReturnToWaitlistControlsProps {
  bookingId: string;
  /**
   * #2649 review S3: the booking carries an admin capacity hold or an exclusive
   * whole-lodge hold that this repair releases along with the status.
   */
  releasesHold?: boolean;
}

/**
 * "Return to waitlist" for a stranded zero-dollar waitlist confirm (#2649).
 *
 * The card only renders this when the audit log PROVES a waitlist confirmation
 * stranded this booking — an unresolved `waitlist.confirm_offer_release_failed`
 * report — on top of the free / `PAYMENT_PENDING` / no-payment-record shape.
 * That shape alone is reached by six other producers, so the banner
 * below would otherwise assert a diagnosis about an ordinary booking that
 * nothing had verified. The route re-derives all four facts under its locks, so
 * this gate is about what to OFFER, never about what is allowed.
 *
 * Writes `/api/admin/bookings/[id]/return-to-waitlist` (bookings area), so a
 * view-only bookings admin sees it disabled (#1997).
 */
export function AdminReturnToWaitlistControls({
  bookingId,
  releasesHold = false,
}: AdminReturnToWaitlistControlsProps) {
  const router = useRouter();
  const canEdit = useAdminAreaEditAccess("bookings");
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleReturn() {
    const confirmed = await confirm({
      title: "Put this booking back on the waitlist?",
      description:
        "The booking's confirmation got half-way and could not undo itself: the offer was used up, nothing is owed, and there is nothing for the member to retry. This puts them back in the queue for these nights and frees the beds again. They keep their booking; they lose the used-up offer, and take their place by the ordinary rule. They are emailed unless this booking has \"No emails\" set." +
        (releasesHold
          ? " This booking also carries an admin hold on its nights. Returning it to the waitlist releases that hold, so those nights become available to other members straight away — set the hold again if you still need it."
          : ""),
      confirmLabel: "Return to waitlist",
    });
    if (!confirmed) return;

    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/bookings/${bookingId}/return-to-waitlist`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(
          typeof data.waitlistPosition === "number"
            ? `Back on the waitlist at position ${data.waitlistPosition}.`
            : "Back on the waitlist.",
        );
        router.refresh();
        return;
      }
      // The route knows why — a booking that moved on, a price that appeared, a
      // payment record, a lost claim. Say its words rather than a house guess.
      const message =
        typeof data.error === "string" && data.error
          ? data.error
          : "Failed to return the booking to the waitlist";
      setError(message);
      toast.error(message);
    } catch {
      const message =
        "Could not reach the server. The booking was not returned to the waitlist.";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {confirmDialog}
      <div className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
        <p className="font-medium">Waitlist confirmation did not finish</p>
        <p>
          The audit log records a waitlist confirmation on this booking that got
          stuck and could not undo itself: the offer was used up, and the
          booking is now waiting on payment it does not owe. Return it to the
          waitlist to give the member their place back, or cancel it and ask
          them to rejoin.
        </p>
      </div>
      {error && (
        <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
          {error}
        </div>
      )}
      <ViewOnlyActionButton
        canEdit={canEdit}
        variant="outline"
        onClick={handleReturn}
        disabled={busy}
      >
        {busy ? "Returning..." : "Return to waitlist"}
      </ViewOnlyActionButton>
    </div>
  );
}
