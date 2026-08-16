"use client";

import type { RefObject } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * #2104: the required reason when an edit would leave minors with no adult.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690) with its accessibility wiring
 * intact and unchanged, which is the whole risk of moving a field across a
 * component boundary: the `htmlFor`/`id` pair, the `aria-invalid`, the
 * `aria-describedby` that points at the error's own id, and the `role="alert"`
 * on the error itself. The ref is the panel's, because the latch effect scrolls
 * to it from a hook that does not render anything.
 *
 * The inline error sits WITH the field rather than in the panel's bottom
 * `saveError` slot, so a member cannot miss it.
 */
export function ReviewJustificationField({
  value,
  error,
  fieldRef,
  onChange,
  onClearError,
}: {
  value: string;
  error: string;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onClearError: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-warning/20 bg-warning-muted p-4">
      <Label htmlFor="edit-review-justification" className="text-warning">
        Reason for leaving no adult on the booking (required)
      </Label>
      <p className="text-sm text-warning">
        This change would leave the minors on this booking with no adult. Please
        explain why so an admin can review it. The booking is blocked from lodge
        check-in until an admin approves it.
      </p>
      <Textarea
        id="edit-review-justification"
        ref={fieldRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (error) onClearError();
        }}
        rows={3}
        maxLength={1000}
        placeholder="Explain why an adult is not on the booking..."
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "edit-review-justification-error" : undefined}
      />
      {error && (
        <p
          id="edit-review-justification-error"
          role="alert"
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
