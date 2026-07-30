"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * Re-send the "you still owe this" email for a booking's uncollected additional
 * payment (#2350).
 *
 * A plain `Button` rather than a `ViewOnlyActionButton`: the panel around it only
 * renders this control for an admin who already holds `bookings:edit`, and a
 * view-only admin is given the reason in prose instead — the same shape the
 * bed-allocation panel's confirmation dialog uses, and it keeps a leaf action out
 * of the view-only census.
 *
 * The server refuses a second send inside the cooldown window, so double-clicking
 * cannot fan out; the refusal is surfaced verbatim rather than being retried.
 */
export function ResendAdditionalPaymentButton({
  bookingId,
}: {
  bookingId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function send() {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const res = await fetch(
        `/api/admin/bookings/${bookingId}/additional-payment-reminder`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data.error || "Unable to send the payment request right now.",
        );
      }
      setDone("Payment request emailed to the member.");
      // The panel shows when the member was last chased, so re-read it.
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to send the payment request right now.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" onClick={send} disabled={busy}>
        {busy ? "Sending..." : "Resend payment request email"}
      </Button>
      {done ? <p className="text-sm text-success-11">{done}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
