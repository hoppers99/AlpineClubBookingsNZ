"use client";

import { useEffect, useState } from "react";
import type { AvailablePromoCode } from "@/components/edit-booking/types";

/**
 * The member's own eligible promo codes, for the entry area's chips.
 *
 * Extracted from `edit-booking-panel.tsx` (#2690) unchanged, including the
 * detail that sets it apart from the family loader beside it: a NON-OK response
 * here resolves to `[]`, not to "unknown". That is deliberate and was already
 * the behaviour — an unavailable chip list costs the member a shortcut, while an
 * unknown family list would make the consent prediction lie — so the two loaders
 * fail differently on purpose.
 *
 * #2266: create-flow parity, since the wizard's review step fetches the same
 * endpoint. Members only: the endpoint returns the SESSION user's assignments,
 * so an admin editing on behalf would see their own codes, not the member's —
 * and the admin create wizard offers no chips either.
 */
export function useAvailablePromoCodes(viewerRole: string): AvailablePromoCode[] {
  const [availablePromoCodes, setAvailablePromoCodes] = useState<
    AvailablePromoCode[]
  >([]);

  useEffect(() => {
    if (viewerRole === "ADMIN") return;
    let cancelled = false;
    fetch("/api/promo-codes/available")
      .then((res) => (res.ok ? res.json() : []))
      .then((codes) => {
        if (!cancelled) {
          setAvailablePromoCodes(Array.isArray(codes) ? codes : []);
        }
      })
      .catch(() => {
        if (!cancelled) setAvailablePromoCodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [viewerRole]);

  return availablePromoCodes;
}
