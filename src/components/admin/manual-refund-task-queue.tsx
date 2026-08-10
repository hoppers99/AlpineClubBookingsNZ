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
 * A refund the club never decided: a payment landed on a booking that had
 * already been deleted, and Stripe handed it straight back (#2750).
 */
interface AutoRefundedNotice {
  id: string;
  bookingId: string;
  amountCents: number;
  reason: string;
  note: string | null;
  refundedAt: string | null;
  memberName: string;
  checkIn: string;
  checkOut: string;
}

/**
 * The read-only record of a refund nobody authorised (#2750).
 *
 * Deliberately buttonless. There is no decision left on these rows — Stripe
 * returned the money before anybody saw the capture — and a control here would
 * imply otherwise. What it does carry is the one thing an operator needs if the
 * deletion, not the payment, was the mistake: that the refund has already gone
 * out, so putting the booking back means charging the member again.
 *
 * A separate component from the queue above because it is a different claim
 * about the world, and mixing "you owe this member money" rows with "this money
 * has already gone back" rows in one list is how somebody pays a refund twice.
 *
 * A PARTIAL RECORD, AND IT SAYS SO. A row exists only where the member's browser
 * reached the confirm endpoint before the Stripe webhook did: that is the one
 * ordering that raises a `ManualRefundTask` at all. Webhook-first (and the member
 * who simply closes the tab after paying) refunds the capture and leaves no task
 * for the close to find, and the interleaved ordering is fenced off deliberately
 * — see `deleted-booking-modification-payment.ts`. The card therefore names the
 * audit entry and the alert email as the complete record rather than letting a
 * short list read as "that is all of them" (`INV-ADDPAY-037`).
 */
function AutomaticRefundNoticesCard({
  notices,
}: {
  notices: AutoRefundedNotice[];
}) {
  return (
    <Card data-testid="automatic-refund-notices">
      <CardHeader>
        <CardTitle className="text-base">
          Refunded automatically — nothing to pay back ({notices.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          A payment for a booking change arrived after the booking had already
          been deleted. Stripe returned the money to the member straight away, so
          there is nothing for you to pay back and nothing to close here. This
          card is here so somebody sees it happened: if deleting the booking was
          the mistake rather than the payment, the booking has to be made again
          and the member charged again — the refund has already gone out.
        </p>
        {/*
          #2750 review: the card is a partial record, and it says so rather than
          letting an operator read a short list as "that is all of them".

          Only one of the ways this can happen leaves a row here: the member's
          browser has to finish the payment step before Stripe's notification
          reaches us. If the notification lands first, or the member closes the
          tab after paying, the refund still happens and this card never learns
          about it. The permanent record for every ordering is the booking's
          audit log entry plus the payment alert email the club is sent at the
          time, so those are named here — an operator who trusts an empty card as
          proof no automatic refund happened is the failure this whole card
          exists to prevent, and it would be a worse one than the original.
        */}
        <p className="text-sm text-muted-foreground">
          This card does not catch every one. Whether a refund shows up here
          depends on the order the member&apos;s browser and Stripe&apos;s
          notification reached us in, so an empty or short list means &ldquo;none
          recorded here&rdquo; rather than &ldquo;none happened&rdquo;. The
          complete record is the booking&apos;s audit log (the{" "}
          <span className="font-mono text-xs">
            booking.payment.refunded_after_cancellation
          </span>{" "}
          entry) together with the payment alert email the club is sent at the
          time.
        </p>
        <ul className="space-y-3">
          {notices.map((notice) => (
            <li
              key={notice.id}
              className="space-y-1 rounded-md border border-border px-3 py-2 text-sm"
            >
              <p className="font-medium text-foreground">
                {notice.memberName} — {formatCents(notice.amountCents)} refunded
                {notice.refundedAt
                  ? ` on ${formatNZDate(new Date(notice.refundedAt))}`
                  : ""}
              </p>
              {/*
                NO "View booking" LINK ON THIS CARD, unlike the hand-back queue
                above, and the difference is not an oversight (#2750 review).

                Every row here is a booking that has been DELETED, and the
                booking detail page 404s a deleted booking for anybody who is not
                a Full Admin — while this card is gated on finance:view, which a
                Finance Viewer and a Treasurer hold without it. So the link would
                be a dead end for exactly the audience the card is for. Widening
                that page's audience to make a link work is not on the table; the
                identifiers are printed as plain text instead, which is what a
                Full Admin needs to look the booking up and what a finance
                operator needs to quote it to somebody who can.
              */}
              <p className="text-muted-foreground">
                {formatNZDate(new Date(notice.checkIn))} to{" "}
                {formatNZDate(new Date(notice.checkOut))} · booking{" "}
                <span className="font-mono text-xs">{notice.bookingId}</span>
              </p>
              {/*
                Both sentences, not one. The reason names the situation that
                produced the payment; the note says that Stripe already handed
                the money back. An operator reading only the reason — which asks
                them to decide whether to refund — would think the decision is
                still theirs.
              */}
              <p className="text-xs text-muted-foreground">{notice.reason}</p>
              {notice.note ? (
                <p className="text-xs text-muted-foreground">{notice.note}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
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
 *
 * TWO CARDS SINCE #2750, and only the first is a queue. The second is the
 * operator surface for a refund nobody authorised: when a modification payment
 * is captured against a booking the club has already deleted, the Stripe webhook
 * has refunded it in full since #1350, and #2700 made that leave a
 * `ManualRefundTask` behind — which the webhook then closes itself, because
 * there is genuinely nothing left to pay back by hand. Closing it took it off
 * this screen, since the queue lists OPEN rows, so the one durable record of the
 * money movement was visible only to somebody who thought to query the table.
 *
 * The decision #2750 recorded is that the automatic refund STAYS: money going
 * back to the member is the safe direction when nobody is watching. What it adds
 * is that the record is seen. That is why the second card carries no buttons —
 * there is no action, and offering one would imply the refund is still open to
 * decide. What an operator does with it is off-screen work: if the DELETION was
 * the mistake rather than the payment, the booking has to be put back and the
 * member charged again, and the card says so in those words.
 */
export function ManualRefundTaskQueue() {
  const canEdit = useAdminAreaEditAccess("finance");
  const [tasks, setTasks] = useState<ManualRefundTask[] | null>(null);
  const [autoRefunded, setAutoRefunded] = useState<AutoRefundedNotice[]>([]);
  /**
   * The load failed, as distinct from having found nothing (#2750 review).
   *
   * Blanking the cards on a failure is right — a stale list of money owed is
   * worse than none — but blanking them SILENTLY makes a 500 look exactly like
   * "nothing to pay back and no automatic refunds", and this card exists so that
   * an absence of rows can be trusted. One line says which it was.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * The route answered, but its automatic-refund read specifically failed, so it
   * sent an empty list it does not stand behind. Separate from `loadFailed`
   * because the hand-back queue beside it IS trustworthy in that case, and
   * telling the operator their work queue is broken when it is not would send
   * them looking for a problem that is not there.
   */
  const [autoRefundedUnavailable, setAutoRefundedUnavailable] = useState(false);
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
        setAutoRefunded([]);
        setAutoRefundedUnavailable(false);
        setLoadFailed(true);
        return;
      }
      const data = (await response.json()) as {
        tasks: ManualRefundTask[];
        autoRefunded?: AutoRefundedNotice[];
        autoRefundedUnavailable?: boolean;
      };
      setTasks(data.tasks ?? []);
      setAutoRefunded(data.autoRefunded ?? []);
      setAutoRefundedUnavailable(Boolean(data.autoRefundedUnavailable));
      setLoadFailed(false);
    } catch {
      setTasks([]);
      setAutoRefunded([]);
      setAutoRefundedUnavailable(false);
      setLoadFailed(true);
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

  /*
    The hand-back queue keeps its original behaviour exactly: it shows while the
    load is still in flight (`tasks === null`) and disappears once the load says
    there is nothing to pay back. The automatic-refund card is independent — one
    can be present without the other, and when both are empty AND the load
    succeeded this component still renders nothing at all. A failed load is the
    one case where "nothing" is not the answer: it renders the line below instead,
    because silence there is indistinguishable from a clean slate.
  */
  const showQueue = tasks === null || tasks.length > 0;
  if (
    !showQueue &&
    autoRefunded.length === 0 &&
    !loadFailed &&
    !autoRefundedUnavailable
  ) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/*
        A failed read says so (#2750 review). Rendered above the cards because it
        is a statement about what is missing from them, and as its own line rather
        than as an empty card so it cannot be mistaken for a list with no rows.
      */}
      {loadFailed ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="manual-refund-task-load-error"
        >
          Refund tasks could not be loaded, so this page cannot say whether any
          are waiting or whether a payment was refunded automatically. Reload the
          page.
        </p>
      ) : null}
      {showQueue ? (
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
      ) : null}
      {/*
        The route answered but could not read this list. Said in one line instead
        of an empty card, for the same reason as above: an empty card asserts that
        no money was refunded automatically, and a query that failed has not
        earned the right to assert that.
      */}
      {autoRefundedUnavailable ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="automatic-refund-notices-unavailable"
        >
          The record of automatic refunds could not be loaded, so this page
          cannot say whether any payment was refunded automatically. The
          hand-back queue above is unaffected. Reload the page.
        </p>
      ) : null}
      {autoRefunded.length > 0 ? (
        <AutomaticRefundNoticesCard notices={autoRefunded} />
      ) : null}
    </div>
  );
}
