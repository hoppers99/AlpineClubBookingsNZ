/**
 * The visitor consent model for Google Analytics (#2573, owner decision sections
 * 3, 4, 5 and 6, plus the owner's clarifications 1 and 2).
 *
 * Kept as a PURE module with no React, no DOM and no storage access, because it is
 * the part that has to be provably right: whether the third-party tag loads at all
 * comes out of {@link resolveAnalyticsDecision}, and every branch of it is pinned
 * in `analytics-consent-decision.test.ts`. The component around it does the DOM
 * work.
 *
 * ## Prior consent, restated as the guarantee this file makes
 *
 * With the banner ENABLED and no matching stored choice, the answer is
 * `analyticsAllowed: false`. The component then loads NO Google script, sends NO
 * request, sends NO cookieless ping, and sends NO consent-status signal to Google
 * — the `gtag('consent','default', …)` bootstrap is a local `dataLayer` push with
 * no network call, and nothing transmits until `gtag/js` itself is fetched, which
 * happens only after Accept. Dismissing the banner is a decline.
 *
 * ## Banner disabled
 *
 * Analytics loads automatically, and a decline that was recorded WHILE THE BANNER
 * WAS SHOWING is ignored — that is the owner's "previous stored declines are
 * invalidated once" (section 4). It is not a blanket override: a visitor who
 * afterwards opts out through the public Analytics preferences control has
 * recorded a `preferences` choice, and clarification 1 requires that to be
 * honoured, or the preferences control would be decorative. Hence
 * {@link StoredConsent.source}, which is the only reason the record is a shape
 * rather than a bare string.
 *
 * A `preferences` decline is honoured in banner-off mode REGARDLESS of the
 * revision it was recorded under. The revision exists to re-prompt, and in
 * banner-off mode there is no prompt to show — so treating a stale revision as
 * "ask again" would silently re-enable analytics for someone who explicitly turned
 * it off and can never be asked. The "Ask visitors to choose again" action is
 * hidden in banner-off mode for the same reason (clarification 2).
 */

export type ConsentChoice = "accepted" | "declined";

/**
 * Which surface recorded the choice. Load-bearing, not metadata: see the module
 * header for why banner-off mode has to tell the two apart.
 */
export type ConsentSource = "banner" | "preferences";

export interface StoredConsent {
  choice: ConsentChoice;
  /** The `AnalyticsSettings.consentRevision` in force when the choice was made. */
  revision: number;
  source: ConsentSource;
}

/** What the public runtime needs from the club's configuration. */
export interface AnalyticsConsentContext {
  consentBannerEnabled: boolean;
  consentRevision: number;
}

export interface AnalyticsConsentDecision {
  /** May the Google Analytics tag load and collect on this page load? */
  analyticsAllowed: boolean;
  /** Should the initial consent prompt be shown? */
  showBanner: boolean;
  /**
   * What the public preferences control displays. `"unset"` only ever appears in
   * banner-enabled mode with no matching stored choice — i.e. while the banner
   * itself is still asking.
   */
  preference: "allowed" | "declined" | "unset";
}

export function resolveAnalyticsDecision(
  context: AnalyticsConsentContext,
  stored: StoredConsent | null,
): AnalyticsConsentDecision {
  if (context.consentBannerEnabled) {
    // A stored choice counts only while it was made under the CURRENT revision.
    // `!==` rather than `<` on purpose: a record carrying a revision this club has
    // never reached (a hand-edited value, a shared browser profile, a rolled-back
    // deploy) is not a choice we can attribute, so it re-prompts.
    if (stored && stored.revision === context.consentRevision) {
      const allowed = stored.choice === "accepted";
      return {
        analyticsAllowed: allowed,
        showBanner: false,
        preference: allowed ? "allowed" : "declined",
      };
    }
    return { analyticsAllowed: false, showBanner: true, preference: "unset" };
  }

  // Banner OFF. A preferences-recorded choice is honoured at any revision; a
  // banner-era record is ignored, which is what makes analytics start loading.
  if (stored && stored.source === "preferences") {
    const allowed = stored.choice === "accepted";
    return {
      analyticsAllowed: allowed,
      showBanner: false,
      preference: allowed ? "allowed" : "declined",
    };
  }

  return { analyticsAllowed: true, showBanner: false, preference: "allowed" };
}
