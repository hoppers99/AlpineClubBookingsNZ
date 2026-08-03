import "server-only";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Club-wide Google Analytics configuration — the DATABASE is the sole canonical
 * source (#2573, owner decision section 8).
 *
 * `NEXT_PUBLIC_GA_MEASUREMENT_ID` was removed from runtime entirely in the same
 * change: no environment fallback, no automatic import of the environment value
 * into this table. That is a deliberate, owner-accepted HARD CUTOVER — after the
 * deploy that carries it, Google Analytics is inactive on every club until an
 * authorised admin enters and saves a valid measurement ID under
 * Admin -> Integrations -> Google Analytics. Reintroducing a `process.env` read
 * anywhere in this file, or in the public runtime it feeds, undoes that decision;
 * `analytics-settings.test.ts` fails on one.
 *
 * Everything here FAILS CLOSED. A missing row, an unparseable measurement ID, a
 * disabled module or a database read failure all resolve to "no analytics", and
 * the public website still renders normally in every one of those states — the
 * only thing that stops is the third-party tag.
 */

export const ANALYTICS_SETTINGS_ID = "default";

/**
 * The suggested default banner message (owner decision section 11). Editable
 * plain text; an admin may replace it with any other plain-text wording.
 *
 * It is deliberately not the pre-#2573 hard-coded sentence: that one said nothing
 * about the visitor being able to change their mind later, and there now is a
 * public Analytics preferences control to point them at.
 */
export const DEFAULT_ANALYTICS_BANNER_MESSAGE =
  "We use optional Google Analytics to understand how this website is used. " +
  "Analytics runs only after you select Accept. You can change your choice " +
  "later in Analytics preferences.";

/** Plain-text banner message ceiling (issue body: "for example 500 characters"). */
export const ANALYTICS_BANNER_MESSAGE_MAX_LENGTH = 500;

/**
 * A GA4 web data stream's measurement ID: `G-` followed by the stream's
 * alphanumeric suffix (Google issues 10 uppercase characters today, e.g.
 * `G-ABCDE12345`).
 *
 * The bound is 4-24 rather than exactly 10 so a future Google format change does
 * not lock a club out of its own analytics, and matching is case-INSENSITIVE with
 * NO case normalisation on the stored value: uppercasing what an admin typed would
 * silently corrupt an ID that legitimately carried a lowercase character, and the
 * stored string is handed to Google verbatim.
 *
 * A Google Tag Manager container (`GTM-...`), a Universal Analytics property
 * (`UA-...`) and a bare stream id are all refused. GTM in particular is explicitly
 * out of scope (owner decision section 2's not-configurable list).
 */
const GA4_MEASUREMENT_ID_PATTERN = /^G-[A-Za-z0-9]{4,24}$/;

export interface AnalyticsSettingsValues {
  /** Trimmed GA4 measurement ID, or null when the club has not entered one. */
  measurementId: string | null;
  consentBannerEnabled: boolean;
  /** Trimmed plain-text banner message. Never null: the default stands in. */
  bannerMessage: string;
  /** Visitor re-consent counter. Bumped only by the explicit admin action. */
  consentRevision: number;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

/**
 * The four card states the owner's decision names (section 1), plus the module-off
 * case which the Integrations page answers by not rendering the card at all.
 */
export type AnalyticsIntegrationStatus =
  | "setup_required"
  | "configured_with_banner"
  | "configured_without_banner"
  | "invalid_configuration";

/**
 * What the PUBLIC runtime is given. `null` means "no analytics", and it is the
 * answer for module-off, no-measurement-ID, invalid-measurement-ID and
 * read-failure alike — the public site cannot tell those apart and must not
 * behave differently between them.
 *
 * Note what is NOT here: nothing about the admin who saved it, no timestamps, no
 * club identifiers. Only the four values the banner and the tag need.
 */
export interface AnalyticsRuntimeConfig {
  measurementId: string;
  consentBannerEnabled: boolean;
  bannerMessage: string;
  consentRevision: number;
}

export function isValidGa4MeasurementId(value: string): boolean {
  return GA4_MEASUREMENT_ID_PATTERN.test(value);
}

/**
 * Trim and classify a submitted measurement ID.
 *
 * An empty string after trimming is `{ ok: true, measurementId: null }` — clearing
 * the field is how an admin removes analytics, which section 9 requires — while a
 * non-empty value that is not a GA4 ID is a validation failure with copy the
 * integration panel shows verbatim.
 */
export function parseMeasurementId(
  value: string,
):
  | { ok: true; measurementId: string | null }
  | { ok: false; error: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, measurementId: null };
  }
  if (!isValidGa4MeasurementId(trimmed)) {
    return {
      ok: false,
      error:
        "Enter a GA4 measurement ID in the form G-XXXXXXXXXX. You will find it " +
        "in Google Analytics under Admin, Data streams, your web stream. A " +
        "Google Tag Manager container ID (GTM-…) or a Universal Analytics " +
        "property ID (UA-…) will not work here.",
    };
  }
  return { ok: true, measurementId: trimmed };
}

