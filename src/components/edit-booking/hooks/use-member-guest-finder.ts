"use client";

import { useEffect, useRef, useState } from "react";
import type { MemberGuestCandidate } from "@/lib/member-guest-find";

/**
 * The member-guest finder's open state, and putting D-8's refusal back on screen.
 *
 * Extracted from `edit-booking-panel.tsx` (#2690). The hook owns the open flag,
 * the last attempted candidate, the trigger ref and the already-surfaced
 * signature, so the effect's dependency array is the original one entry for
 * entry and every setter it calls is one this hook created.
 *
 * Owner sign-off, 1 Aug 2026: the finder is opened from a button in the Guests
 * card HEADER, beside "+ Add Non-Member Guest" — the wizard's exact shape — so
 * the open/close state and the trigger ref live with the panel rather than
 * inside the finder, in the same place and for the same reason `guests-step.tsx`
 * owns them for the wizard.
 *
 * THE BUG THE EFFECT FIXES, and it made two props dead code. "Add to booking"
 * CLOSES the finder — the wizard's shape, and the right one — but the server's
 * answer only arrives on the debounced quote that follows, by which time
 * `EditMemberGuestFinder` is unmounted and its `addError` / `refusedCandidate`
 * render nowhere at all. The booker got the panel-level quote error and no
 * statement of who it was about; MG3's F9 shape (the neutral sentence beside a
 * chip naming the candidate) never appeared on this surface, and its unit test
 * asserted a state the integration never produced.
 *
 * ON THE TRANSITION ONLY. A refused member guest STAYS in `addedGuests`, so
 * every later quote re-asks the same question and returns the same refusal;
 * re-opening on each one would spring the section back open under a booker who
 * had closed it and moved on to their dates. The signature remembers what has
 * already been surfaced, and resets when the refusal clears.
 */
export function useMemberGuestFinder(memberGuestAddError: string | null) {
  const [memberGuestFinderOpen, setMemberGuestFinderOpen] = useState(false);
  // Who the last add was about, so a refusal renders beside a chip naming them
  // rather than floating above an empty search box (MG3's F9).
  const [lastMemberGuestAttempt, setLastMemberGuestAttempt] =
    useState<MemberGuestCandidate | null>(null);
  // Focus has to go somewhere when the panel closes, or Escape drops it on the
  // document body and a keyboard user is stranded at the top of a long panel
  // (MG3's F5).
  const memberGuestTriggerRef = useRef<HTMLButtonElement>(null);

  const surfacedMemberGuestRefusalRef = useRef<string | null>(null);
  useEffect(() => {
    if (!memberGuestAddError) {
      surfacedMemberGuestRefusalRef.current = null;
      return;
    }
    const signature = `${lastMemberGuestAttempt?.memberId ?? ""}\u0000${memberGuestAddError}`;
    if (surfacedMemberGuestRefusalRef.current === signature) return;
    surfacedMemberGuestRefusalRef.current = signature;
    setMemberGuestFinderOpen(true);
  }, [memberGuestAddError, lastMemberGuestAttempt]);

  function closeMemberGuestFinder() {
    setMemberGuestFinderOpen(false);
    memberGuestTriggerRef.current?.focus();
  }

  return {
    memberGuestFinderOpen,
    setMemberGuestFinderOpen,
    lastMemberGuestAttempt,
    setLastMemberGuestAttempt,
    memberGuestTriggerRef,
    closeMemberGuestFinder,
  };
}
