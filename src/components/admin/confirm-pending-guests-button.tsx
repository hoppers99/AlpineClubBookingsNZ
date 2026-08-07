"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/confirm-dialog";
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { formatCents } from "@/lib/utils";
import { FocusedActionError } from "@/components/focused-action-error";
import { isPaymentReceivedFinalisationPending } from "@/lib/payment-recovery-contract";

const CAPTURED_CARD_RECOVERY_MESSAGE =
  "The saved card was charged, but the booking could not be finalised yet. Do not charge again. Reload the booking and check its payment status before taking another payment action.";

interface ConfirmPendingGuestsButtonProps {
  bookingId: string;
  hasSavedPaymentMethod: boolean;
  finalPriceCents: number;
  /**
   * #2259 honesty rule: the booking's "No emails" switch. With it on, the
   * confirmation email is withheld by the mailer whatever is chosen here, so
   * asking "email the member?" would invite a false belief that they were told.
   * The dialog states the position and confirms down the send-nothing path.
   */
  noEmails?: boolean;
}

export function ConfirmPendingGuestsButton({
  bookingId,
  hasSavedPaymentMethod,
  finalPriceCents,
  noEmails = false,
}: ConfirmPendingGuestsButtonProps) {
  const router = useRouter();
  // Writes /api/admin/bookings/[id]/confirm-pending-guests (bookings area). A
  // view-only bookings admin sees the action disabled (#1997); the notify
  // dialog is unreachable behind it.
  const canEdit = useAdminAreaEditAccess("bookings");
  const { confirm, confirmDialog } = useConfirm();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [errorAttentionVersion, setErrorAttentionVersion] = useState(0);
  const [capturedCardRecovery, setCapturedCardRecovery] = useState(false);
  // #1769b: the admin's explicit email-choice dialog, shown only when this
  // confirmation would actually send the member a confirmation email.
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);

  // Mirror the server's branch order: a zero-dollar booking is confirmed at no
  // charge regardless of a card on file; otherwise a saved card is charged, and
  // without one the booking moves to payment-owed.
  const isZeroDollar = finalPriceCents === 0;
  const willCharge = !isZeroDollar && hasSavedPaymentMethod;
  // #1769b honesty rule: the confirmation email sends when the booking becomes
  // PAID — the zero-dollar (paid_zero) and charged-card (paid_charged) paths.
  // The priced-without-card path moves to payment-owed and emails no one, so it
  // skips the notify dialog and confirms directly.
  const willEmail = isZeroDollar || hasSavedPaymentMethod;
  const consequence = isZeroDollar
    ? "This will confirm the booking at no charge."
    : hasSavedPaymentMethod
      ? `The member's saved card will be charged ${formatCents(finalPriceCents)}.`
      : "This will move the booking to payment-owed (no card on file).";

  function showActionError(message: string) {
    setError(message);
    setErrorAttentionVersion((version) => version + 1);
  }

  async function handleConfirm() {
    const confirmed = await confirm({
      title: "Confirm pending guests?",
      description: `${consequence} This locks the non-member guests in and clears the hold so the booking won't be bumped.`,
      confirmLabel: willCharge ? "Charge and confirm" : "Confirm",
    });
    if (!confirmed) return;

    // When a confirmation email would be sent, ask the admin whether to send
    // it; otherwise confirm directly (today's behaviour on the no-email path).
    if (willEmail) {
      setNotifyDialogOpen(true);
      return;
    }
    void performConfirm();
  }

  async function performConfirm(notifyMember?: boolean) {
    setConfirming(true);
    setError("");

    try {
      const res = await fetch(
        `/api/admin/bookings/${bookingId}/confirm-pending-guests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            notifyMember !== undefined ? { notifyMember } : {}
          ),
        }
      );

      if (res.ok) {
        toast.success(
          noEmails
            ? "Pending guests confirmed. Emails are off for this booking, so nothing was sent."
            : notifyMember === false
              ? "Pending guests confirmed. The member was not emailed."
              : "Pending guests confirmed."
        );
        router.refresh();
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (isPaymentReceivedFinalisationPending(data)) {
        setCapturedCardRecovery(true);
        showActionError(CAPTURED_CARD_RECOVERY_MESSAGE);
        toast.error(CAPTURED_CARD_RECOVERY_MESSAGE);
        setConfirming(false);
        // The parent server component removes this card once the canonical
        // booking has advanced. If that refresh cannot complete, the local
        // recovery state deliberately remains visible and blocks another
        // charge.
        router.refresh();
        return;
      }
      const message =
        data.error === "CAPACITY_EXCEEDED"
          ? "Not enough beds remain for these dates. Use Force confirm to overbook if intended."
          : data.error || "Failed to confirm pending guests";
      showActionError(message);
      toast.error(message);
      setConfirming(false);
    } catch {
      const message = "Failed to confirm pending guests";
      showActionError(message);
      toast.error(message);
      setConfirming(false);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the card so the empty
    wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view this booking but cannot confirm its pending
      guests. Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <Card>
      {confirmDialog}
      <CardHeader>
        <CardTitle>Confirm pending guests now</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This booking still has non-member guests on hold. Confirming now locks
          the guests in and clears the hold so the booking won&apos;t be bumped.
          {isZeroDollar
            ? " There is no charge for this booking."
            : hasSavedPaymentMethod
              ? ` The member's saved card will be charged ${formatCents(finalPriceCents)}.`
              : " There is no saved card, so the booking will move to payment-owed for payment to be arranged separately."}
        </p>
        <FocusedActionError
          id={`confirm-pending-guests-error-${bookingId}`}
          error={error}
          attentionKey={errorAttentionVersion}
          heading={
            capturedCardRecovery
              ? "Saved card charged - finalisation unconfirmed"
              : undefined
          }
          action={
            capturedCardRecovery ? (
              <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
                Reload booking status
              </Button>
            ) : undefined
          }
        />
        {!capturedCardRecovery ? (
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            onClick={handleConfirm}
            disabled={confirming}
          >
            {confirming ? "Confirming..." : "Confirm pending guests"}
          </ViewOnlyActionButton>
        ) : null}
      </CardContent>

      {/* #1769b (#1705 pattern): the admin chooses, per confirmation, whether
          the member is emailed. Both choices confirm the booking identically;
          the choice itself is recorded in the audit log. Shown only when a
          confirmation email would actually be sent.

          #2259: with the booking's "No emails" switch on there is no choice to
          make — the mailer withholds the confirmation either way — so the
          dialog states that and offers only the send-nothing action. */}
      <Dialog open={notifyDialogOpen} onOpenChange={setNotifyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {noEmails
                ? "Confirm pending guests?"
                : "Email the member about this confirmation?"}
            </DialogTitle>
            <DialogDescription>
              {noEmails ? (
                <>
                  The pending guests will be confirmed
                  {willCharge ? ", and the saved card charged" : ""}.
                </>
              ) : (
                <>
                  The booking will be confirmed either way
                  {willCharge ? ", and the saved card is charged regardless" : ""}
                  . Choose whether the member receives the standard booking
                  confirmation email — your choice is recorded in the audit log.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {noEmails && <BookingNoEmailsNotice />}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setNotifyDialogOpen(false);
                // #2259 H1: with the switch on, send NO choice at all rather
                // than notifyMember:false. `false` makes the route skip the
                // send outright, so the mailer's gate never runs and no
                // withheld row is recorded — the banner would then omit the
                // very confirmation the admin just suppressed. Omitting the
                // flag lets the send be attempted and WITHHELD, which both
                // produces the audit row and records honestly that the admin
                // made no choice, because none was offered.
                void performConfirm(noEmails ? undefined : false);
              }}
            >
              {noEmails ? "Confirm pending guests" : "Confirm without emailing"}
            </Button>
            {!noEmails && (
              <Button
                onClick={() => {
                  setNotifyDialogOpen(false);
                  void performConfirm(true);
                }}
              >
                Confirm and email member
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </Card>
    </div>
  );
}