/**
 * Characters that are INVISIBLE where the banner renders, and therefore cannot be
 * allowed to survive into it.
 *
 * Two distinct problems, one answer. C0/C1 control codes (`U+0000` NUL, `U+0007`
 * BEL, `U+001B` ESC, `U+007F` DEL and friends) are not text and have no business in
 * a stored setting. The bidirectional formatting codes are worse: `U+202E`
 * RIGHT-TO-LEFT OVERRIDE reverses the rendering of everything after it, so
 * `"Analytics is off <U+202E>gnikcart"` DISPLAYS as "Analytics is off tracking"
 * while the stored string says the opposite. On a consent banner — the one surface
 * whose displayed words are the thing a visitor is agreeing to — a stored value that
 * reads differently to the value on screen is not acceptable, whether it arrived by
 * malice or by pasting out of a word processor. Zero-width characters
 * (`U+200B`–`U+200F`, `U+FEFF`) and the soft hyphen (`U+00AD`) are the same class:
 * they change or hide the rendering without appearing in the text an admin proofread.
 *
 * `U+0009`, `U+000A`, `U+000B`, `U+000C`, `U+000D`, `U+00A0`, `U+2028` and `U+2029`
 * are deliberately NOT in the set: every one of them is `\s`, so the collapse below
 * turns them into an ordinary space, which is the right answer for text pasted out of
 * a document. Removing them instead would silently weld two words together.
 */
const INVISIBLE_OR_CONTROL_PATTERN =
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Trim a submitted banner message and enforce the plain-text rules.
 *
 * `bannerRequired` is the banner-enabled case: section 4 of the issue body
 * requires a non-empty value while the banner is on, and requires the saved text
 * to be PRESERVED while the banner is off — so a banner-off save of an empty box
 * is accepted and simply keeps whatever is stored (the caller passes the stored
 * value through).
 *
 * Markup is NOT stripped or escaped — the value is rendered as a React text child,
 * so `<b>` is shown literally and can never become an element, and escaping here
 * would double-escape what the visitor sees. Invisible and control characters ARE
 * stripped, for the display-integrity reason set out on
 * {@link INVISIBLE_OR_CONTROL_PATTERN}; a stray newline pasted from a document is
 * still not something to fail a save over, and becomes a space.
 */
