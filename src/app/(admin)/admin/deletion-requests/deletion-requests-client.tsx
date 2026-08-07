"use client";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  FieldHint,
  describedByFieldHint,
} from "@/components/ui/field-hint";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  ADMIN_VIEW_ONLY_ACTION_REASON,
  useAdminAreaEditAccess,
} from "@/hooks/use-admin-area-edit-access";
import { formatNZDate, formatNZDateTime } from "@/lib/nzst-date";
import { FocusedActionError } from "@/components/focused-action-error";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

/** #2264 — the rejection-reason hint id, spelled once. Only one review dialog
 *  is mounted at a time, so a fixed id cannot collide. */
const REVIEW_NOTE_HINT_ID = "review-note-hint";

interface DeletionRequestMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  active: boolean;
}

interface DeletionRequest {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string | null;
  adminNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  member: DeletionRequestMember;
}

interface ApiResponse {
  requests: DeletionRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Admin-initiated hard-delete review requests (MemberLifecycleActionRequest,
// action DELETE). Distinct from the self-service DeletionRequest above.
interface LifecycleRequest {
  id: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  reason: string;
  reviewNote: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  requestedByMemberId: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  targetName: string;
  member: { id: string; name: string; email: string } | null;
}

interface LifecycleApiResponse {
  requests: LifecycleRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function DeletionRequestsClient({
  sessionMemberId,
}: {
  sessionMemberId: string;
}) {
  // Approve/reject write the membership-area deletion routes; a view-only
  // membership admin browses the queues but cannot act (#1997).
  const canEdit = useAdminAreaEditAccess("membership");
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [page, setPage] = useState(1);
  const [adminInitiatedPage, setAdminInitiatedPage] = useState(1);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAttentionVersion, setErrorAttentionVersion] = useState(0);
  const [deletionRecovery, setDeletionRecovery] = useState<{
    request: DeletionRequest;
    note: string;
    cancelledBookings: number;
    cancellationPending: boolean;
    retryBookingId: string | null;
    message: string;
  } | null>(null);

  const [reviewDialog, setReviewDialog] = useState<{
    request: DeletionRequest;
    action: "approve" | "reject";
  } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        page: String(page),
      });
      const res = await fetch(`/api/admin/deletion-requests?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      setData(await res.json());
      return true;
    } catch {
      setError("Failed to load deletion requests.");
      return false;
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  function showActionError(message: string) {
    setError(message);
    setErrorAttentionVersion((version) => version + 1);
  }

  // #1788: `notifyMember` is only meaningful on the reject path (the approve
  // path always sends the final privacy receipt). Absent = notify (default),
  // false = suppress the member email.
  async function handleReview(notifyMember?: boolean) {
    if (!reviewDialog) return;
    const pendingReview = reviewDialog;
    const pendingNote = reviewNote;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/admin/deletion-requests/${reviewDialog.request.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: reviewDialog.action,
            note: reviewNote || undefined,
            ...(notifyMember === undefined ? {} : { notifyMember }),
          }),
        }
      );
      const body = await res.json();
      if (!res.ok) {
        if (
          pendingReview.action === "approve" &&
          body.remainingCleanupPending === true &&
          typeof body.cancelledBookings === "number" &&
          (body.memberAnonymised === false ||
            body.memberDataAnonymised === false) &&
          body.approvalReceiptSent === false
        ) {
          const cancelledBookings = Math.max(0, body.cancelledBookings);
          const cancellationPending = body.cancellationPending === true;
          const retryBookingId =
            cancellationPending && typeof body.retryBookingId === "string"
              ? body.retryBookingId
              : null;
          const cancelledCopy =
            cancelledBookings === 1
              ? "1 future booking was cancelled."
              : `${cancelledBookings} future bookings were cancelled.`;
          const cancellationCopy = cancellationPending
            ? " One remaining booking still needs cancellation."
            : " The discovered booking cancellations completed.";
          const recoveryBase = `${cancelledCopy}${cancellationCopy} The member's data was not anonymised and no approval receipt was sent. Retry only the remaining cleanup.`;

          setReviewDialog(null);
          setDeletionRecovery({
            request: pendingReview.request,
            note: pendingNote,
            cancelledBookings,
            cancellationPending,
            retryBookingId,
            message: recoveryBase,
          });
          showActionError(recoveryBase);
          const refreshed = await fetchRequests();
          const refreshResult = refreshed
            ? " The latest deletion queue was loaded."
            : " The deletion queue could not be refreshed. This recovery warning remains active.";
          setDeletionRecovery((current) =>
            current
              ? { ...current, message: `${recoveryBase}${refreshResult}` }
              : current,
          );
          setErrorAttentionVersion((version) => version + 1);
          return;
        }
        throw new Error(body.error || "Failed");
      }
      setReviewDialog(null);
      setReviewNote("");
      setDeletionRecovery(null);
      await fetchRequests();
    } catch (err) {
      setReviewDialog(null);
      showActionError(
        err instanceof Error ? err.message : "Failed to process request",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const statusBadge = (status: string) => {
    if (status === "PENDING")
      return (
        <Badge className="bg-warning-3 text-warning-11 border-warning-6">
          Pending
        </Badge>
      );
    if (status === "APPROVED")
      return (
        <Badge className="bg-success-3 text-success-11 border-success-6">
          Approved
        </Badge>
      );
    return (
      <Badge className="bg-danger-3 text-danger-11 border-danger-6">Rejected</Badge>
    );
  };

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view deletion requests but cannot approve or reject
      them.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Deletion Requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review member account deletion requests. Members can request deletion
          of their own account; admins can request permanent (hard) deletion of
          a member record added in error. Hard-delete requests require a second
          admin to approve.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Member self-service requests</CardTitle>
              <CardDescription>
                {data ? `${data.total} total` : "Loading..."}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(1);
                  setAdminInitiatedPage(1);
                }}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="APPROVED">Approved</SelectItem>
                  <SelectItem value="REJECTED">Rejected</SelectItem>
                  <SelectItem value="ALL">All</SelectItem>
                </SelectContent>
              </Select>
              <DatasetResetButton
                disabled={
                  statusFilter === "PENDING" &&
                  page === 1 &&
                  adminInitiatedPage === 1
                }
                onReset={() => {
                  setStatusFilter("PENDING");
                  setPage(1);
                  setAdminInitiatedPage(1);
                }}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <FocusedActionError
            id="deletion-requests-error"
            error={deletionRecovery?.message ?? error ?? ""}
            attentionKey={errorAttentionVersion}
            heading={
              deletionRecovery
                ? "Deletion approval partially completed"
                : undefined
            }
            action={
              deletionRecovery ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setReviewNote(deletionRecovery.note);
                      setReviewDialog({
                        request: deletionRecovery.request,
                        action: "approve",
                      });
                    }}
                  >
                    Retry remaining cleanup
                  </Button>
                  {deletionRecovery.retryBookingId ? (
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={buildHrefWithReturnTo(
                          `/admin/bookings/${encodeURIComponent(deletionRecovery.retryBookingId)}`,
                          "/admin/deletion-requests",
                        )}
                      >
                        Open pending booking
                      </Link>
                    </Button>
                  ) : null}
                </div>
              ) : error ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setError(null)}
                >
                  Dismiss
                </Button>
              ) : undefined
            }
          />
          {loading && (
            <p className="text-sm text-muted-foreground py-4">Loading...</p>
          )}
          {!loading && data && data.requests.length === 0 && (
            <p className="text-sm text-muted-foreground py-4">
              No {statusFilter === "ALL" ? "" : statusFilter.toLowerCase()}{" "}
              deletion requests.
            </p>
          )}
          {!loading && data && data.requests.length > 0 && (
            <div className="divide-y">
              {data.requests.map((req) => (
                <div key={req.id} className="py-4 space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-foreground">
                          {req.member.firstName} {req.member.lastName}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {req.member.email}
                        </span>
                        {statusBadge(req.status)}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Requested {formatNZDateTime(new Date(req.createdAt))}
                      </p>
                      {req.reason && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">Reason:</span>{" "}
                          {req.reason}
                        </p>
                      )}
                      {req.adminNote && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">Admin note:</span>{" "}
                          {req.adminNote}
                        </p>
                      )}
                      {req.reviewedAt && (
                        <p className="text-xs text-muted-foreground">
                          Reviewed{" "}
                          {formatNZDate(new Date(req.reviewedAt))}
                        </p>
                      )}
                    </div>
                    {req.status === "PENDING" && (
                      <div className="flex gap-2 shrink-0">
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          size="sm"
                          variant="outline"
                          className="text-danger-11 border-danger-6 hover:bg-danger-3"
                          onClick={() =>
                            setReviewDialog({ request: req, action: "reject" })
                          }
                          disabled={deletionRecovery?.request.id === req.id}
                        >
                          Reject
                        </ViewOnlyActionButton>
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            setReviewDialog({ request: req, action: "approve" })
                          }
                          disabled={deletionRecovery?.request.id === req.id}
                        >
                          Approve
                        </ViewOnlyActionButton>
                      </div>
                    )}
                    {deletionRecovery?.request.id === req.id ? (
                      <p className="text-xs text-warning-11">
                        Partial cleanup recovery is active above; use Retry remaining cleanup.
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {data.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AdminInitiatedDeletionSection
        sessionMemberId={sessionMemberId}
        statusFilter={statusFilter}
        statusBadge={statusBadge}
        page={adminInitiatedPage}
        setPage={setAdminInitiatedPage}
      />

      {/* Review Dialog (self-service) */}
      <Dialog
        open={!!reviewDialog}
        onOpenChange={(open) => {
          if (!open) {
            setReviewDialog(null);
            setReviewNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewDialog?.action === "approve"
                ? "Approve Deletion Request"
                : "Reject Deletion Request"}
            </DialogTitle>
            <DialogDescription>
              {reviewDialog?.action === "approve" ? (
                <>
                  This will permanently anonymise{" "}
                  <strong>
                    {reviewDialog.request.member.firstName}{" "}
                    {reviewDialog.request.member.lastName}
                  </strong>
                  &apos;s account, cancel all future bookings, and deactivate
                  their login. This action cannot be undone.
                </>
              ) : reviewDialog?.request.member.email ? (
                <>
                  Choose below whether to email the member that their request
                  was not approved — either way the request is rejected.
                </>
              ) : (
                <>
                  The request will be rejected. This member has no email address
                  on file, so no notification is sent.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="review-note">
              {reviewDialog?.action === "approve"
                ? "Note (optional)"
                : "Reason for rejection (optional — will be sent to member)"}
            </Label>
            <Textarea
              id="review-note"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              /* #2264 — the APPROVE branch is a genuine instruction ("Internal
                 note") and stays inside the box. The REJECT branch was an
                 example of a reason, which read as a reason already typed, so
                 it moves to the hint below. A deterministic id rather than
                 `useFieldHint` because the hint only exists on one branch —
                 an always-spread `aria-describedby` would dangle on the other. */
              placeholder={
                reviewDialog?.action === "reject" ? undefined : "Internal note"
              }
              aria-describedby={
                reviewDialog?.action === "reject"
                  ? describedByFieldHint(REVIEW_NOTE_HINT_ID)
                  : undefined
              }
              rows={3}
            />
            {reviewDialog?.action === "reject" ? (
              <FieldHint id={REVIEW_NOTE_HINT_ID}>
                E.g. Outstanding bookings must be resolved first
              </FieldHint>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReviewDialog(null);
                setReviewNote("");
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            {reviewDialog?.action === "approve" ? (
              // The approve receipt always sends (the member asked for deletion
              // and cannot log in afterwards), so no notify choice here.
              <Button
                variant="destructive"
                onClick={() => handleReview()}
                disabled={submitting}
              >
                {submitting ? "Processing..." : "Approve & Delete Account"}
              </Button>
            ) : reviewDialog?.request.member.email ? (
              // #1788: reject with a member on file — two-button email choice.
              <>
                <Button
                  variant="outline"
                  onClick={() => handleReview(false)}
                  disabled={submitting}
                >
                  {submitting ? "Processing..." : "Reject without emailing"}
                </Button>
                <Button
                  onClick={() => handleReview(true)}
                  disabled={submitting}
                >
                  {submitting ? "Processing..." : "Reject and email member"}
                </Button>
              </>
            ) : (
              // No address on file — nothing would send, so reject directly.
              <Button onClick={() => handleReview()} disabled={submitting}>
                {submitting ? "Processing..." : "Reject Request"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}

// Admin-initiated hard-delete review queue (#1938). Fetches DELETE lifecycle
// requests via the shared list API, reusing the page's status filter through
// its PENDING->REQUESTED mapping. Approve/reject goes to the EXISTING lifecycle
// review PATCH, which enforces the second-admin rule server-side (403); the
// disabled buttons here are a UX hint, not the authority.
function AdminInitiatedDeletionSection({
  sessionMemberId,
  statusFilter,
  statusBadge,
  page,
  setPage,
}: {
  sessionMemberId: string;
  statusFilter: string;
  statusBadge: (status: string) => React.ReactNode;
  page: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
}) {
  const canEdit = useAdminAreaEditAccess("membership");
  const [data, setData] = useState<LifecycleApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAttentionVersion, setErrorAttentionVersion] = useState(0);
  const [dialog, setDialog] = useState<{
    request: LifecycleRequest;
    action: "approve" | "reject";
  } | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // The status filter lives in the parent card header; when it changes, jump
  // back to page 1 so a deep page from the previous filter is never shown.
  useEffect(() => {
    setPage(1);
  }, [setPage, statusFilter]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        action: "DELETE",
        status: statusFilter,
        page: String(page),
      });
      const res = await fetch(
        `/api/admin/member-lifecycle-action-requests?${params}`
      );
      if (!res.ok) throw new Error("Failed to load");
      setData(await res.json());
    } catch {
      setError("Failed to load admin-initiated deletion requests.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  async function submitReview() {
    if (!dialog) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/admin/member-lifecycle-action-requests/${dialog.request.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: dialog.action,
            note: note || undefined,
          }),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed");
      setDialog(null);
      setNote("");
      fetchRequests();
    } catch (err) {
      setDialog(null);
      setError(err instanceof Error ? err.message : "Failed to process request");
      setErrorAttentionVersion((version) => version + 1);
    } finally {
      setSubmitting(false);
    }
  }

  // Lifecycle requests use REQUESTED for the pending state; the shared badge
  // renderer speaks PENDING, so translate before rendering.
  const renderStatus = (status: string) =>
    statusBadge(status === "REQUESTED" ? "PENDING" : status);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin-initiated deletion requests</CardTitle>
        <CardDescription>
          Permanent hard-delete requests raised by an admin from a member
          record. A different admin must approve or reject each request.
          Filtered by the status selector above.
          {data ? ` ${data.total} total` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FocusedActionError
          id="admin-initiated-deletion-requests-error"
          error={error ?? ""}
          attentionKey={errorAttentionVersion}
          action={
            error ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setError(null)}
              >
                Dismiss
              </Button>
            ) : undefined
          }
        />
        {loading && <p className="text-sm text-muted-foreground py-4">Loading...</p>}
        {!loading && data && data.requests.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">
            No {statusFilter === "ALL" ? "" : statusFilter.toLowerCase()}{" "}
            admin-initiated deletion requests.
          </p>
        )}
        {!loading && data && data.requests.length > 0 && (
          <div className="divide-y">
            {data.requests.map((req) => {
              const isOwnRequest =
                req.requestedByMemberId === sessionMemberId;
              const requesterLabel =
                req.requestedBy?.name ||
                req.requestedBy?.email ||
                "Unknown admin";
              return (
                <div key={req.id} className="py-4 space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-foreground">
                          {req.targetName}
                        </span>
                        {req.member?.email && (
                          <span className="text-sm text-muted-foreground">
                            {req.member.email}
                          </span>
                        )}
                        {renderStatus(req.status)}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Requested by {requesterLabel} · {formatNZDateTime(new Date(req.requestedAt))}
                      </p>
                      {req.reason && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">Reason:</span>{" "}
                          {req.reason}
                        </p>
                      )}
                      {req.reviewNote && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">Review note:</span>{" "}
                          {req.reviewNote}
                        </p>
                      )}
                    </div>
                    {req.status === "REQUESTED" && (
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-danger-11 border-danger-6 hover:bg-danger-3"
                            disabled={isOwnRequest || !canEdit}
                            title={
                              !canEdit
                                ? ADMIN_VIEW_ONLY_ACTION_REASON
                                : isOwnRequest
                                  ? "A different admin must review this request"
                                  : undefined
                            }
                            onClick={() =>
                              setDialog({ request: req, action: "reject" })
                            }
                          >
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={isOwnRequest || !canEdit}
                            title={
                              !canEdit
                                ? ADMIN_VIEW_ONLY_ACTION_REASON
                                : isOwnRequest
                                  ? "A different admin must review this request"
                                  : undefined
                            }
                            onClick={() =>
                              setDialog({ request: req, action: "approve" })
                            }
                          >
                            Approve
                          </Button>
                        </div>
                        {isOwnRequest && (
                          <p className="text-xs text-muted-foreground">
                            A different admin must review this request
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {data.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.action === "approve"
                ? "Approve hard-delete request"
                : "Reject hard-delete request"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.action === "approve" ? (
                <>
                  This will permanently delete{" "}
                  <strong>{dialog.request.targetName}</strong>&apos;s member
                  record. Eligibility is re-checked at approval; this action
                  cannot be undone.
                </>
              ) : (
                <>
                  Reject the request to hard-delete{" "}
                  <strong>{dialog?.request.targetName}</strong>. The record is
                  left unchanged.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="lifecycle-review-note">Note (optional)</Label>
            <Textarea
              id="lifecycle-review-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Internal review note"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialog(null);
                setNote("");
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              variant={dialog?.action === "approve" ? "destructive" : "default"}
              onClick={submitReview}
              disabled={submitting}
            >
              {submitting
                ? "Processing..."
                : dialog?.action === "approve"
                  ? "Approve & Delete Record"
                  : "Reject Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
