"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import { formatNZDate } from "@/lib/nzst-date";

/**
 * Member-facing "Acknowledge" control, shown only for notices that require
 * acknowledgement. Posts to the acknowledge route (memberId comes from the
 * session server-side) and reflects the acknowledged state.
 */
export function NoticeAcknowledgeButton({
  noticeId,
  acknowledged: initialAcknowledged,
  acknowledgedAt,
}: {
  noticeId: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
}) {
  const router = useRouter();
  const [acknowledged, setAcknowledged] = useState(initialAcknowledged);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (acknowledged) {
    return (
      <p className="inline-flex items-center gap-2 text-sm font-medium text-success-11">
        <Check className="h-4 w-4" />
        Acknowledged
        {acknowledgedAt
          ? ` on ${formatNZDate(new Date(acknowledgedAt))}`
          : ""}
      </p>
    );
  }

  const acknowledge = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/notices/${noticeId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        setError("Could not record your acknowledgement. Please try again.");
        return;
      }
      setAcknowledged(true);
      router.refresh();
    } catch {
      setError("Could not record your acknowledgement. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button onClick={acknowledge} disabled={submitting}>
        {submitting ? "Saving…" : "Acknowledge"}
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
