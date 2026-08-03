import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { analyticsSettings: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));

import {
  ANALYTICS_BANNER_MESSAGE_MAX_LENGTH,
  ANALYTICS_STATUS_LABELS,
  DEFAULT_ANALYTICS_BANNER_MESSAGE,
  describeAnalyticsStatus,
  isAnalyticsIntegrationConfigured,
  isValidGa4MeasurementId,
  normalizeAnalyticsSettings,
  parseBannerMessage,
  parseMeasurementId,
  resolveAnalyticsRuntimeConfig,
} from "@/lib/analytics-settings";

/**
 * The club's Google Analytics configuration (#2573): GA4 measurement ID validation,
 * the four card states, and the fail-closed public runtime resolver.
 */

describe("GA4 measurement ID validation", () => {
  it.each([
    "G-ABCDE12345",
    "G-1234567890",
    "G-ABCD",
    "G-abcde12345",
    "G-".concat("A".repeat(24)),
  ])("accepts %s", (value) => {
    expect(isValidGa4MeasurementId(value)).toBe(true);
  });

  it.each([
    ["a Google Tag Manager container", "GTM-ABCDEF"],
    ["a Universal Analytics property", "UA-12345-1"],
    ["a bare stream id", "ABCDE12345"],
    ["a lowercase prefix", "g-ABCDE12345"],
    ["no suffix", "G-"],
    ["too short a suffix", "G-ABC"],
    ["too long a suffix", "G-".concat("A".repeat(25))],
    ["an inner space", "G-ABCDE 12345"],
    ["a hyphen in the suffix", "G-ABCDE-12345"],
    ["surrounding junk", "id=G-ABCDE12345"],
    ["a newline injection", "G-ABCDE12345\nG-OTHER1234"],
    ["a script fragment", "G-A<script>"],
    ["the empty string", ""],
  ])("refuses %s", (_label, value) => {
    expect(isValidGa4MeasurementId(value)).toBe(false);
  });
});

describe("parseMeasurementId", () => {
  it("trims the submitted value", () => {
    expect(parseMeasurementId("  G-ABCDE12345\t")).toEqual({
      ok: true,
      measurementId: "G-ABCDE12345",
    });
  });

  it("treats an empty submission as clearing the field", () => {
    // Clearing the box is how an admin switches analytics off (section 9).
    expect(parseMeasurementId("   ")).toEqual({ ok: true, measurementId: null });
  });

  it("does NOT normalise case, so a legitimate lowercase character survives", () => {
    // The stored string is handed to Google verbatim; uppercasing it would corrupt it.
    expect(parseMeasurementId("G-abcDE12345")).toEqual({
      ok: true,
      measurementId: "G-abcDE12345",
    });
  });

  it("explains the GA4 format, and names GTM and UA as wrong", () => {
    const result = parseMeasurementId("GTM-ABCDEF");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.error).toContain("G-XXXXXXXXXX");
    expect(result.error).toContain("GTM-");
    expect(result.error).toContain("UA-");
  });
});

describe("parseBannerMessage", () => {
  it("collapses whitespace and trims", () => {
    expect(parseBannerMessage("  We  use\nanalytics.  ", true)).toEqual({
      ok: true,
      bannerMessage: "We use analytics.",
    });
  });

  it("requires a message while the banner is on", () => {
    const result = parseBannerMessage("   ", true);
    expect(result.ok).toBe(false);
  });

  it("accepts an empty message while the banner is off, so the wording is kept", () => {
    expect(parseBannerMessage("", false)).toEqual({
      ok: true,
      bannerMessage: null,
    });
  });

  it("enforces the length ceiling", () => {
    expect(
      parseBannerMessage("a".repeat(ANALYTICS_BANNER_MESSAGE_MAX_LENGTH), true)
        .ok,
    ).toBe(true);
    expect(
      parseBannerMessage(
        "a".repeat(ANALYTICS_BANNER_MESSAGE_MAX_LENGTH + 1),
        true,
      ).ok,
    ).toBe(false);
  });

  it("does not strip or escape markup — it is stored as plain text and rendered safely", () => {
    // The banner renders it as a React text child, so it can never become markup.
    // Escaping here would double-escape what the visitor sees.
    expect(parseBannerMessage("<b>hi</b> & <script>x</script>", true)).toEqual({
      ok: true,
      bannerMessage: "<b>hi</b> & <script>x</script>",
    });
  });
});

