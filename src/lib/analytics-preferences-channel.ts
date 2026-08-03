/**
 * How the public footer's "Analytics preferences" link talks to the analytics
 * runtime that actually owns the visitor's choice (#2573, owner decision
 * section 5).
 *
 * ## Why a channel rather than a prop
 *
 * The runtime component (`src/components/analytics-consent.tsx`) is mounted once
 * per public layout, at the bottom of the page, and it is the single owner of the
 * consent state: it decides whether the Google tag loads, it reads and writes the
 * stored choice, and it must stay the only writer or two surfaces could disagree
 * about what the visitor chose. The link the visitor clicks belongs somewhere else
 * entirely — the footer's legal row, beside Privacy Policy and Terms of Service,
 * which is the low-friction location the decision asks for.
 *
 * Those two live in different subtrees of a SERVER component, so there is no
 * shared React state and no provider between them, and threading the whole
 * analytics configuration down into the footer would put a third copy of the
 * "is analytics available" rule in a component that has no other reason to know.
 *
 * So the runtime publishes availability and the link asks for the panel, over the
 * same two mechanisms this repo already uses for exactly this shape — the consent
 * banner tells the public help launcher to step aside with a `data-` attribute plus
 * a `CustomEvent` (`analytics-consent-visibility`). Attribute for the value a
 * late-mounting listener needs to read, event for the change.
 */

/**
 * Set on `<html>` by the analytics runtime while a preferences control should be
 * offered: the module is on, the integration is validly configured, and the
 * current route is analytics-eligible. Absent means "offer nothing".
 *
 * The attribute exists so mount ORDER does not matter. The footer link mounts
 * before the runtime (it is higher in the tree), so it cannot rely on catching the
 * event; it reads this on mount and subscribes for later changes.
 */
export const ANALYTICS_PREFERENCES_ATTRIBUTE = "data-analytics-preferences";

/** Dispatched on `window` whenever availability changes. */
export const ANALYTICS_PREFERENCES_AVAILABILITY_EVENT =
  "analytics-preferences:availability";

/** Dispatched on `window` by the footer link to open the preferences panel. */
export const ANALYTICS_PREFERENCES_OPEN_EVENT = "analytics-preferences:open";

export interface AnalyticsPreferencesAvailabilityDetail {
  available: boolean;
}
