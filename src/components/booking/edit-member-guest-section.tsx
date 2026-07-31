"use client";

import { useEffect, useRef, useState } from "react";
import {
  MemberGuestFindPanel,
  adminMemberGuestFindEndpoints,
} from "@/components/book/member-guest-find-panel";
import { Button } from "@/components/ui/button";
import type { MemberGuestCandidate } from "@/lib/member-guest-find";

/**
 * "+ Add Member Guest" on the EDIT path (epic #2305, MG4 #2309).
 *
 * WHY ITS OWN FILE RATHER THAN ANOTHER BLOCK INSIDE `edit-booking-panel.tsx`.
 * That panel is 2,700 lines and four in-flight branches touch it; a self-
 * contained component keeps MG4's footprint there down to one render line, so a
 * rebase resolves in one place instead of in the middle of a JSX tree. It also
 * means the open/close, focus-return and re-open-on-refusal behaviour that MG3
 * worked out on the create path is reproduced ONCE, here, rather than being
 * re-derived in a second surface.
 *
 * THE THREE BEHAVIOURS COPIED FROM THE CREATE PATH, DELIBERATELY AND EXACTLY:
 *
 *  1. The panel opens INLINE, never as a dialog (MG3 owner sign-off answer 3).
 *  2. Focus returns to the trigger when the panel closes, or a keyboard user is
 *     stranded on `document.body` after pressing Escape (MG3's F5).
 *  3. A refusal arrives AFTER the panel has closed — the add is optimistic and
 *     the server answers on the quote that follows — so a refusal re-opens the
 *     panel, which is where the neutral D-8 sentence is drawn beside the person
 *     it is about rather than floating above an empty search box (MG3's F9).
 *
 * MEMBER AND ADMIN ARE THE SAME SURFACE, because the booking page IS the same
 * surface: this app has no separate admin booking-detail page, and the edit
 * panel already branches on `viewerRole`. Only two things differ, and both are
 * stated rather than implied — the copy (an admin add is immediate and the
 * member is told; a member add is normally a request), and which route answers
 * the lookup (see `adminMemberGuestFindEndpoints`).
 */
export interface EditMemberGuestSectionProps {
  bookingId: string;
  /** True when this viewer is acting as an admin/booking officer. */
  actingAsAdmin: boolean;
  /**
   * Whether the name type-ahead is available to THIS reader — the club's
   * open-search setting for a member, `membership:view` for an officer (D-20).
   * Server-computed in both cases; the routes re-check.
   */
  openSearchEnabled: boolean;
  /**
   * `MemberGuestSettings.approvalRequired` (D-3). Decides only what the copy
   * PROMISES; the server decides what actually happens.
   */
  approvalRequired: boolean;
  /** Member ids already in the party, so their rows render disabled rather than vanishing. */
  existingMemberIds: readonly string[];
  atCapacity: boolean;
  /** The server's neutral refusal for the last add, if there was one (D-8). */
  addError: string | null;
  onAdd: (candidate: MemberGuestCandidate) => void;
}

export function EditMemberGuestSection({
  bookingId,
  actingAsAdmin,
  openSearchEnabled,
  approvalRequired,
  existingMemberIds,
  atCapacity,
  addError,
  onAdd,
}: EditMemberGuestSectionProps) {
  const [open, setOpen] = useState(false);
  const [lastAddAttempt, setLastAddAttempt] =
    useState<MemberGuestCandidate | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (addError) setOpen(true);
  }, [addError]);

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">
          Add another club member as a guest
        </p>
        <Button
          ref={triggerRef}
          type="button"
          variant={open ? "secondary" : "outline"}
          size="sm"
          disabled={atCapacity}
          onClick={() => setOpen((current) => !current)}
        >
          + Add Member Guest
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {actingAsAdmin
          ? // The admin add is consent-free and always-notify (MG4-D-a), so this
            // says both halves. It deliberately does NOT offer the officer a
            // choice about the email: under D-16 that notice is not a courtesy
            // message an admin may untick.
            "The member is added straight away and emailed to say so. They are not asked first."
          : approvalRequired
            ? "They are emailed and asked first. A bed is held for them until they answer, and they are on the booking only if they say yes."
            : "Your club adds member guests straight away and emails them to say so."}
      </p>
      {open ? (
        <MemberGuestFindPanel
          openSearchEnabled={openSearchEnabled}
          endpoints={
            actingAsAdmin ? adminMemberGuestFindEndpoints(bookingId) : undefined
          }
          existingMemberIds={existingMemberIds}
          atCapacity={atCapacity}
          addError={addError}
          refusedCandidate={addError ? lastAddAttempt : null}
          onAdd={(candidate) => {
            setLastAddAttempt(candidate);
            onAdd(candidate);
            close();
          }}
          onCancel={close}
        />
      ) : null}
    </div>
  );
}
