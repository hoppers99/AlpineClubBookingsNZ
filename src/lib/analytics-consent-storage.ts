import type {
  ConsentChoice,
  ConsentSource,
  StoredConsent,
} from "@/lib/analytics-consent-decision";

/**
 * Where a visitor's analytics choice lives, and how it is read back (#2573).
 *
 * `localStorage` only — no cookie, no server record, nothing that identifies the
 * visitor anywhere. The choice never leaves the browser it was made in, which is
 * why there is nothing here to audit or to expose through an API.
 *
 * Every access is wrapped, because `localStorage` THROWS rather than returning
 * null in private-browsing and storage-partitioned contexts.
 *
 * ## What a refused write means, in each mode
 *
 * A storage-blocked browser throws on `getItem` AND `setItem` together, so a
 * choice made there cannot be read back on the next page load. The two banner
 * modes land in opposite places, and the difference is why
 * {@link writeStoredConsent} reports back instead of swallowing the failure:
 *
 *  • **Banner ENABLED** — fail-CLOSED, and no disclosure is needed. The read
 *    returns "no choice recorded", so the banner simply asks again and nothing
 *    loads until the visitor accepts on that page.
 *  • **Banner DISABLED** — fail-OPEN. `resolveAnalyticsDecision`'s banner-off
 *    branch answers `analyticsAllowed: true` when there is no stored record, so a
 *    visitor's opt-out through the public preferences control would hold for the
 *    current page and then quietly stop holding. Owner section 5 requires the
 *    opt-out to be "preserved for future eligible page loads", and in a
 *    storage-blocked browser this implementation cannot preserve it.
 *
 * What it can do is stop CLAIMING it did. The write reports whether the value
 * landed and the preferences panel says so plainly when it did not, rather than
 * asserting "switching analytics off stops further collection from this browser"
 * about a browser where it will not.
 */

/**
 * v2 because the shape changed: v1 stored the bare string `"accepted"` /
 * `"declined"` with no revision and no source, and #2573 needs both (the revision
 * so "Ask visitors to choose again" can invalidate, the source so banner-off mode
 * can tell a banner-era decline from a preferences opt-out).
 */
export const ANALYTICS_CONSENT_STORAGE_KEY = "analytics-consent.v2";

/** The pre-#2573 key. Read once, on the first load after the upgrade. */
export const LEGACY_ANALYTICS_CONSENT_STORAGE_KEY = "analytics-consent.v1";

/**
 * The revision a migrated v1 record is attributed to.
 *
 * `AnalyticsSettings.consentRevision` defaults to 1 and is only ever bumped by the
 * explicit admin action, so a club that has not asked visitors to choose again is
 * still on revision 1 — and a visitor who accepted or declined under the old
 * hard-coded banner keeps that choice rather than being re-prompted for no reason.
 * That is the issue body's "existing stored visitor choices continue to work when
 * the banner remains enabled", and it costs nothing: a club that DOES want a fresh
 * choice has the action for it.
 *
 * Migrated records are attributed to the `banner` source, which is where they were
 * actually made. That matters: a v1 DECLINE is a banner-era decline, so turning the
 * banner off invalidates it exactly as section 4 requires.
 */
const LEGACY_CONSENT_REVISION = 1;

function isConsentChoice(value: unknown): value is ConsentChoice {
  return value === "accepted" || value === "declined";
}

function isConsentSource(value: unknown): value is ConsentSource {
  return value === "banner" || value === "preferences";
}

/**
 * Read the stored choice, migrating a v1 record on the way through.
 *
 * Anything unparseable — malformed JSON, an unknown choice, a missing revision —
 * is treated as "no record" rather than repaired, so a corrupt value can never be
 * read as consent.
 */
export function readStoredConsent(): StoredConsent | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
  } catch {
    return null;
  }

  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        isConsentChoice((parsed as StoredConsent).choice) &&
        isConsentSource((parsed as StoredConsent).source) &&
        typeof (parsed as StoredConsent).revision === "number" &&
        Number.isInteger((parsed as StoredConsent).revision) &&
        (parsed as StoredConsent).revision >= 1
      ) {
        const record = parsed as StoredConsent;
        return {
          choice: record.choice,
          revision: record.revision,
          source: record.source,
        };
      }
    } catch {
      // Unparseable JSON: fall through to the `return null` below.
    }
    // A v2 value that is PRESENT but corrupt or unrecognised is "no record", and
    // deliberately does NOT fall through to the legacy read: a v1 value left beside
    // it is older, and reading it would resurrect a choice the v2 write superseded.
    return null;
  }

  try {
    const legacy = window.localStorage.getItem(
      LEGACY_ANALYTICS_CONSENT_STORAGE_KEY,
    );
    if (isConsentChoice(legacy)) {
      return {
        choice: legacy,
        revision: LEGACY_CONSENT_REVISION,
        source: "banner",
      };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Persist a choice, and report whether it actually landed.
 *
 * The legacy key is removed in the same call, so the migration happens once and a
 * later revision bump cannot be undone by the stale v1 value reappearing.
 *
 * Returns `false` when the browser refused the write (storage fully blocked, a
 * partitioned or embedded context, zero quota). The choice still stands in memory
 * for the current page either way — the caller keeps honouring it — but a `false`
 * means it will NOT survive the next page load, and the caller is expected to say
 * so rather than let the panel assert otherwise. See the module header for why
 * that matters in banner-off mode and not in banner-on mode.
 *
 * The legacy `removeItem` deliberately does not affect the answer: in a browser
 * that refuses writes there is no v1 value to remove either, and the v2 value wins
 * on the next successful read regardless.
 */
export function writeStoredConsent(record: StoredConsent): boolean {
  let persisted = false;
  try {
    window.localStorage.setItem(
      ANALYTICS_CONSENT_STORAGE_KEY,
      JSON.stringify(record),
    );
    persisted = true;
  } catch {
    // Private browsing / quota / partitioned storage: reported to the caller.
  }
  try {
    window.localStorage.removeItem(LEGACY_ANALYTICS_CONSENT_STORAGE_KEY);
  } catch {
    // Nothing to do; the v2 value wins on the next read regardless.
  }
  return persisted;
}
