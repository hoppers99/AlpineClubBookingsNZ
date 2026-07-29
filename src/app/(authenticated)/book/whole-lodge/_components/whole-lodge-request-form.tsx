"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Lodge = { id: string; name: string };

/*
  #2263 — the member's whole-lodge request form.

  What is NOT here is the design. There is no availability calendar, no "N beds
  left" hint, no live price and no capacity pre-check, because every one of them
  answers the question a member may not have answered: is the lodge free — or
  already held for somebody else — that week? (ADR-001 decision 6 / D11.)

  The acknowledgement below is likewise fixed. It is what the server sends back
  for EVERY schema-valid submission, and it echoes nothing the member typed —
  no dates, no headcount, no reference number. An echo is a channel, and a
  channel that varies with the calendar is the leak this whole feature is shaped
  around avoiding.
*/

export function WholeLodgeRequestForm() {
  const [lodges, setLodges] = useState<Lodge[]>([]);
  const [lodgeId, setLodgeId] = useState<string>("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [headcount, setHeadcount] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const headcountHint = useFieldHint();
  const groupHint = useFieldHint();
  const notesHint = useFieldHint();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/lodges")
      .then((response) => (response.ok ? response.json() : { lodges: [] }))
      .then((data: { lodges?: Lodge[] }) => {
        if (cancelled) return;
        const list = data.lodges ?? [];
        setLodges(list);
        // ADR-002 presentation rule: a single-lodge club never sees lodge copy.
        if (list.length > 1) setLodgeId(list[0].id);
      })
      .catch(() => {
        // The picker is only ever offered for a multi-lodge club; failing to
        // load it just means the request goes to the club's default lodge.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/booking-requests/whole-lodge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkIn,
          checkOut,
          headcount: Number(headcount),
          groupDescription,
          notes: notes.trim() ? notes : undefined,
          ...(lodges.length > 1 && lodgeId ? { lodgeId } : {}),
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || "Could not send your request");
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your request");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Request sent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* FIXED COPY. Identical whatever the member asked for and whatever
              the lodge's state is on those nights. */}
          <p>
            Thanks — your whole-lodge request has been sent to the booking
            officer. They will be in touch to confirm what is possible.
          </p>
          <p className="text-sm text-muted-foreground">
            You can see it under <strong>My requests</strong> on My bookings.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/bookings">Go to My bookings</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/book">Back to Book a Stay</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <Alert variant="error">{error}</Alert>
          )}

          {lodges.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="whole-lodge-lodge">Lodge</Label>
              <Select value={lodgeId} onValueChange={setLodgeId}>
                <SelectTrigger id="whole-lodge-lodge">
                  <SelectValue placeholder="Choose a lodge" />
                </SelectTrigger>
                <SelectContent>
                  {lodges.map((lodge) => (
                    <SelectItem key={lodge.id} value={lodge.id}>
                      {lodge.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="whole-lodge-check-in">Arriving</Label>
              <Input
                id="whole-lodge-check-in"
                type="date"
                required
                value={checkIn}
                onChange={(event) => setCheckIn(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="whole-lodge-check-out">Leaving</Label>
              <Input
                id="whole-lodge-check-out"
                type="date"
                required
                value={checkOut}
                onChange={(event) => setCheckOut(event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="whole-lodge-headcount">
              Roughly how many people?
            </Label>
            <Input
              id="whole-lodge-headcount"
              type="number"
              min={1}
              required
              value={headcount}
              onChange={(event) => setHeadcount(event.target.value)}
              {...headcountHint.fieldProps}
            />
            <FieldHint {...headcountHint.hintProps}>
              An estimate is fine — the booking officer will confirm the final
              number with you before anything is charged. We do not need guest
              names yet.
            </FieldHint>
          </div>

          <div className="space-y-2">
            <Label htmlFor="whole-lodge-group">Who is the group?</Label>
            <Textarea
              id="whole-lodge-group"
              required
              rows={3}
              maxLength={500}
              value={groupDescription}
              onChange={(event) => setGroupDescription(event.target.value)}
              {...groupHint.fieldProps}
            />
            <FieldHint {...groupHint.hintProps}>
              Example: the club&apos;s alpine skills course, or a family
              gathering for a 70th.
            </FieldHint>
          </div>

          <div className="space-y-2">
            <Label htmlFor="whole-lodge-notes">
              Anything else we should know? (optional)
            </Label>
            <Textarea
              id="whole-lodge-notes"
              rows={3}
              maxLength={400}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              {...notesHint.fieldProps}
            />
            <FieldHint {...notesHint.hintProps}>
              Arrival times, catering plans, or anything that would help the
              booking officer.
            </FieldHint>
          </div>

          <p className="text-sm text-muted-foreground">
            This is a request, not a booking. Nothing is reserved and nothing is
            charged until the booking officer confirms it with you.
          </p>

          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Sending..." : "Send request"}
            </Button>
            {/* No `type` here: asChild renders the Link's anchor, and `type` on
                an <a> means a MIME type hint, not a button behaviour. */}
            <Button asChild variant="outline">
              <Link href="/book">Cancel</Link>
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
