"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { formatNZDate, formatNZDateTime } from "@/lib/nzst-date";
import { formatPolicyExceptionRequestAge } from "@/lib/booking-exception-requests";

/**
 * #2526 — the Booking Officer's booking-policy exception queue.
 *
 * One list for both request flavours (a new booking nobody has made yet, and a
 * change to a live booking), because the officer's question is the same for
 * both: what did the member ask for, which rule does it break, how long have
 * they been waiting, and do we allow it this once?
 *
 * What the card deliberately shows:
 *  - the REQUEST AGE, in plain English, because "how long has this person been
 *    waiting" is half the decision and a raw timestamp makes the officer do the
 *    subtraction;
 *  - the FROZEN EVIDENCE — the exact rules, at the exact policy revision, that
 *    were tripping when the member asked. Approving overrides those and nothing
 *    else; if the policy has moved since, the approval refuses and says so
 *    rather than quietly overriding a rule nobody reviewed;
 *  - whether the request HOLDS BEDS while it waits;
 *  - the last capacity conflict, when an approval has already been kept pending.
 */

type StatusFilter =
  | "REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED"
  | "SUPERSEDED"
  | "ALL";

const STATUS_FILTERS: StatusFilter[] = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "SUPERSEDED",
  "ALL",
];

interface PolicyRef {
  reasonCode: string;
  policyId: string;
  policyVersion: number;
  capacityMode: string;
}

interface QueueItem {
  source: "NEW_BOOKING" | "MODIFICATION";
  id: string;
  status: string;
  createdAt: string;
  version: number;
  bookingId: string | null;
  lodgeId: string | null;
  requestedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  reviewedBy: { id: string; firstName: string; lastName: string } | null;
  reviewedAt: string | null;
  memberMessage: string | null;
  proposalHash: string | null;
  aggregateCapacityMode: "HOLD" | "NO_HOLD" | null;
  reasonCodes: string[];
  policyRefs: PolicyRef[];
  affectedNights: string[];
  proposedCheckIn: string | null;
  proposedCheckOut: string | null;
  proposedGuestCount: number | null;
  adminNotes: string | null;
  createdBookingId: string | null;
  attemptCount: number;
  conflictCount: number;
  lastConflictAt: string | null;
  lastConflictReason: string | null;
  supersededByRequestId: string | null;
  summary: string | null;
}

const REASON_LABELS: Record<string, string> = {
  MINIMUM_STAY: "Minimum stay",
  ADULT_MEMBER_HOSTING_REQUIRED: "Adult member must host",
};

function reasonLabel(code: string) {
  return REASON_LABELS[code] ?? code;
}

function statusBadgeClass(status: string) {
  if (status === "REQUESTED") return "border-warning-6 bg-warning-3 text-warning-11";
  if (status === "APPROVED") return "border-success-6 bg-success-3 text-success-11";
  return "border-border bg-muted text-muted-foreground";
}

function formatDate(value: string | null) {
  return value ? formatNZDate(new Date(value)) : "—";
}

export interface PolicyExceptionRequestsPanelProps {
  basePath?: string;
  showHeading?: boolean;
  canEdit?: boolean;
}

