"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The delegate's answer panel on `/bookings/consent/[guestId]` ("+ Add Member
 * Guest", epic #2305, MG2 #2307, owner decisions D-5/D-9/D-10).
 *
 * A delegate is NOT a guest on the booking and never becomes one by answering:
 * this panel is deliberately everything they see — names, dates, and the
 * question. No prices, no totals, no link into the booking page. The
 * asymmetry with a logged-in target (who gets the whole booking page under
 * D-11) is a security choice stated on the signed-off mockup pack.
 *
 * Refusal handling mirrors the member card: `refusalWarning` carries the
 * server-composed warning for a PREDICTABLE decline refusal (the "No thanks"
 * button is withheld), and an unpredictable refusal comes back as the
 * server's 400 message repeated verbatim with both buttons still offered.
 */
export function MemberGuestDelegateConsentCard({
  bookingId,
  guestId,
  guestFirstName,
  guestHeadingName,
  bookerName,
  bookerFirstName,
  lodgeName,
  stayLabel,
  nightsLabel,
  answerByLabel,
  party,
  refusalWarning,
}: {
  bookingId: string;
  guestId: string;
  /** The member being added — the person this answer is FOR. */
  guestFirstName: string;
  /** "Tama Kaur (age 9)" — full name, with the age when it is known. */
  guestHeadingName: string;
  bookerName: string;
  bookerFirstName: string;
  lodgeName: string;
  stayLabel: string;
  nightsLabel: string;
  answerByLabel: string;
  party: string[];
  refusalWarning: string | null;
}) {
  const [step, setStep] = useState<
    "idle" | "approving" | "declining" | "approved" | "declined" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const outcomeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (step === "approved" || step === "declined" || step === "error") {
      outcomeRef.current?.focus();
    }
  }, [step]);

  const busy = step === "approving" || step === "declining";

  async function answer(action: "APPROVE" | "DECLINE") {
    setErrorMessage("");
    setStep(action === "APPROVE" ? "approving" : "declining");
    try {
      const res = await fetch(
        `/api/bookings/${bookingId}/guests/${guestId}/consent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        // The server's refusal, word for word (D-14) — same rule as the
        // member's own card and the #2250 pattern it follows.
        setErrorMessage(
          typeof data.error === "string"
            ? data.error
            : "We could not record your answer. Please try again.",
        );
        setStep("error");
        return;
      }
      setStep(action === "APPROVE" ? "approved" : "declined");
    } catch {
      setErrorMessage("We could not record your answer. Please try again.");
      setStep("error");
    }
  }

  if (step === "approved") {
    return (
      <Card className="border-success-6 bg-success-3">
        <CardHeader>
          <CardTitle className="text-success-11">
            {guestFirstName} is on this booking
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-success-11">
          <div
            ref={outcomeRef}
            tabIndex={-1}
            role="status"
            className="space-y-3 outline-none"
          >
            <p>
              Thanks — your answer counts as {guestFirstName}&apos;s answer and
              has been recorded against your name. {guestFirstName}&apos;s place
              is confirmed, and {bookerFirstName} will be emailed.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/">Back to the home page</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (step === "declined") {
    return (
      <Card className="border-success-6 bg-success-3">
        <CardHeader>
          <CardTitle className="text-success-11">
            You&apos;ve said no for {guestFirstName}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-success-11">
          <div
            ref={outcomeRef}
            tabIndex={-1}
            role="status"
            className="space-y-3 outline-none"
          >
            <p>
              The bed that was held for {guestFirstName} has been released, and{" "}
              {bookerFirstName} will be emailed. Your answer has been recorded
              against your name.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/">Back to the home page</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary">
      <CardHeader className="space-y-2">
        <div>
          <Badge
            variant="outline"
            className="border-warning-6 bg-warning-3 text-warning-11"
          >
            Waiting for an answer
          </Badge>
        </div>
        <CardTitle>
          {bookerName} has added {guestHeadingName} to a booking
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {refusalWarning ? (
          <p className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-warning-11">
            {refusalWarning}
          </p>
        ) : null}
        {step === "error" ? (
          <div
            ref={outcomeRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-danger-11 outline-none"
          >
            {errorMessage}
          </div>
        ) : null}

        <p className="text-muted-foreground">
          You are being asked because{" "}
          <span className="font-medium text-foreground">{guestFirstName}</span>{" "}
          does not have a login of their own and you are an adult in their
          family group. Answering here counts as {guestFirstName}&apos;s answer,
          and your name is recorded against it.
        </p>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Booked by</dt>
          <dd className="font-medium">{bookerName}</dd>
          <dt className="text-muted-foreground">Lodge</dt>
          <dd className="font-medium">{lodgeName}</dd>
          <dt className="text-muted-foreground">Stay</dt>
          <dd className="font-medium">{stayLabel}</dd>
          <dt className="text-muted-foreground">
            {guestFirstName}&apos;s nights
          </dt>
          <dd className="font-medium">{nightsLabel}</dd>
          <dt className="text-muted-foreground">Answer by</dt>
          <dd className="font-medium">{answerByLabel}</dd>
        </dl>

        <div>
          <p className="mb-1 text-muted-foreground">Everyone on the booking:</p>
          <ul className="space-y-0.5">
            {party.map((name, index) => (
              <li key={index}>
                <span className="text-muted-foreground">·</span> {name}
              </li>
            ))}
          </ul>
        </div>

        {refusalWarning ? (
          <p className="text-muted-foreground">You can still say yes.</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={() => void answer("APPROVE")}>
            {step === "approving"
              ? "Recording your answer..."
              : `Yes, add ${guestFirstName}`}
          </Button>
          {refusalWarning ? null : (
            <Button
              variant="outline"
              className="border-danger-6 text-danger-11 hover:bg-danger-3"
              disabled={busy}
              onClick={() => void answer("DECLINE")}
            >
              {step === "declining" ? "Recording your answer..." : "No thanks"}
            </Button>
          )}
        </div>
        <p aria-live="polite" className="sr-only">
          {busy ? "Recording your answer..." : ""}
        </p>
      </CardContent>
    </Card>
  );
}
