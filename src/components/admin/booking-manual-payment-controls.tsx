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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { formatCents } from "@/lib/utils";

// Mirrors MANUAL_PAYMENT_NOTE_MAX in src/lib/manual-subscription-payment.ts,
// which cannot be imported here: that module is `server-only`.
const NOTE_MAX_LENGTH = 500;

export interface BookingManualPaymentState {
  /** Amount owing right now, in integer cents — the figure the server re-derives. */
  amountOwingCents: number;
  /**
   * #2265 (#2262 delta MED-3): the member asked to put this much account credit
   * towards the booking and it has not been applied yet. Null on the
   * overwhelming majority of bookings. Recording cash CANNOT honour it — the
   * money has already changed hands outside the app — so the settle clears it
   * and tells the member their credit is untouched. That is a legitimate
   * outcome, not an error, but the admin holding the cash deserves to know
   * before they click rather than after.
   */
  storedCreditElectionCents: number | null;
  /** Whether this booking can be recorded as settled at all. */
  canMarkPaid: boolean;
  /** Why not, when it cannot — shown instead of the action. */
  markPaidBlockedReason: string | null;
  /** Set when this payment already carries a manual settlement. */
  manuallyMarkedPaidAt: string | null;
  manuallyMarkedPaidByName: string | null;
  manualPaymentNote: string | null;
  /** Whether the reversal is offered (the server re-checks every fence). */
  canReverse: boolean;
  reverseBlockedReason: string | null;
}

/**
 * B5 (#2262): record a booking's payment as cash / an off-Xero bank transfer,
 * and reverse a prior manual record.
 *
 * The SERVER is the enforcement point — every fence is re-asserted under the
 * booking locks and re-checked inside the fenced write — so the flags here only
 * decide what to OFFER. An action that is offered can still be refused with a
 * 409, and the message is shown verbatim.
 */
