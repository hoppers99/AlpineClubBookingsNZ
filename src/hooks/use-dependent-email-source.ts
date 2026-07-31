"use client";

import { useEffect, useState } from "react";

export type DependentEmailSourceSummary = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

export type DependentEmailSourceState =
  /** Nothing selected to resolve — the caller shows nothing. */
  | { status: "idle"; source: null; error: "" }
  | { status: "loading"; source: null; error: "" }
  /** Resolved. `source: null` means nobody in reach can receive club email. */
  | { status: "ready"; source: DependentEmailSourceSummary | null; error: "" }
  | { status: "error"; source: null; error: string };

const IDLE: DependentEmailSourceState = {
  status: "idle",
  source: null,
  error: "",
};

/**
 * WHERE A DEPENDENT'S CLUB EMAIL WOULD ACTUALLY GO if they were recorded under
 * `parentId` (#2282).
 *
 * Both link dialogs let the admin choose which parent the notifications route
 * through, and the label they used to show was the parent's own name — while
 * the write walked PAST a young or address-less parent and stored the nearest
 * adult ancestor instead. This asks the server the same question the write
 * asks, so the dialogs can name the mailbox rather than the middleman, and can
 * refuse before saving when the answer is "nobody".
 *
 * `parentId` of `""`/`null` is the "use their own email" choice: no walk, no
 * request, `idle`. Responses are discarded when the selection changes or the
 * dialog unmounts, so a slow answer for a previous choice can never overwrite a
 * newer one.
 */
export function useDependentEmailSource(
  parentId: string | null | undefined,
): DependentEmailSourceState {
  const [state, setState] = useState<DependentEmailSourceState>(IDLE);
  const id = parentId?.trim() || "";

  useEffect(() => {
    if (!id) {
      setState(IDLE);
      return;
    }

    let cancelled = false;
    setState({ status: "loading", source: null, error: "" });

    (async () => {
      try {
        const res = await fetch(
          `/api/admin/members/${encodeURIComponent(id)}/dependent-email-source`,
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            data.error || "Could not check where notifications would go",
          );
        }
        if (!cancelled) {
          setState({
            status: "ready",
            source: (data.source ??
              null) as DependentEmailSourceSummary | null,
            error: "",
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            source: null,
            error:
              err instanceof Error
                ? err.message
                : "Could not check where notifications would go",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  // Derived at render time, like `useDebouncedMemberSearch`: clearing the
  // selection must not show the previous answer for a frame.
  return id ? state : IDLE;
}