export function parseBannerMessage(
  value: string,
  bannerRequired: boolean,
):
  | { ok: true; bannerMessage: string | null }
  | { ok: false; error: string } {
  // Order matters: drop the invisibles FIRST so a control code sandwiched between
  // two words disappears, then collapse every run of whitespace (including newlines
  // and tabs) to one space — the banner is a single paragraph, so multi-line input
  // would render as one line anyway, and normalising here means the stored value is
  // what the admin sees. A message that was ONLY invisible characters is now empty,
  // and falls into the required/optional branch below exactly as a blank box does.
  const trimmed = value
    .replace(INVISIBLE_OR_CONTROL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed.length === 0) {
    if (bannerRequired) {
      return {
        ok: false,
        error:
          "Enter the message visitors will see in the consent banner while the " +
          "banner is switched on.",
      };
    }
    return { ok: true, bannerMessage: null };
  }
  if (trimmed.length > ANALYTICS_BANNER_MESSAGE_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the banner message to ${ANALYTICS_BANNER_MESSAGE_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, bannerMessage: trimmed };
}

type AnalyticsSettingsRecord = {
  measurementId: string | null;
  consentBannerEnabled: boolean;
  bannerMessage: string | null;
  consentRevision: number;
  updatedAt: Date | null;
  updatedByMemberId: string | null;
};

/**
 * Code defaults on a miss, so an absent row is fully functional and no seed or
 * SELF_HEAL step is needed. The defaults are the fail-closed ones: no measurement
 * ID (so nothing loads), banner ENABLED (so a club that saves an ID without
 * touching consent mode gets prior consent), revision 1.
 */
export function normalizeAnalyticsSettings(
  record?: Partial<AnalyticsSettingsRecord> | null,
): AnalyticsSettingsValues {
  const storedMessage = record?.bannerMessage?.trim();
  return {
    measurementId: record?.measurementId?.trim() || null,
    consentBannerEnabled: record?.consentBannerEnabled ?? true,
    bannerMessage:
      storedMessage && storedMessage.length > 0
        ? storedMessage
        : DEFAULT_ANALYTICS_BANNER_MESSAGE,
    consentRevision:
      typeof record?.consentRevision === "number" && record.consentRevision >= 1
        ? record.consentRevision
        : 1,
    updatedAt: record?.updatedAt?.toISOString() ?? null,
    updatedByMemberId: record?.updatedByMemberId ?? null,
  };
}

/**
 * The four-state status the Integrations card shows.
 *
 * `invalid_configuration` is reachable even though the write route validates,
 * because the row can also be written by a database restore, a manual fix, or a
 * future importer — and section 8 requires an invalid ID to mean no analytics
 * rather than a broken tag. So the status is computed from the STORED value every
 * time rather than trusted from the last successful save.
 */
export function describeAnalyticsStatus(
  settings: AnalyticsSettingsValues,
): AnalyticsIntegrationStatus {
  if (!settings.measurementId) {
    return "setup_required";
  }
  if (!isValidGa4MeasurementId(settings.measurementId)) {
    return "invalid_configuration";
  }
  return settings.consentBannerEnabled
    ? "configured_with_banner"
    : "configured_without_banner";
}

export const ANALYTICS_STATUS_LABELS: Record<
  AnalyticsIntegrationStatus,
  string
> = {
  setup_required: "Setup required",
  configured_with_banner: "Configured with consent banner",
  configured_without_banner: "Configured without consent banner",
  invalid_configuration: "Invalid or incomplete configuration",
};

const ANALYTICS_SETTINGS_SELECT = {
  measurementId: true,
  consentBannerEnabled: true,
  bannerMessage: true,
  consentRevision: true,
  updatedAt: true,
  updatedByMemberId: true,
} as const;

/**
 * Read the singleton for the ADMIN surfaces. Throws on a database failure so the
 * admin sees a real error rather than a screen that says "setup required" about a
 * club that is in fact configured.
 */
export async function loadAnalyticsSettings(): Promise<AnalyticsSettingsValues> {
  const record = await prisma.analyticsSettings.findUnique({
    where: { id: ANALYTICS_SETTINGS_ID },
    select: ANALYTICS_SETTINGS_SELECT,
  });
  return normalizeAnalyticsSettings(record);
}

/**
 * Resolve what the PUBLIC runtime should do, given whether the module is on.
 *
 * Fail-closed in every branch, and deliberately never throws: the public website
 * must keep rendering when analytics configuration cannot be resolved (section 8).
 * A read failure is logged through the existing logger and answered with `null`,
 * exactly as a module-off club is.
 *
 * `moduleEnabled` is passed in rather than read here so the caller's single
 * module-flag read serves both the layout and this — and so the ordering is
 * explicit: the module is the master switch, and a module-off club performs no
 * analytics query at all.
 */
export async function resolveAnalyticsRuntimeConfig(
  moduleEnabled: boolean,
): Promise<AnalyticsRuntimeConfig | null> {
  if (!moduleEnabled) {
    return null;
  }

  let settings: AnalyticsSettingsValues;
  try {
    settings = await loadAnalyticsSettings();
  } catch (err) {
    logger.error(
      { err },
      "Failed to load Google Analytics settings; analytics stays off",
    );
    return null;
  }

  const measurementId = settings.measurementId;
  if (!measurementId || !isValidGa4MeasurementId(measurementId)) {
    return null;
  }

  return {
    measurementId,
    consentBannerEnabled: settings.consentBannerEnabled,
    bannerMessage: settings.bannerMessage,
    consentRevision: settings.consentRevision,
  };
}

/**
 * Is the analytics integration validly configured? Used by the Modules page
 * readiness message, which must direct an admin to Admin -> Integrations rather
 * than to an environment variable (issue body, "Setup and readiness states").
 *
 * Fail-closed and never throws, for the same reason as the runtime resolver: a
 * database blip must not turn the Modules page into an error page.
 */
export async function isAnalyticsIntegrationConfigured(): Promise<boolean> {
  try {
    const settings = await loadAnalyticsSettings();
    return describeAnalyticsStatus(settings).startsWith("configured");
  } catch (err) {
    logger.error(
      { err },
      "Failed to load Google Analytics settings for module readiness",
    );
    return false;
  }
}
