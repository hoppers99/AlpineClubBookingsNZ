"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Ask an admin to make a change this member is not allowed to make themselves.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690) as pure presentation. Whether it
 * appears at all stays in the panel: the condition reads the edit policy AND the
 * text of the quote/save errors, since a refusal naming a lock is what turns an
 * ordinary edit into a request.
 */
export function ChangeRequestCard({
  reason,
  submitting,
  error,
  success,
  submitDisabled,
  onReasonChange,
  onSubmit,
}: {
  reason: string;
  submitting: boolean;
  error: string;
  success: string;
  submitDisabled: boolean;
  onReasonChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin Request</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="change-request-reason">Requested change</Label>
          <Textarea
            id="change-request-reason"
            value={reason}
            maxLength={2000}
            onChange={(event) => onReasonChange(event.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={onSubmit}
          disabled={submitDisabled}
        >
          {submitting ? "Sending..." : "Request Admin Review"}
        </Button>
        {error && (
          <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-md bg-success-3 p-3 text-sm text-success-11">
            {success}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
