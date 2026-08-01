"use client";

import {
  MemberGuestFindPanel,
  adminMemberGuestFindEndpoints,
} from "@/components/book/member-guest-find-panel";
import type { MemberGuestCandidate } from "@/lib/member-guest-find";

/**
 * The edit panel's inline "+ Add Member Guest" finder (epic #2305, MG4 #2309).
 *
 * **THE SHAPE IS THE WIZARD'S, DELIBERATELY** — owner sign-off, 1 Aug 2026. The
 * Guests card header carries TWO buttons, "+ Add Member Guest" then
 * "+ Add Non-Member Guest", and pressing the first opens this panel inline in
 * the card content. There is no dashed "add a member guest" block of its own:
 * a member who has used the booking wizard has already learned this control, and
 * a second surface that looked different would make them learn it twice. The
 * trigger, and the open/close state behind it, therefore live in the edit panel
 * beside the header — exactly as `guests-step.tsx` owns them for the wizard —
 * and this component is only what appears when it is open.
 *
 * **The copy that used to sit under a block title now sits INSIDE the panel**,
 * for the same reason: with no block there is nothing to hang it under, and a
 * sentence about what adding somebody will do is most useful next to the box
 * you are about to type a name into.
 *
 * WHAT THIS COMPONENT DOES NOT OWN: opening, closing, focus return, and
 * re-opening on a refusal. All four are the edit panel's, because all four are
 * about the trigger button, which is not here.
 */
export interface EditMemberGuestFinderProps {
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
  /** Who that refusal was about, so it renders beside a chip naming them. */
  refusedCandidate: MemberGuestCandidate | null;
  onAdd: (candidate: MemberGuestCandidate) => void;
  onCancel: () => void;
}

export function EditMemberGuestFinder({
  bookingId,
  actingAsAdmin,
  openSearchEnabled,
  approvalRequired,
  existingMemberIds,
  atCapacity,
  addError,
  refusedCandidate,
  onAdd,
  onCancel,
}: EditMemberGuestFinderProps) {
  return (
    <div className="space-y-2">
      <p
        className="text-xs text-muted-foreground"
        data-testid="edit-member-guest-intent"
      >
        {actingAsAdmin
          ? // The admin add is consent-free and always-notify (MG4-D-a), so this
            // says both halves. It deliberately does NOT offer the officer a
            // choice about the email: under D-16 that notice is not a courtesy
            // message an admin may untick.
            "This member will be added immediately and told by email."
          : approvalRequired
            ? "They are emailed and asked first. A bed is held for them until they answer, and they are on the booking only if they say yes."
            : "Your club adds member guests straight away and emails them to say so."}
      </p>
      {actingAsAdmin && openSearchEnabled ? (
        // THE REACH HINT, admin only and only when name search is actually
        // available to this officer. Rendering it for a `membership:view`-less
        // Booking Officer would promise a type-ahead they get a 404 on — the
        // #1376 fallback is the exact-email box, and saying otherwise would be
        // the one place this surface lied about its own gate.
        <p className="text-xs text-muted-foreground">
          Admins can search every active member by name, including under-18s.
        </p>
      ) : null}
      <MemberGuestFindPanel
        openSearchEnabled={openSearchEnabled}
        endpoints={
          actingAsAdmin ? adminMemberGuestFindEndpoints(bookingId) : undefined
        }
        existingMemberIds={existingMemberIds}
        atCapacity={atCapacity}
        addError={addError}
        refusedCandidate={refusedCandidate}
        onAdd={onAdd}
        onCancel={onCancel}
      />
    </div>
  );
}
