"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { eachNightKey } from "@/components/edit-booking/stay-nights";
import type { Guest } from "@/components/edit-booking/types";

/**
 * The two ways an edit can give guests different nights from each other, and the
 * rule that turns the simpler one off when it stops being offered.
 *
 * Extracted from `edit-booking-panel.tsx` (#2690). Both seeds and the effect are
 * unchanged, including the deliberate asymmetry between them: `perGuestDatesEnabled`
 * is seeded from an EAGER expression (evaluated every render, used only on the
 * first) exactly as it was, while `multiDateRangesEnabled` keeps its lazy
 * initialiser. Neither was touched, because a seed is a behaviour.
 *
 * The hook owns both toggles, so the effect's `setPerGuestDatesEnabled` is a setter
 * it created and the dependency array is the original one, entry for entry.
 */
export function useGuestDateModes({
  guests,
  bookingCheckIn,
  bookingCheckOut,
  canEditPerGuestDates,
}: {
  guests: Guest[];
  bookingCheckIn: string;
  bookingCheckOut: string;
  canEditPerGuestDates: boolean;
}): {
  perGuestDatesEnabled: boolean;
  setPerGuestDatesEnabled: Dispatch<SetStateAction<boolean>>;
  multiDateRangesEnabled: boolean;
  setMultiDateRangesEnabled: Dispatch<SetStateAction<boolean>>;
} {
  const [perGuestDatesEnabled, setPerGuestDatesEnabled] = useState(
    guests.some(
      (guest) =>
        (guest.stayStart && guest.stayStart !== bookingCheckIn) ||
        (guest.stayEnd && guest.stayEnd !== bookingCheckOut)
    )
  );
  // Multiple date ranges / per-guest night grid (issue #713). Enabled by default
  // when an existing guest already has a non-contiguous stay so the gaps show.
  const [multiDateRangesEnabled, setMultiDateRangesEnabled] = useState(() =>
    guests.some((guest) => {
      const span = eachNightKey(
        guest.stayStart ?? bookingCheckIn,
        guest.stayEnd ?? bookingCheckOut
      ).length;
      return Boolean(guest.nights && guest.nights.length < span);
    })
  );

  useEffect(() => {
    if (!canEditPerGuestDates && perGuestDatesEnabled) {
      setPerGuestDatesEnabled(false);
    }
  }, [canEditPerGuestDates, perGuestDatesEnabled]);

  return {
    perGuestDatesEnabled,
    setPerGuestDatesEnabled,
    multiDateRangesEnabled,
    setMultiDateRangesEnabled,
  };
}
