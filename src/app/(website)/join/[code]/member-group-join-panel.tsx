"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ClubIdentity } from "@/config/club-identity-types";
import {
  getFamilyMemberBookingActionLabel,
  getFamilyMemberBookingBlockMessage,
  type BookingFamilyMember,
} from "@/lib/family-booking";
import { formatNZDate } from "@/lib/nzst-date";

interface GroupSummary {
  code: string;
  status: string;
  paymentMode: "EACH_PAYS_OWN" | "ORGANISER_PAYS";
  organiserFirstName: string;
  checkIn: string;
  checkOut: string;
  joinDeadline: string | null;
  isJoinable: boolean;
}

interface FamilyMember extends BookingFamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

/**
 * Logged-in member self-add for a group booking. Mirrors the family quick-add on
 * the book page: the member picks themselves and any bookable family members and
 * POSTs to the authenticated /join endpoint. Non-member friends still use the
 * public request form (GroupJoinPageClient); this panel only adds members.
 *
 * It reads no client session context (the (website) layout has no SessionProvider)
 * — the server component renders it only for a logged-in visitor, and the join +
 * family fetches ride the session cookie.
 */
export function MemberGroupJoinPanel({
  club,
  code,
}: {
  club: ClubIdentity;
  code: string;
}) {
  const router = useRouter();

  const [summary, setSummary] = useState<GroupSummary | null>(null);
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/group-bookings/${encodeURIComponent(code)}`).then(async (res) =>
        res.ok ? ((await res.json()) as GroupSummary) : null
      ),
      fetch("/api/members/family")
        .then((res) => (res.ok ? res.json() : { familyMembers: [] }))
        .then((data) => (data.familyMembers || []) as FamilyMember[])
        .catch(() => [] as FamilyMember[]),
    ])
      .then(([summaryData, family]) => {
        if (cancelled) return;
        if (!summaryData) {
          setNotFound(true);
          return;
        }
        setSummary(summaryData);
        setFamilyMembers(family);
        // Pre-select the member themselves (the common self-add case).
        const self = family.find((fm) => fm.relationship === "self");
        if (self && self.canBeBooked !== false) {
          setSelectedIds(new Set([self.id]));
        }
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  function toggle(id: string) {
    setError("");
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const selectedMembers = familyMembers.filter((fm) => selectedIds.has(fm.id));
  const canSubmit = selectedMembers.length > 0 && !submitting;

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(
        `/api/group-bookings/${encodeURIComponent(code)}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            guests: selectedMembers.map((fm) => ({
              firstName: fm.firstName,
              lastName: fm.lastName,
              ageTier: fm.ageTier,
              isMember: true,
              memberId: fm.id,
            })),
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to join right now.");
      }
      // EACH_PAYS_OWN joiners owe for their beds — send them to the booking to
      // pay. ORGANISER_PAYS (and $0) joins are done, so confirm in place.
      if (data.requiresPayment && data.bookingId) {
        router.push(`/bookings/${data.bookingId}`);
        return;
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to join right now.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-lg items-center justify-center p-4">
        <Card className="w-full">
          <CardContent className="py-8 text-center text-muted-foreground">
            Loading...
          </CardContent>
        </Card>
      </div>
    );
  }

  if (notFound || !summary) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-lg items-center justify-center p-4">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Group booking not found</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            We couldn&apos;t find a group booking for this link. Please check you copied the whole
            link from the organiser, or ask them to share it again.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg p-4">
      <Card>
        <CardHeader>
          <CardTitle>
            Join {summary.organiserFirstName}&apos;s group at {club.lodgeName}
          </CardTitle>
          <CardDescription>
            {formatNZDate(new Date(summary.checkIn))} to {formatNZDate(new Date(summary.checkOut))}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!summary.isJoinable ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <Info className="h-5 w-5 shrink-0" />
              <p>
                This group is no longer accepting new joiners
                {summary.joinDeadline
                  ? ` (the deadline was ${formatNZDate(new Date(summary.joinDeadline))})`
                  : ""}
                . Please contact the organiser if you think this is a mistake.
              </p>
            </div>
          ) : submitted ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-emerald-700">
                <CheckCircle2 className="h-6 w-6 shrink-0" />
                <p className="font-medium">You&apos;re in!</p>
              </div>
              <p className="text-sm text-muted-foreground">
                {summary.paymentMode === "ORGANISER_PAYS"
                  ? `${summary.organiserFirstName} is settling the beds for this group, so there's nothing more to pay. We've added you to the group.`
                  : "You've been added to the group."}
              </p>
              <Button variant="outline" onClick={() => router.push("/bookings")}>
                View my bookings
              </Button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Add yourself and your family to {summary.organiserFirstName}&apos;s group.
                {summary.paymentMode === "ORGANISER_PAYS"
                  ? ` ${summary.organiserFirstName} is paying for the group, so you won't be charged.`
                  : " You'll be taken to pay for your beds after joining."}
              </p>

              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Who is coming?</p>
                <div className="grid gap-2">
                  {familyMembers.map((fm) => {
                    const selected = selectedIds.has(fm.id);
                    const blocked = fm.canBeBooked === false;
                    const label =
                      fm.relationship === "self"
                        ? `${fm.firstName} ${fm.lastName} (You)`
                        : `${fm.firstName} ${fm.lastName} (${fm.ageTier})`;
                    const blockMessage = getFamilyMemberBookingBlockMessage(fm);
                    const actionLabel = getFamilyMemberBookingActionLabel(fm);
                    return (
                      <div
                        key={fm.id}
                        className={blocked ? "rounded-md border border-amber-200 bg-amber-50 p-3" : ""}
                      >
                        <Button
                          type="button"
                          variant={selected ? "default" : "outline"}
                          size="sm"
                          disabled={blocked}
                          onClick={() => toggle(fm.id)}
                          className="w-full justify-start"
                        >
                          {selected ? "✓ " : "+ "}
                          {label}
                        </Button>
                        {blocked && blockMessage && (
                          <p className="mt-2 text-sm text-amber-800">{blockMessage}</p>
                        )}
                        {blocked && actionLabel && (
                          <p className="mt-1 text-xs font-medium text-amber-800">{actionLabel}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Bringing a non-member friend? They can join with the same link without signing in.
                </p>
              </div>

              {error ? (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <Button onClick={submit} disabled={!canSubmit} className="w-full">
                {submitting
                  ? "Joining..."
                  : summary.paymentMode === "ORGANISER_PAYS"
                    ? "Join group"
                    : "Join and pay"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