describe("normalizeAnalyticsSettings", () => {
  it("synthesises fail-closed defaults on a missing row", () => {
    expect(normalizeAnalyticsSettings(null)).toEqual({
      measurementId: null,
      consentBannerEnabled: true,
      bannerMessage: DEFAULT_ANALYTICS_BANNER_MESSAGE,
      consentRevision: 1,
      updatedAt: null,
      updatedByMemberId: null,
    });
  });

  it("defaults the banner to ENABLED, so a club that saves an ID gets prior consent", () => {
    expect(normalizeAnalyticsSettings({}).consentBannerEnabled).toBe(true);
  });

  it("substitutes the suggested wording for a blank stored message", () => {
    expect(normalizeAnalyticsSettings({ bannerMessage: "   " }).bannerMessage).toBe(
      DEFAULT_ANALYTICS_BANNER_MESSAGE,
    );
  });

  it("floors an out-of-range consent revision at one", () => {
    expect(normalizeAnalyticsSettings({ consentRevision: 0 }).consentRevision).toBe(1);
    expect(normalizeAnalyticsSettings({ consentRevision: 7 }).consentRevision).toBe(7);
  });

  it("trims a stored measurement ID and reads a blank one as absent", () => {
    expect(
      normalizeAnalyticsSettings({ measurementId: " G-ABCDE12345 " }).measurementId,
    ).toBe("G-ABCDE12345");
    expect(normalizeAnalyticsSettings({ measurementId: "  " }).measurementId).toBeNull();
  });
});

describe("describeAnalyticsStatus — the four card states", () => {
  const base = normalizeAnalyticsSettings(null);

  it("reports setup required with no measurement ID", () => {
    expect(describeAnalyticsStatus(base)).toBe("setup_required");
  });

  it("reports configured with, and without, the consent banner", () => {
    expect(
      describeAnalyticsStatus({
        ...base,
        measurementId: "G-ABCDE12345",
        consentBannerEnabled: true,
      }),
    ).toBe("configured_with_banner");
    expect(
      describeAnalyticsStatus({
        ...base,
        measurementId: "G-ABCDE12345",
        consentBannerEnabled: false,
      }),
    ).toBe("configured_without_banner");
  });

  it("reports an invalid configuration for a stored value the write route would refuse", () => {
    // Reachable through a database restore or a manual fix, so status is computed
    // from the STORED value every time rather than trusted from the last save.
    expect(
      describeAnalyticsStatus({ ...base, measurementId: "GTM-ABCDEF" }),
    ).toBe("invalid_configuration");
  });

  it("labels all four states exactly as the owner's decision names them", () => {
    expect(ANALYTICS_STATUS_LABELS).toEqual({
      setup_required: "Setup required",
      configured_with_banner: "Configured with consent banner",
      configured_without_banner: "Configured without consent banner",
      invalid_configuration: "Invalid or incomplete configuration",
    });
  });
});

describe("resolveAnalyticsRuntimeConfig — fail closed in every branch", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset();
    mocks.loggerError.mockClear();
  });

  it("performs NO query at all when the module is off", async () => {
    // Admin -> Modules is the master switch (section 1): a module-off club must not
    // pay a database round trip, and must not be able to resolve a config either.
    await expect(resolveAnalyticsRuntimeConfig(false)).resolves.toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns null when no measurement ID is stored", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(resolveAnalyticsRuntimeConfig(true)).resolves.toBeNull();
  });

  it("returns null when the stored measurement ID is invalid", async () => {
    mocks.findUnique.mockResolvedValue({
      measurementId: "GTM-ABCDEF",
      consentBannerEnabled: true,
      bannerMessage: null,
      consentRevision: 1,
      updatedAt: null,
      updatedByMemberId: null,
    });
    await expect(resolveAnalyticsRuntimeConfig(true)).resolves.toBeNull();
  });

  it("returns null and logs, rather than throwing, on a database read failure", async () => {
    // Section 8: a read failure means no analytics AND the public website still
    // renders normally. A throw here would take the whole public layout down.
    mocks.findUnique.mockRejectedValue(new Error("connection refused"));
    await expect(resolveAnalyticsRuntimeConfig(true)).resolves.toBeNull();
    expect(mocks.loggerError).toHaveBeenCalledOnce();
  });

  it("hands the public runtime exactly the four values it needs", async () => {
    mocks.findUnique.mockResolvedValue({
      measurementId: " G-ABCDE12345 ",
      consentBannerEnabled: false,
      bannerMessage: "Custom wording.",
      consentRevision: 6,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedByMemberId: "admin-1",
    });

    const config = await resolveAnalyticsRuntimeConfig(true);

    // No admin identity, no timestamps, no club identifiers reach the browser.
    expect(config).toEqual({
      measurementId: "G-ABCDE12345",
      consentBannerEnabled: false,
      bannerMessage: "Custom wording.",
      consentRevision: 6,
    });
  });
});

