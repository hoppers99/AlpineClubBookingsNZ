"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PromoResult } from "@/components/promo-code-input";
import type { Guest, NewGuest } from "@/components/edit-booking/types";

/** What this edit will do to the booking's promo code. */
export type PromoAction =
  | { type: "keep" }
  | { type: "remove" }
  // #2266: guestIndexes carries a guest-targeted code's beneficiary
  // selection (from the shared PromoCodeInput), positional over
  // [remaining guests..., added guests...] — the order the server prices.
  | { type: "new"; code: string; guestIndexes?: number[] };

/**
 * The promo choice, and dropping it when the party it was aimed at changes.
 *
 * Extracted from `edit-booking-panel.tsx` (#2690) with the memo's dependency
 * array, the effect's dependency array, the ref latch and the three-branch guard
 * order all unchanged. The hook owns every slot the effect writes.
 *
 * #2266: a guest-targeted promo's beneficiary indexes are positional over
 * [remaining guests..., added guests...]; changing that list silently re-points
 * them at different people. Reset the applied code instead and let the member
 * re-apply it against the new guest list.
 */
export function usePromoSelection({
  guests,
  removedGuestIds,
  addedGuests,
}: {
  guests: Guest[];
  removedGuestIds: Set<string>;
  addedGuests: NewGuest[];
}) {
  const [promoAction, setPromoAction] = useState<PromoAction>({ type: "keep" });
  // #2266: the old blind promo text field is gone — the shared PromoCodeInput
  // owns entry + validation of a NEW code (guest selection included).
  const [appliedNewPromo, setAppliedNewPromo] = useState<PromoResult | null>(
    null,
  );
  const [prefillPromoCode, setPrefillPromoCode] = useState<string | undefined>(
    undefined,
  );

  const promoGuestSetSignature = useMemo(
    () =>
      JSON.stringify([
        guests
          .filter((guest) => !removedGuestIds.has(guest.id))
          .map((guest) => guest.id),
        addedGuests.map((guest) => guest.key),
      ]),
    [guests, removedGuestIds, addedGuests],
  );
  const appliedPromoGuestSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!(promoAction.type === "new" && promoAction.guestIndexes?.length)) {
      appliedPromoGuestSignatureRef.current = null;
      return;
    }
    if (appliedPromoGuestSignatureRef.current === null) {
      appliedPromoGuestSignatureRef.current = promoGuestSetSignature;
      return;
    }
    if (appliedPromoGuestSignatureRef.current !== promoGuestSetSignature) {
      appliedPromoGuestSignatureRef.current = null;
      setAppliedNewPromo(null);
      setPromoAction({ type: "keep" });
    }
  }, [promoAction, promoGuestSetSignature]);

  return {
    promoAction,
    setPromoAction,
    appliedNewPromo,
    setAppliedNewPromo,
    prefillPromoCode,
    setPrefillPromoCode,
  };
}
