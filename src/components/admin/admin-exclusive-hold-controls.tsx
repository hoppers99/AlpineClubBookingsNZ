"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/confirm-dialog";

interface AdminExclusiveHoldControlsProps {
  bookingId: string;
  /** Whether the exclusive whole-lodge hold is currently set (#121). */
  wholeLodgeHold: boolean;
  /** ISO timestamp of the hold, for display. */
  wholeLodgeHoldAt: string | null;
  /** Name of the admin who set the hold, when known. */
  heldByName: string | null;
}

/**
 * Exclusive whole-lodge hold set/clear control for the Admin tools card
 * (issue #121, ADR-001). Reflects Booking.wholeLodgeHold and POSTs the new
 * state to /api/admin/bookings/[id]/exclusive-hold. Setting the hold has NO
 * empty-lodge precondition (decision 1) — it is allowed over existing
 * overlapping bookings, which the officer resolves manually.
 */
export function AdminExclusiveHoldControls({
  bookingId,
  wholeLodgeHold,
  wholeLodgeHoldAt,
  heldByName,
}: AdminExclusiveHoldControlsProps) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function callRoute(hold: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/bookings/${bookingId}/exclusive-hold`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hold }),
        },
      );
      if (res.ok) {
        toast.success(
          hold
            ? "Exclusive whole-lodge hold set."
            : "Exclusive whole-lodge hold cleared.",
        );
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      const message =
        data.error ||
        (hold
          ? "Failed to set the exclusive hold"
          : "Failed to clear the exclusive hold");
      setError(message);
      toast.error(message);
    } catch {
      const message = hold
        ? "Failed to set the exclusive hold"
        : "Failed to clear the exclusive hold";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSet() {
    const confirmed = await confirm({
      title: "Set the exclusive whole-lodge hold?",
      description:
        "The whole lodge is reserved for this booking's group — no other beds can be booked on its nights, even if beds are free. Any existing overlapping bookings are not changed; resolve them manually.",
      confirmLabel: "Set hold",
    });
    if (!confirmed) return;
    await callRoute(true);
  }

  async function handleClear() {
    const confirmed = await confirm({
      title: "Clear the exclusive whole-lodge hold?",
      description:
        "Other members can book the remaining beds on these nights again. The booking itself is unchanged.",
      confirmLabel: "Clear hold",
    });
    if (!confirmed) return;
    await callRoute(false);
  }

  return (
    <div className="space-y-2">
      {confirmDialog}
      {wholeLodgeHold && (
        <div className="rounded-md border border-purple-300 bg-purple-50 px-3 py-2 text-sm text-purple-900">
          <p className="font-medium">Exclusive whole-lodge hold</p>
          <p>
            The whole lodge is reserved for this group
            {heldByName ? ` by ${heldByName}` : ""}
            {wholeLodgeHoldAt
              ? ` since ${new Date(wholeLodgeHoldAt).toLocaleDateString("en-NZ")}`
              : ""}
            . New admissions are blocked on these nights.
          </p>
        </div>
      )}
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {wholeLodgeHold ? (
        <Button variant="outline" onClick={handleClear} disabled={busy}>
          {busy ? "Clearing..." : "Clear exclusive hold"}
        </Button>
      ) : (
        <Button variant="outline" onClick={handleSet} disabled={busy}>
          {busy ? "Setting..." : "Set exclusive hold"}
        </Button>
      )}
    </div>
  );
}
