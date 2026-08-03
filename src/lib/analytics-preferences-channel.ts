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
 * offered: the analytics module is on and the integration is validly configured.
 * Absent means "offer nothing".
 *
 * It is deliberately NOT route-gated, and the distinction matters enough to state
 * here because this docblock is the contract between the two sides. Only the BANNER
 * and the TAG are route-gated; the opt-out is offered wherever the runtime is
 * mounted, INCLUDING a route analytics does not run on, because a visitor who wants
 * to switch analytics off must not have to find a tracked page first — and in
 * banner-off mode this control is their only route to it at all (owner decision
 * section 5, clarification 1). Adding `routeEligible` to `preferencesAvailable` in
 * `src/components/analytics-consent.tsx` would delete the link from
 * `/hut-leader-instructions`, `/join/[code]` and `/join/verify/[token]` — the pages
 * where the runtime is mounted but ineligible.
 *
 * What IS true about reach: the runtime is mounted by the two public WEBSITE layouts
 * only, so the attribute is published on every `(website)` and `(website-dynamic)`
 * page and on none of the `(public)` group's login, recovery and token pages, which
 * render the footer with no runtime beneath it. Not mounting the runtime there is the
 * privacy call (that whole group is on section 7's exclusion list) and it stays.
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