export function PolicyExceptionRequestsPanel({
  basePath = "/admin/booking-requests?tab=exceptions",
  showHeading = false,
  canEdit = true,
}: PolicyExceptionRequestsPanelProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("REQUESTED");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Re-rendered on a timer so the plain-English age on an open queue stays true
  // instead of freezing at whatever it was when the page loaded.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/booking-exception-requests?status=${filter}&pageSize=100`,
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to load exception requests");
      }
      setItems(Array.isArray(data?.data) ? data.data : []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load exception requests",
      );
    } finally {
      setLoading(false);
    }
  }, [filter, setError, setItems, setLoading]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  function resetDecisionForm() {
    setOpenId(null);
    setNotes("");
    setConfirmed(false);
  }

  async function decide(item: QueueItem, action: "approve" | "reject") {
    setBusyId(item.id);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/booking-exception-requests/${item.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            source: item.source,
            expectedVersion: item.version,
            adminNotes: notes.trim() || undefined,
            ...(action === "approve" ? { confirm: true } : {}),
          }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // A kept-pending answer is NOT a failure of the officer's intent: the
        // request is still open and can be approved once beds free up. Say that
        // in those words rather than showing a bare error.
        throw new Error(
          data?.keptPending
            ? `${data.error} The request is still pending.`
            : data.error || "The decision could not be recorded",
        );
      }
      toast.success(
        action === "approve"
          ? data.createdBookingId
            ? "Approved — the booking has been created."
            : "Approved — the change has been applied to the booking."
          : "Request refused. The member keeps their existing booking.",
      );
      resetDecisionForm();
      await fetchItems();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The decision could not be recorded",
      );
    } finally {
      setBusyId(null);
    }
  }

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view booking-policy exception requests but cannot
      approve or refuse them. Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
        {showHeading ? (
          <div>
            <h1 className="text-3xl font-bold">Booking-policy exceptions</h1>
            <p className="mt-1 text-muted-foreground">
              Members ask here when a booking rule would otherwise stop them.
            </p>
          </div>
        ) : null}

        <p className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          Approving executes the exact proposal shown — it creates the booking,
          or applies the change, in one step. It overrides only the rules listed
          on the card, and nothing else: lodge capacity, payment, membership and
          privacy rules all still apply, and a booking that is waiting on any
          admin review still cannot check in until that review is cleared.
        </p>

        {error && (
          <div className="rounded-md bg-destructive/10 px-4 py-3 text-destructive">
            {error}
            <button onClick={() => setError("")} className="ml-2 underline">
              Dismiss
            </button>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((status) => (
            <Button
              key={status}
              variant={filter === status ? "default" : "outline"}
              size="sm"
              onClick={() => {
                resetDecisionForm();
                setFilter(status);
              }}
            >
              {status === "ALL"
                ? "All"
                : status.charAt(0) + status.slice(1).toLowerCase()}
            </Button>
          ))}
        </div>

        {loading ? (
          <div className="py-8 text-center">Loading...</div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            No {filter === "ALL" ? "" : `${filter.toLowerCase()} `}booking-policy
            exception requests.
          </div>
        ) : (
          <div className="space-y-4">
            {items.map((item) => {
              const requester = item.requestedBy
                ? `${item.requestedBy.firstName} ${item.requestedBy.lastName}`
                : "Unknown member";
              const age = formatPolicyExceptionRequestAge(
                new Date(item.createdAt),
                new Date(now),
              );
              const isOpen = openId === item.id;
              const needsReason =
                item.reasonCodes.includes("ADULT_MEMBER_HOSTING_REQUIRED");
              const hasNotes = notes.trim().length > 0;

              return (
                <Card key={item.id}>
                  <CardHeader>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <CardTitle className="text-lg">{requester}</CardTitle>
                        <p className="text-sm text-muted-foreground">
                          {item.source === "NEW_BOOKING"
                            ? "New booking"
                            : "Change to an existing booking"}{" "}
                          · asked {age} ({formatNZDateTime(new Date(item.createdAt))})
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={statusBadgeClass(item.status)}
                        >
                          {item.status}
                        </Badge>
                        <Badge variant="outline">
                          {item.aggregateCapacityMode === "HOLD"
                            ? "Holding beds"
                            : "No beds held"}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <span className="text-muted-foreground">
                          Proposed dates:
                        </span>{" "}
                        {formatDate(item.proposedCheckIn)} to{" "}
                        {formatDate(item.proposedCheckOut)}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Guests:</span>{" "}
                        {item.proposedGuestCount ?? "—"}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Attempts:</span>{" "}
                        {item.attemptCount}
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          Capacity conflicts:
                        </span>{" "}
                        {item.conflictCount}
                      </div>
                    </div>

                    <div className="rounded-md border bg-muted p-3 text-sm">
                      <p className="font-medium text-foreground">
                        Rules this request breaks
                      </p>
                      <ul className="mt-2 space-y-1 text-muted-foreground">
                        {item.policyRefs.length > 0
                          ? item.policyRefs.map((ref) => (
                              <li key={`${ref.reasonCode}-${ref.policyId}`}>
                                {reasonLabel(ref.reasonCode)} (policy{" "}
                                <span className="font-mono">{ref.policyId}</span>{" "}
                                v{ref.policyVersion},{" "}
                                {ref.capacityMode === "HOLD"
                                  ? "holds beds"
                                  : "holds no beds"}
                                )
                              </li>
                            ))
                          : item.reasonCodes.map((code) => (
                              <li key={code}>{reasonLabel(code)}</li>
                            ))}
                      </ul>
                      {item.affectedNights.length > 0 ? (
                        <p className="mt-2 text-muted-foreground">
                          Nights affected: {item.affectedNights.join(", ")}
                        </p>
                      ) : null}
                      {item.summary ? (
                        <p className="mt-2 text-muted-foreground">
                          Requested change: {item.summary}
                        </p>
                      ) : null}
                    </div>

                    {item.memberMessage ? (
                      <div className="rounded-md border border-border p-3 text-sm">
                        <p className="font-medium text-foreground">
                          What the member said
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {item.memberMessage}
                        </p>
                      </div>
                    ) : null}

                    {item.lastConflictReason ? (
                      <p className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
                        Last approval attempt was kept pending:{" "}
                        {item.lastConflictReason}
                        {item.lastConflictAt
                          ? ` (${formatNZDateTime(new Date(item.lastConflictAt))})`
                          : ""}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap gap-3 text-sm">
                      {item.bookingId ? (
                        <Link
                          href={buildHrefWithReturnTo(
                            `/bookings/${item.bookingId}`,
                            basePath,
                          )}
                          className="text-info-11 hover:underline"
                        >
                          Open booking
                        </Link>
                      ) : null}
                      {item.createdBookingId ? (
                        <Link
                          href={buildHrefWithReturnTo(
                            `/bookings/${item.createdBookingId}`,
                            basePath,
                          )}
                          className="text-info-11 hover:underline"
                        >
                          Open the booking this created
                        </Link>
                      ) : null}
                      {item.requestedBy ? (
                        <Link
                          href={buildHrefWithReturnTo(
                            `/admin/members/${item.requestedBy.id}`,
                            basePath,
                          )}
                          className="text-info-11 hover:underline"
                        >
                          Open member
                        </Link>
                      ) : null}
                    </div>

                    {item.status === "REQUESTED" ? (
                      <div className="space-y-3 rounded-md border border-border p-3">
                        {!isOpen ? (
                          <ViewOnlyActionButton
                            canEdit={canEdit}
                            describeReason={false}
                            size="sm"
                            onClick={() => {
                              setOpenId(item.id);
                              setNotes("");
                              setConfirmed(false);
                            }}
                          >
                            Decide this request
                          </ViewOnlyActionButton>
                        ) : (
                          <>
                            <div className="space-y-1">
                              <Label htmlFor={`exception-notes-${item.id}`}>
                                Reason for the decision
                                {needsReason ? " (required)" : " (optional on approve)"}
                              </Label>
                              <Textarea
                                id={`exception-notes-${item.id}`}
                                value={notes}
                                disabled={!canEdit}
                                title={
                                  canEdit === false
                                    ? ADMIN_VIEW_ONLY_ACTION_REASON
                                    : undefined
                                }
                                onChange={(event) => setNotes(event.target.value)}
                                maxLength={2000}
                                placeholder="What you decided and why. The member sees this on a refusal, and it is kept on the booking's record."
                              />
                            </div>
                            <label className="flex items-start gap-2 text-sm">
                              <input
                                type="checkbox"
                                className="mt-1"
                                checked={confirmed}
                                disabled={!canEdit}
                                onChange={(event) =>
                                  setConfirmed(event.target.checked)
                                }
                              />
                              <span>
                                I have read the proposal above and I am applying
                                this exception.
                              </span>
                            </label>
                            <div className="flex flex-wrap gap-2">
                              <ViewOnlyActionButton
                                canEdit={canEdit}
                                describeReason={false}
                                size="sm"
                                onClick={() => decide(item, "approve")}
                                disabled={
                                  busyId === item.id ||
                                  !confirmed ||
                                  (needsReason && !hasNotes)
                                }
                              >
                                Approve and apply
                              </ViewOnlyActionButton>
                              <ViewOnlyActionButton
                                canEdit={canEdit}
                                describeReason={false}
                                size="sm"
                                variant="outline"
                                onClick={() => decide(item, "reject")}
                                disabled={busyId === item.id || !hasNotes}
                              >
                                Refuse
                              </ViewOnlyActionButton>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={resetDecisionForm}
                                disabled={busyId === item.id}
                              >
                                Cancel
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                        {item.status.charAt(0) + item.status.slice(1).toLowerCase()}
                        {item.reviewedAt
                          ? ` on ${formatNZDateTime(new Date(item.reviewedAt))}`
                          : ""}
                        {item.reviewedBy
                          ? ` by ${item.reviewedBy.firstName} ${item.reviewedBy.lastName}`
                          : ""}
                        {item.adminNotes ? (
                          <p className="mt-2 whitespace-pre-wrap">
                            {item.adminNotes}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
