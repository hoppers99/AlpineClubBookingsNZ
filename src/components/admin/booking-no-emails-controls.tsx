"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";

/**
 * The per-booking "No emails" switch (#2259, owner decision D10).
 *
 * D10 makes everything suppressible, but pays for it with a compensating
 * control the admin cannot skip: turning the switch ON requires an explicit
 * confirmation that they will tell the member themselves. That is why this is a
 * two-button dialog (the house idiom — see `confirm-pending-guests-button.tsx`)
 * and NOT a checkbox: a checkbox is missable, and the consequence here is that a
 * member is never told their booking was cancelled.
 *
 * The dialog is deliberately asymmetric. Turning the switch ON asks for the
 * acknowledgement; turning it OFF asks only for a plain confirm, because
 * restoring the club's normal behaviour needs no undertaking and a stuck switch
 * must always be clearable.
 *
 * Rendered only for admins — the member view of this booking never mounts it.
 * A member must never learn the switch exists.
 */
export function BookingNoEmailsControls({
  bookingId,
  noEmails,
  noEmailsAt,
  setByName,
  hasLiveWaitlistOffer,
}: {
  bookingId: string;
  noEmails: boolean;
  /** ISO timestamp of when the current episode began, for display. */
  noEmailsAt: string | null;
  /** Name of the admin who turned it on, when known. */
  setByName: string | null;
  /**
   * Whether the booking is sitting on a live, unexpired waitlist offer
   * (`bookingHasLiveWaitlistOffer`, evaluated server-side by the page).
   *
   * Turning the switch on does NOT retract that offer: the bed stays held, the
   * expiry clock keeps running, and the member is never told. The admin has to
   * be told that before they confirm, so the warning is rendered from this prop
   * rather than from the POST response — by the time the response arrives the
   * decision has already been made. The response's own
   * `hasLiveWaitlistOffer` is the authoritative after-the-fact reading and
   * drives the toast below, so a page that has gone stale still surfaces it.
   */
  hasLiveWaitlistOffer: boolean;
}) {
  const router = useRouter();
  // Writes /api/admin/bookings/[id]/no-emails, which requires bookings:edit —
  // a view-only bookings admin sees the control disabled (#1997/#2160).
  const canEdit = useAdminAreaEditAccess("bookings");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(nextNoEmails: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/no-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The acknowledgement is only meaningful when enabling; the route
        // refuses an enable without it with a 400.
        body: JSON.stringify(
          nextNoEmails
            ? { noEmails: true, acknowledged: true }
            : { noEmails: false },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          typeof data.error === "string"
            ? data.error
            : "Failed to update the No emails setting";
        setError(message);
        toast.error(message);
        return;
      }

      setDialogOpen(false);
      if (nextNoEmails) {
        toast.success(
          "All emails are now off for this booking. Tell the member yourself.",
        );
        if (data.hasLiveWaitlistOffer === true) {
          toast.warning(
            "This booking is holding a live waitlist offer. The bed stays held and the offer keeps counting down, but the member will not be told.",
          );
        }
      } else {
        toast.success(
          "Emails are back on for this booking. Anything withheld while the switch was on is not re-sent.",
        );
      }
      router.refresh();
    } catch {
      const message = "Failed to update the No emails setting";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const setOnDetail = noEmails
    ? [
        setByName ? `Turned on by ${setByName}` : "Turned on",
        noEmailsAt
          ? ` on ${new Date(noEmailsAt).toLocaleDateString("en-NZ")}`
          : "",
        ".",
      ].join("")
    : "";

  return (
    <div className="space-y-2">
      {noEmails && (
        <div className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11">
          <p className="font-medium">All emails are off for this booking</p>
          <p>
            {setOnDetail} Nothing is sent to the member about this booking —
            including cancellation notices and payment reminders. You are
            responsible for telling them directly.
          </p>
        </div>
      )}
      {error && (
        <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
          {error}
        </div>
      )}
      <ViewOnlyActionButton
        canEdit={canEdit}
        variant="outline"
        onClick={() => {
          setError("");
          setDialogOpen(true);
        }}
        disabled={busy}
      >
        {noEmails ? "Turn emails back on" : "Turn off all emails"}
      </ViewOnlyActionButton>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => !busy && setDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {noEmails
                ? "Turn emails back on for this booking?"
                : "Turn off all emails for this booking?"}
            </DialogTitle>
            <DialogDescription>
              {noEmails
                ? "The club will start emailing the member about this booking again. Messages withheld while the switch was on are NOT re-sent — if the member still needs to know about them, tell them yourself."
                : "No emails will be sent for this booking, including cancellation notices and payment reminders. The member will not be told anything about it. You are responsible for telling the member directly."}
            </DialogDescription>
          </DialogHeader>
          {/* The dialog warns about an outstanding offer BEFORE the admin
              confirms: turning the switch on does not retract the offer, so
              the bed stays held on a clock the member cannot see. */}
          {!noEmails && hasLiveWaitlistOffer && (
            <div className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
              <p className="font-medium">
                This booking is holding a live waitlist offer
              </p>
              <p>
                The bed stays held and the offer keeps counting down to its
                expiry. Turning emails off does not retract it, and the member
                will never be told the offer was made — so they cannot accept
                it unless you contact them.
              </p>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant={noEmails ? "default" : "destructive"}
              disabled={busy}
              onClick={() => void submit(!noEmails)}
            >
              {busy
                ? "Saving..."
                : noEmails
                  ? "Turn emails back on"
                  : "Yes — I will tell the member myself"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
