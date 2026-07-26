"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Lets a member who was put on somebody ELSE's booking take themselves off it
 * from the booking they are looking at (#2250).
 *
 * Before this the only entry point in the whole app was the booking wizard's
 * night-conflict card, so a member could only discover the action while trying
 * to make a clashing booking of their own.
 *
 * Eligibility is NOT re-derived here. `canSelfRemove` and `blockedReason` are
 * computed on the server by `evaluateGuestSelfRemoval`, the same rule the
 * removal service enforces. When the member is not eligible the action is
 * HIDDEN rather than disabled (a disabled button's `title` never fires — the
 * shared button variants set `disabled:pointer-events-none`) and the reason is
 * stated in the reading order instead.
 */
export function SelfRemoveFromBookingCard({
  bookingId,
  guestId,
  ownerFirstName,
  canSelfRemove,
  blockedReason,
}: {
  bookingId: string;
  /** The viewer's own `BookingGuest` row on this booking. */
  guestId: string;
  ownerFirstName: string;
  canSelfRemove: boolean;
  blockedReason: string | null;
}) {
  const [step, setStep] = useState<
    "idle" | "confirming" | "removing" | "removed" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleRemove() {
    setStep("removing");
    try {
      const res = await fetch(`/api/bookings/${bookingId}/guests/${guestId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage(
          typeof data.error === "string"
            ? data.error
            : "We could not take you off this booking. Please try again.",
        );
        setStep("error");
        return;
      }
      setStep("removed");
    } catch {
      setErrorMessage(
        "We could not take you off this booking. Please try again.",
      );
      setStep("error");
    }
  }

  if (step === "removed") {
    return (
      <Card className="border-success-6 bg-success-3">
        <CardHeader>
          <CardTitle className="text-success-11">
            You are off this booking
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-success-11">
          <p>
            Your place has been released and {ownerFirstName} has been told about
            the change. If you change your mind, ask {ownerFirstName} to add you
            back.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/bookings">Back to my bookings</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>You are a guest on this booking</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          {ownerFirstName} made this booking and added you to it. It is not your
          booking to change, but you can take your own place off it if you are no
          longer coming.
        </p>

        {!canSelfRemove ? (
          blockedReason ? (
            <p className="rounded-md border border-border bg-muted px-3 py-2">
              {blockedReason}
            </p>
          ) : null
        ) : step === "confirming" ? (
          <div className="space-y-3 rounded-md border border-danger-6 bg-danger-3 p-3 text-danger-11">
            <p className="font-medium">Take yourself off this booking?</p>
            <p>
              Your place is released and the rest of the booking stays as it is.
              {" "}
              {ownerFirstName} is emailed about the change and their total is
              updated. You cannot undo this yourself — you would have to ask{" "}
              {ownerFirstName} to add you back.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleRemove()}
              >
                Yes, take me off
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep("idle")}
              >
                Keep my place
              </Button>
            </div>
          </div>
        ) : step === "removing" ? (
          <p>Taking you off this booking...</p>
        ) : step === "error" ? (
          <div className="space-y-2 rounded-md border border-danger-6 bg-danger-3 p-3">
            <p className="text-danger-11">{errorMessage}</p>
            <Button variant="outline" size="sm" onClick={() => setStep("idle")}>
              Try again
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setStep("confirming")}
          >
            Remove me from this booking
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
