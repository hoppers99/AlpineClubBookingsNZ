"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Split-booking guest-portion affordance (#1967). Shown next to the
 * switch-to-Internet-Banking control when the booking has a linked provisional
 * non-member child: because paying the member's own place by internet banking
 * leaves no card on file for the later guest charge, this lets the booker email
 * themselves a secure payment link for the guest portion now. It posts to
 * /api/bookings/[id]/send-guest-payment-link, which reuses the same idempotent
 * machinery as the settlement cron, so pressing it twice never sends a
 * duplicate link.
 */
export function SendGuestPaymentLinkButton({ bookingId }: { bookingId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);

  async function sendLink() {
    setBusy(true);
    setError("");
    setDone(null);
    try {
      const res = await fetch(
        `/api/bookings/${bookingId}/send-guest-payment-link`,
        { method: "POST", headers: { "content-type": "application/json" } }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data.error || "Unable to send the payment link right now."
        );
      }
      if (data.sent > 0) {
        setDone("We've emailed you a secure link to pay for your guests.");
      } else if (data.alreadyActive > 0) {
        setDone(
          "A payment link for your guests has already been sent — check your email (and spam folder)."
        );
      } else {
        setDone("Your guests' payment is already taken care of.");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to send the payment link right now."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <Button
        type="button"
        variant="outline"
        onClick={sendLink}
        disabled={busy || done !== null}
      >
        {busy ? "Sending..." : "Email me a payment link for my guests"}
      </Button>
      {done ? (
        <p className="mt-2 text-sm text-emerald-700">{done}</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
