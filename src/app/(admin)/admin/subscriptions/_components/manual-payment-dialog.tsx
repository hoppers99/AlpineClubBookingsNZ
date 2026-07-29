"use client";

import { useEffect, useState } from "react";
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

/**
 * #2260 — the manual mark-paid / reversal confirmation, as a real dialog.
 *
 * It replaces three bare browser `confirm()`/`prompt()` calls on the
 * subscriptions page and adds the club's standard "email the member or not"
 * choice on the paid path, using the established two-button idiom (see
 * `src/components/admin/confirm-pending-guests-button.tsx`): the subscription is
 * marked paid identically either way, and the choice itself is recorded in the
 * audit log.
 *
 * The reversal path deliberately offers NO email choice — there is no "your
 * payment was un-recorded" notice and inventing one would be worse than
 * silence — but it still gets a proper dialog rather than a browser confirm.
 */

// Mirrors MANUAL_PAYMENT_NOTE_MAX in src/lib/manual-subscription-payment.ts,
// which cannot be imported here: that module is `server-only`.
const NOTE_MAX_LENGTH = 500;

export interface ManualPaymentTarget {
  subscriptionId: string;
  memberName: string;
  seasonYear: number;
  direction: "paid" | "unpaid";
}

export interface ManualPaymentSubmission {
  note: string | null;
  /** Present only on the paid path; the API rejects it on a reversal. */
  notifyMember?: boolean;
}

export function ManualPaymentDialog({
  target,
  submitting,
  onCancel,
  onSubmit,
}: {
  target: ManualPaymentTarget | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (submission: ManualPaymentSubmission) => void;
}) {
  const [note, setNote] = useState("");

  // A fresh row means a fresh note — never carry one admin's note across to the
  // next subscription they open.
  useEffect(() => {
    setNote("");
  }, [target?.subscriptionId, target?.direction]);

  const isPaid = target?.direction === "paid";

  function submit(notifyMember?: boolean) {
    const trimmed = note.trim().slice(0, NOTE_MAX_LENGTH);
    onSubmit({
      note: trimmed || null,
      ...(notifyMember === undefined ? {} : { notifyMember }),
    });
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        {target === null ? null : isPaid ? (
          <>
            <DialogHeader>
              <DialogTitle>
                Mark {target.memberName}&apos;s {target.seasonYear} subscription
                as paid?
              </DialogTitle>
              <DialogDescription>
                This records a payment made outside Xero (cash, cheque or
                internet banking). It does not create or settle an invoice, and
                it never contacts Xero.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="manual-payment-note">Note (optional)</Label>
              <Textarea
                id="manual-payment-note"
                value={note}
                maxLength={NOTE_MAX_LENGTH}
                onChange={(event) => setNote(event.target.value)}
                placeholder="e.g. cash, cheque #123"
              />
              <p className="text-xs text-muted-foreground">
                Kept with the club&apos;s records. The member never sees this
                note.
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              The subscription is marked paid either way. Choose whether the
              member is emailed a receipt for the payment — your choice is
              recorded in the audit log.
            </p>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="ghost" onClick={onCancel} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={() => submit(false)}
                disabled={submitting}
              >
                Mark paid without emailing
              </Button>
              <Button onClick={() => submit(true)} disabled={submitting}>
                Mark paid and email member
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                Reverse the manual payment for {target.memberName}?
              </DialogTitle>
              <DialogDescription>
                The {target.seasonYear} subscription returns to its unpaid state
                and the manual payment record is cleared. The member is not
                emailed — there is no reversal notice.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="ghost" onClick={onCancel} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={() => submit()} disabled={submitting}>
                Reverse payment
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
