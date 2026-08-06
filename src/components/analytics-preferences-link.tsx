"use client";

import { useEffect, useState } from "react";
import {
  ANALYTICS_PREFERENCES_ATTRIBUTE,
  ANALYTICS_PREFERENCES_AVAILABILITY_EVENT,
  ANALYTICS_PREFERENCES_OPEN_EVENT,
  type AnalyticsPreferencesAvailabilityDetail,
} from "@/lib/analytics-preferences-channel";

/**
 * The public "Analytics preferences" control, in the footer's legal row beside
 * Privacy Policy and Terms of Service (#2573, owner decision section 5).
 *
 * It is a TRIGGER and nothing else: the analytics runtime owns the visitor's choice,
 * so this asks it to open its panel and never reads or writes the stored preference
 * itself. Two surfaces writing the same record is how they end up disagreeing about
 * what the visitor chose.
 *
 * It renders nothing until the runtime says a preferences control should be offered —
 * i.e. the analytics module is on and the club has a valid measurement ID saved. A
 * club with analytics off, or configured but with an invalid ID, gets no link at all
 * rather than a link to an empty panel.
 *
 * Deliberately server-rendered as nothing: `available` starts false, so the initial
 * HTML (including the stored copy of a CMS page) carries no link, and the link appears
 * on hydration once the runtime has published availability. That is the only shape
 * that works for a page served from the full-route ISR store, where the analytics
 * configuration at STORE time may not be the configuration now.
 */
export function AnalyticsPreferencesLink({
  className,
}: {
  className?: string;
}) {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    // Read the attribute first: this component is higher in the tree than the
    // runtime, so on a fresh mount the availability event may already have fired.
    setAvailable(
      document.documentElement.getAttribute(ANALYTICS_PREFERENCES_ATTRIBUTE) ===
        "available",
    );

    const onAvailability = (event: Event) => {
      const detail = (event as CustomEvent<AnalyticsPreferencesAvailabilityDetail>)
        .detail;
      setAvailable(Boolean(detail?.available));
    };

    window.addEventListener(
      ANALYTICS_PREFERENCES_AVAILABILITY_EVENT,
      onAvailability,
    );
    return () => {
      window.removeEventListener(
        ANALYTICS_PREFERENCES_AVAILABILITY_EVENT,
        onAvailability,
      );
    };
  }, []);

  if (!available) {
    return null;
  }

  return (
    <>
      <span aria-hidden="true">&middot;</span>
      <button
        type="button"
        className={className}
        onClick={() => {
          window.dispatchEvent(
            new CustomEvent(ANALYTICS_PREFERENCES_OPEN_EVENT),
          );
        }}
      >
        Analytics preferences
      </button>
    </>
  );
}