describe("isAnalyticsIntegrationConfigured", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset();
    mocks.loggerError.mockClear();
  });

  it("is true only for a valid stored measurement ID, in either banner mode", async () => {
    for (const consentBannerEnabled of [true, false]) {
      mocks.findUnique.mockResolvedValue({
        measurementId: "G-ABCDE12345",
        consentBannerEnabled,
        bannerMessage: null,
        consentRevision: 1,
        updatedAt: null,
        updatedByMemberId: null,
      });
      await expect(isAnalyticsIntegrationConfigured()).resolves.toBe(true);
    }
  });

  it("is false for no ID, an invalid ID, or a read failure", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(isAnalyticsIntegrationConfigured()).resolves.toBe(false);

    mocks.findUnique.mockResolvedValue({
      measurementId: "UA-1234-5",
      consentBannerEnabled: true,
      bannerMessage: null,
      consentRevision: 1,
      updatedAt: null,
      updatedByMemberId: null,
    });
    await expect(isAnalyticsIntegrationConfigured()).resolves.toBe(false);

    mocks.findUnique.mockRejectedValue(new Error("connection refused"));
    await expect(isAnalyticsIntegrationConfigured()).resolves.toBe(false);
    expect(mocks.loggerError).toHaveBeenCalled();
  });
});

/**
 * The hard cutover (#2573 owner decision section 8, restated in clarification 3).
 *
 * `NEXT_PUBLIC_GA_MEASUREMENT_ID` is removed from runtime entirely: no fallback, no
 * automatic import. A source-level assertion rather than a behavioural one, because
 * the failure mode being guarded is someone reintroducing the read "just as a
 * fallback" — which would silently restore analytics on a club that never consented
 * to the database configuration, and no behavioural test that stubs the variable
 * empty would notice.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("hard cutover: no runtime read of the environment variable", () => {
  const RUNTIME_FILES = [
    "src/lib/analytics-settings.ts",
    "src/lib/analytics-route-policy.ts",
    "src/lib/analytics-consent-decision.ts",
    "src/lib/analytics-consent-storage.ts",
    "src/lib/module-settings.ts",
    "src/lib/public-layout-config.ts",
    "src/components/analytics-consent.tsx",
    "src/components/website/website-chrome.tsx",
    "src/app/(public)/layout.tsx",
    "src/app/api/admin/integrations/analytics/route.ts",
    "src/app/api/admin/integrations/analytics/reconsent/route.ts",
    "src/components/admin/analytics-integration-card.tsx",
  ];

  it.each(RUNTIME_FILES)("%s never reads it", (relativePath) => {
    // Test helper: reads a fixed repo file under process.cwd(); relativePath is a
    // literal in this file, not user input.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const source = readFileSync(
      path.resolve(process.cwd(), relativePath),
      "utf8",
    );
    // Strip comments first: several of these files legitimately EXPLAIN the removal.
    expect(stripComments(source)).not.toContain("NEXT_PUBLIC_GA_MEASUREMENT_ID");
  });

  it("does not read process.env for analytics configuration at all", () => {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/analytics-settings.ts"),
      "utf8",
    );
    // Comments stripped: the module header explains the removal, and naming it there
    // is the documentation, not a read.
    expect(stripComments(source)).not.toMatch(/process\s*\.\s*env/);
  });
});
