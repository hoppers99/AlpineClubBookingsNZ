"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
import type { Guest, NewGuest } from "@/components/edit-booking/types";

/**
 * The no-adult review reason (#2104), and the latch that releases it when the
 * member fixes the party instead of writing one.
 *
 * Extracted from `edit-booking-panel.tsx` (#2690). The memo's dependency array,
 * the effect's dependency array, the `eslint-disable` line above it, the guard
 * order and the scroll-on-latch are all unchanged, and every setter the effect
 * calls belongs to this hook.
 *
 * WHY THE LATCH IS KEYED ON A SIGNATURE. In the client/server drift case the
 * local predicate is false by definition, so the latch cannot key off it.
 * Instead it remembers the guest-set signature at latch time: if the member then
 * CHANGES the guests (e.g. re-adds an adult) rather than writing a reason,
 * release the latch so they are not forced to justify a rule the server will no
 * longer apply.
 */
export function useReviewJustificationLatch({
  remainingGuests,
  addedGuests,
}: {
  remainingGuests: Guest[];
  addedGuests: NewGuest[];
}) {
  // #2104: member-facing justification for a modification that leaves minors
  // with no adult on the booking. Shown proactively when the local predicate
  // trips, or reactively when the server returns REVIEW_JUSTIFICATION_REQUIRED.
  const [memberReviewJustification, setMemberReviewJustification] = useState("");
  const [reviewJustificationError, setReviewJustificationError] = useState("");
  const [serverRequiresJustification, setServerRequiresJustification] =
    useState(false);
  const reviewJustificationRef = useRef<HTMLTextAreaElement>(null);
  const { scrollToError } = useScrollToFeedback();

  const guestSetSignature = useMemo(
    () =>
      JSON.stringify([
        remainingGuests.map((g) => g.id),
        addedGuests.map((g) => [g.firstName, g.lastName, g.ageTier]),
      ]),
    [remainingGuests, addedGuests],
  );
  const latchedGuestSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!serverRequiresJustification) {
      latchedGuestSignatureRef.current = null;
      return;
    }
    if (latchedGuestSignatureRef.current === null) {
      // Latch just set: remember the guest set and bring the freshly-mounted
      // field into view (the fetch handler ran before it existed in the DOM).
      latchedGuestSignatureRef.current = guestSetSignature;
      scrollToError(reviewJustificationRef);
      return;
    }
    if (latchedGuestSignatureRef.current !== guestSetSignature) {
      setServerRequiresJustification(false);
      setReviewJustificationError("");
      latchedGuestSignatureRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRequiresJustification, guestSetSignature]);

  return {
    memberReviewJustification,
    setMemberReviewJustification,
    reviewJustificationError,
    setReviewJustificationError,
    serverRequiresJustification,
    setServerRequiresJustification,
    reviewJustificationRef,
    scrollToError,
  };
}
