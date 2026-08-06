"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Permanently mounted assertive feedback for an action that failed away from
 * the user's current focus. Registering the empty live region up front avoids
 * screen-reader/browser pairs missing an alert that is inserted already
 * populated. When a failure arrives, move focus without the browser's default
 * jump and then scroll the recovery message into view.
 */
export function FocusedActionError({
  id,
  error,
  heading,
  attentionKey,
  className,
}: {
  id: string;
  error: string;
  heading?: string;
  attentionKey?: number;
  className?: string;
}) {
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!error) return;
    const alert = errorRef.current;
    if (!alert) return;
    alert.focus({ preventScroll: true });
    alert.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [attentionKey, error]);

  return (
    <div
      id={id}
      ref={errorRef}
      role="alert"
      aria-atomic="true"
      tabIndex={-1}
      className={
        error
          ? cn(
              "rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11 outline-none",
              className,
            )
          : "sr-only"
      }
    >
      {error ? (
        heading ? (
          <>
            <p className="font-medium">{heading}</p>
            <p className="mt-1">{error}</p>
          </>
        ) : (
          error
        )
      ) : null}
    </div>
  );
}
