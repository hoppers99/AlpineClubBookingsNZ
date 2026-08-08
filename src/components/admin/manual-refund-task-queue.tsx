"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FocusedActionError } from "@/components/focused-action-error";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { formatCents } from "@/lib/utils";
import { formatNZDate } from "@/lib/nzst-date";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

const NOTE_MAX_LENGTH = 500;

interface ManualRefundTask {
  id: string;
  bookingId: string;
  amountCents: number;
  reason: string;
  createdAt: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
}

/**
 * B5 (#2262): the cash hand-back queue.
 *
 * A cancelled booking that was settled in cash (or by an off-Xero bank
 * transfer) has no card charge to reverse and no Xero invoice to credit, so the
 * cancellation raises a durable task here instead of pretending money moved.
 * "Paid back" writes the refund allocation and the REFUNDED booking event —
 * that is the moment the ledger says the money went back — and "dismiss"
 * (which requires a note) closes it without moving anything.
 */
export function ManualRefundTaskQueue() {
  const canEdit = useAdminAreaEditAccess("finance");
  const [tasks, setTasks] = useState<ManualRefundTask[] | null>(null);
  const [target, setTarget] = useState<
    null | { task: ManualRefundTask; resolution: "completed" | "dismissed" }
  >(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /**
   * #2668 review SF-5: the sentence for an outcome that was never read, held on
   * screen rather than thrown as a toast.
   *
   * The dialog stays open on a failure and the button re-arms in `finally`, so
   * a transient toast is very likely to be gone before the operator's next
   * press — and this is money. The notice sits inside the dialog, above the
   * button it disarms, until they act on it. Refusals the server reported keep
   * their toast: those say what actually happened.
   */
  const [unverified, setUnverified] = useState<string | null>(null);
  /**
   * Bumped with each unread outcome so the recovery alert takes focus again on a
   * repeat. Focus is not decoration here: this branch disables the button that
   * was just pressed, and a control disabled in the same turn cannot hold focus,
   * so without the alert taking it the operator would be dropped to `<body>`.
   */
  const [unverifiedAttention, setUnverifiedAttention] = useState(0);
  /*
    #2264: the worked example for the note used to be its placeholder, which
    reads as a value already typed and disappears on the first keystroke. It is
    helper text under the box now. It still switches on the resolution — the
    example for "paid back" is not the example for "dismissed" — but it says
    NOTHING about the note being required or optional: the Label above already
    carries that, and repeating it there would announce it twice.
  */
  const noteHint = useFieldHint();

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/payments/manual-refund-tasks");
      if (!response.ok) {
        setTasks([]);
        return;
      }
      const data = (await response.json()) as { tasks: ManualRefundTask[] };
      setTasks(data.tasks ?? []);
    } catch {
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!target) return;
    setSubmitting(true);
    setUnverified(null);
    try {
      const response = await fetch(
        `/api/admin/payments/manual-refund-tasks/${target.task.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resolution: target.resolution,
            confirmed: true,
            note: note.trim() || null,
          }),
        },
      );
      const data = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Could not close this refund task.");
        return;
      }
      toast.success(data?.message ?? "Done.");
      setTarget(null);
      setNote("");
      await load();
    } catch {
      /*
        #2668. This used to say "Nothing was changed." A rejected `fetch` also
        covers the case where the POST landed, the refund allocation and the
        REFUNDED booking event were written, and only the answer was lost — so
        "nothing was changed" can be a statement about the ledger that is
        exactly backwards. The queue is deliberately NOT reloaded from here: a
        failed read blanks the card (see `load`), which would take the evidence
        off screen at the moment it is needed.

        Review SF-5: held in the dialog rather than thrown as a toast, with the
        close button disarmed behind it. A toast fades; the next press does not
        wait for it, and on this queue that press is either a second refund
        allocation attempt or a dismissal of a task that may already be closed.
        The server does refuse a second close on an already-closed task, so the
        ledger is safe either way — but "check the queue first" is the
        instruction, and the dialog now holds still long enough to be read.
      */
      setUnverified(
        unverifiedWriteMessage(
          "this refund task was closed",
          "Reload the page and check the queue before trying again.",
        ),
      );
      setUnverifiedAttention((value) => value + 1);
    } finally {
      setSubmitting(false);
    }
  }

  if (tasks !== null && tasks.length === 0) return null;

  return (
    <Card data-testid="manual-refund-task-queue">
      <CardHeader>
        <CardTitle className="text-base">
          Refunds to pay back by hand
          {tasks ? ` (${tasks.length})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          These bookings were paid in cash or by a bank transfer that never
          reached Xero, and have since been cancelled. There is no card payment
          to reverse, so the club has to pay the member back directly. Mark a
          refund as paid back once the money has actually gone — that is when
          the ledger records it.
        </p>
        {tasks === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="space-y-3">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-foreground">
                    {task.memberName} — {formatCents(task.amountCents)}
                  </p>
                  <p className="text-muted-foreground">
                    {formatNZDate(new Date(task.checkIn))} to{" "}
                    {formatNZDate(new Date(task.checkOut))} ·{" "}
                    <Link
                      className="underline"
                      href={`/bookings/${task.bookingId}`}
                    >
                      View booking
                    </Link>
                  </p>
                  <p className="text-xs text-muted-foreground">{task.reason}</p>
                </div>
                <div className="flex gap-2">
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setNote("");
                      setUnverified(null);
                      setTarget({ task, resolution: "completed" });
                    }}
                  >
                    Mark paid back
                  </ViewOnlyActionButton>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setNote("");
                      setUnverified(null);
                      setTarget({ task, resolution: "dismissed" });
                    }}
                  >
                    Dismiss
                  </ViewOnlyActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          // The notice belongs to the attempt that produced it; a stale one
          // over the next task would read as that task's outcome.
          if (!open) {
            setTarget(null);
            setUnverified(null);
          }
        }}
      >
        <DialogContent>
          {target && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {target.resolution === "completed"
                    ? `Record ${formatCents(target.task.amountCents)} as paid back to ${target.task.memberName}?`
                    : `Dismiss the refund for ${target.task.memberName}?`}
                </DialogTitle>
                <DialogDescription>
                  {target.resolution === "completed"
                    ? "Only do this once the money has actually gone back to the member. It writes the refund into the payment ledger and records a refund on the booking's history."
                    : "Dismissing closes the task without refunding anything — for a member who declined the refund, or money settled another way. Say which, so the record makes sense later."}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="manual-refund-task-note">
                  Note{target.resolution === "dismissed" ? " (required)" : " (optional)"}
                </Label>
                <Textarea
                  id="manual-refund-task-note"
                  value={note}
                  maxLength={NOTE_MAX_LENGTH}
                  onChange={(event) => setNote(event.target.value)}
                  {...noteHint.fieldProps}
                />
                <FieldHint {...noteHint.hintProps}>
                  {target.resolution === "completed"
                    ? "e.g. cash handed back at the lodge"
                    : "e.g. member asked us to keep it as a donation"}
                </FieldHint>
              </div>
              {/*
                #2668 SF-5. The house recovery alert (`focused-action-error.tsx`,
                #2597 / #2635): permanently mounted so the live region exists
                before it has anything to say — one injected already-populated is
                silently dropped by some screen-reader/browser pairings —
                assertive, and it takes focus when the message arrives, which is
                what keeps the operator from being dropped to `<body>` as the
                button they just pressed is disabled behind it.
              */}
              <FocusedActionError
                id="manual-refund-unverified-notice"
                error={unverified ?? ""}
                attentionKey={unverifiedAttention}
              />
              <DialogFooter className="gap-2 sm:gap-2">
                {/*
                  After an unread outcome "Cancel" would itself be a claim —
                  there may be nothing left to cancel — so the way out is named
                  for what it does.
                */}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTarget(null);
                    setUnverified(null);
                  }}
                  disabled={submitting}
                >
                  {unverified ? "Close and check" : "Cancel"}
                </Button>
                <Button
                  onClick={submit}
                  disabled={
                    submitting ||
                    unverified !== null ||
                    (target.resolution === "dismissed" && note.trim().length === 0)
                  }
                >
                  {target.resolution === "completed"
                    ? "Record as paid back"
                    : "Dismiss refund"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