export function BookingManualPaymentControls({
  bookingId,
  memberName,
  state,
  noEmails = false,
}: {
  bookingId: string;
  memberName: string;
  state: BookingManualPaymentState;
  /**
   * #2259 honesty rule: with the booking's "No emails" switch on, the
   * confirmation is withheld by the mailer whatever is chosen here, so the
   * dialog states the position instead of offering a choice it cannot honour.
   */
  noEmails?: boolean;
}) {
  const router = useRouter();
  // Writes /api/admin/bookings/[id]/mark-paid, which is FINANCE-gated (the
  // bookings prefix is deliberately overridden in SPECIAL_ROUTE_AREA_PATTERNS),
  // so the affordance follows finance:edit, not bookings:edit.
  const canEdit = useAdminAreaEditAccess("finance");
  const [dialog, setDialog] = useState<null | "paid" | "unpaid">(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isSettled = state.manuallyMarkedPaidAt !== null;

  function openDialog(direction: "paid" | "unpaid") {
    setNote("");
    setDialog(direction);
  }

  /**
   * #2259 H1: dispatch the silenced path so the send is ATTEMPTED, not skipped.
   *
   * `notifyMember: false` would make the ROUTE skip the send outright, so the
   * mailer's "No emails" gate never runs, no `SKIPPED_NO_EMAILS` row is written,
   * and the booking's withheld-list banner would omit the confirmation the
   * member was never sent — the very banner the operator guide tells the officer
   * to work down. The sibling surfaces achieve that by OMITTING the flag; this
   * route cannot, because #2260 makes the choice REQUIRED on the paid direction
   * (an absent flag is a 422, deliberately, so an ambiguous money action is
   * refused rather than guessed). So the silenced path asks for the send and
   * lets the mailer withhold and RECORD it, which is the same audit outcome by
   * the stronger route: the member is not emailed either way, and the returned
   * receipt reports not-delivered rather than claiming a send.
   */
  function confirmSilenced() {
    void submit("paid", true);
  }

  async function submit(direction: "paid" | "unpaid", notifyMember?: boolean) {
    setSubmitting(true);
    try {
      const response = await fetch(`/api/admin/bookings/${bookingId}/mark-paid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction,
          confirmed: true,
          note: note.trim() || null,
          ...(direction === "paid"
            ? {
                notifyMember: notifyMember === true,
                // The amount the admin was shown. The server recomputes the
                // settlement amount under its locks and refuses if this no
                // longer matches, so a price that moved is never recorded at
                // the figure on a stale screen.
                expectedAmountCents: state.amountOwingCents,
              }
            : {}),
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Could not record this payment.");
        return;
      }
      toast.success(data?.message ?? "Done.");
      setDialog(null);
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Nothing was recorded.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="space-y-2 rounded-md border border-border px-3 py-2"
      data-testid="booking-manual-payment-controls"
    >
      <p className="text-sm font-medium text-foreground">
        Cash / off-Xero payment
      </p>

      {isSettled ? (
        <p className="text-sm text-muted-foreground">
          Recorded as paid manually
          {state.manuallyMarkedPaidByName
            ? ` by ${state.manuallyMarkedPaidByName}`
            : ""}
          .{" "}
          {state.manualPaymentNote ? `Note: ${state.manualPaymentNote}` : null}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Record a payment the club received in cash, or by a bank transfer that
          never reached Xero. This never contacts Xero and never creates or
          settles an invoice.
        </p>
      )}

      {!isSettled &&
        (state.canMarkPaid ? (
          <ViewOnlyActionButton
            canEdit={canEdit}
            type="button"
            variant="outline"
            onClick={() => openDialog("paid")}
          >
            Record manual payment ({formatCents(state.amountOwingCents)})
          </ViewOnlyActionButton>
        ) : (
          <p className="text-sm text-warning-11">
            {state.markPaidBlockedReason ??
              "This booking's payment cannot be recorded manually."}
          </p>
        ))}

      {isSettled &&
        (state.canReverse ? (
          <ViewOnlyActionButton
            canEdit={canEdit}
            type="button"
            variant="outline"
            onClick={() => openDialog("unpaid")}
          >
            Reverse manual payment
          </ViewOnlyActionButton>
        ) : (
          <p className="text-sm text-warning-11">
            {state.reverseBlockedReason ??
              "This manual payment can no longer be reversed — cancel the booking instead."}
          </p>
        ))}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent>
          {dialog === "paid" ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Record {formatCents(state.amountOwingCents)} as paid for{" "}
                  {memberName}?
                </DialogTitle>
                <DialogDescription>
                  This records money the club has already received in cash or by
                  an off-Xero bank transfer. The booking becomes paid and its
                  beds are claimed. It never contacts Xero, and no invoice is
                  created or emailed.
                </DialogDescription>
              </DialogHeader>
              {state.storedCreditElectionCents != null ? (
                <p
                  className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
                  data-testid="manual-payment-credit-election-warning"
                >
                  {memberName} asked to put{" "}
                  {formatCents(state.storedCreditElectionCents)} of their account
                  credit towards this booking, and it has not been applied yet.
                  Recording cash cannot use it — the money has already changed
                  hands — so that credit will stay unused and remain available on
                  their account, and they will be told so. Take the full{" "}
                  {formatCents(state.amountOwingCents)} only if that is what they
                  have actually handed over.
                </p>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="manual-booking-payment-note">
                  Note (optional)
                </Label>
                <Textarea
                  id="manual-booking-payment-note"
                  value={note}
                  maxLength={NOTE_MAX_LENGTH}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="e.g. cash at the lodge, or bank transfer ref 1234"
                />
                <p className="text-xs text-muted-foreground">
                  Kept with the club&apos;s records. The member never sees this
                  note.
                </p>
              </div>
              {noEmails ? (
                <BookingNoEmailsNotice />
              ) : (
                <p className="text-sm text-muted-foreground">
                  The payment is recorded either way. Choose whether the member
                  is emailed the usual booking confirmation — your choice is
                  recorded in the audit log.
                </p>
              )}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setDialog(null)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                {!noEmails ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => submit("paid", false)}
                      disabled={submitting}
                    >
                      Record without emailing
                    </Button>
                    <Button
                      onClick={() => submit("paid", true)}
                      disabled={submitting}
                    >
                      Record and email member
                    </Button>
                  </>
                ) : (
                  <Button onClick={confirmSilenced} disabled={submitting}>
                    Record payment
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : dialog === "unpaid" ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Reverse the manual payment for {memberName}?
                </DialogTitle>
                <DialogDescription>
                  The booking goes back to being unpaid and the manual payment
                  record is cleared. It is NOT cancelled. The member is not
                  emailed — there is no reversal notice. A booking restored to
                  awaiting-payment stops holding its beds, so other bookings
                  can take them — and recording the payment again later can be
                  refused if the lodge has filled in the meantime. This is only
                  possible while nothing has happened since that a reversal
                  could not undo: no refund, no card payment, no open refund
                  task, and no Xero invoice.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="manual-booking-reversal-note">
                  Note (optional)
                </Label>
                <Textarea
                  id="manual-booking-reversal-note"
                  value={note}
                  maxLength={NOTE_MAX_LENGTH}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="e.g. recorded against the wrong booking"
                />
              </div>
              <DialogFooter className="gap-2 sm:gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setDialog(null)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button onClick={() => submit("unpaid")} disabled={submitting}>
                  Reverse payment
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
