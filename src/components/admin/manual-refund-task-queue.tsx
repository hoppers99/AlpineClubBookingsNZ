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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { formatCents } from "@/lib/utils";
import { formatNZDate } from "@/lib/nzst-date";

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
      toast.error("Could not reach the server. Nothing was changed.");
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
          if (!open) setTarget(null);
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
                  placeholder={
                    target.resolution === "completed"
                      ? "e.g. cash handed back at the lodge"
                      : "e.g. member asked us to keep it as a donation"
                  }
                />
              </div>
              <DialogFooter className="gap-2 sm:gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setTarget(null)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  onClick={submit}
                  disabled={
                    submitting ||
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
