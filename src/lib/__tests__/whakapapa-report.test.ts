import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  coerceWhakapapaCurlData,
  coerceWhakapapaSectionVisibility,
  coerceWhakapapaSourceConfig,
  emptyWhakapapaSectionVisibility,
  resolveWhakapapaRedirectTarget,
  validateWhakapapaSourceUrl,
  WHAKAPAPA_DEFAULT_SELECTORS,
  WHAKAPAPA_DEFAULT_SOURCE_URL,
  WHAKAPAPA_SELECTOR_KEYS,
} from "@/lib/whakapapa-report";

// Regression coverage for the Whakapapa report coercion helpers that back the
// public widget and the admin editor (PR #1581 merged with zero tests, #1657).
// The invariants worth pinning: legacy `chairlifts`-only payloads still surface
// as `lifts`, missing visibility flags default to visible so cached rows keep
// rendering every section, and malformed entries are dropped rather than
// crashing the render.

describe("coerceWhakapapaSectionVisibility", () => {
  it("defaults every section to visible for a null/non-object value", () => {
    const allVisible = emptyWhakapapaSectionVisibility();
    expect(coerceWhakapapaSectionVisibility(null)).toEqual(allVisible);
    expect(coerceWhakapapaSectionVisibility(undefined)).toEqual(allVisible);
    expect(coerceWhakapapaSectionVisibility("nope")).toEqual(allVisible);
    expect(coerceWhakapapaSectionVisibility(42)).toEqual(allVisible);
  });

  it("keeps provided booleans and defaults missing flags to visible", () => {
    // A partial payload (only `conditions` set) must leave every other section
    // visible — this is what lets a legacy cached payload with no visibility
    // block keep rendering.
    expect(
      coerceWhakapapaSectionVisibility({ conditions: false, lifts: false }),
    ).toEqual({
      roadStatus: true,
      lifts: false,
      facilities: true,
      foodAndDrink: true,
      conditions: false,
      trails: true,
    });
  });

  it("ignores non-boolean flag values and falls back to visible", () => {
    expect(
      coerceWhakapapaSectionVisibility({
        roadStatus: "false",
        lifts: 0,
        facilities: null,
        foodAndDrink: false,
        conditions: true,
      }),
    ).toEqual({
      roadStatus: true,
      lifts: true,
      facilities: true,
      foodAndDrink: false,
      conditions: true,
      trails: true,
    });
  });
});

describe("coerceWhakapapaCurlData", () => {
  const roadStatus = {
    name: "Bruce Road",
    status: "Open",
    wheelRequirements: "Chains carried",
    roadContent: "Sealed to the top.",
  };

  it("returns null when the payload is missing or has no roadStatus object", () => {
    expect(coerceWhakapapaCurlData(null)).toBeNull();
    expect(coerceWhakapapaCurlData("not an object")).toBeNull();
    expect(coerceWhakapapaCurlData({})).toBeNull();
    expect(coerceWhakapapaCurlData({ roadStatus: "closed" })).toBeNull();
  });

  it("falls back to the legacy `chairlifts` payload when `lifts` is absent", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      chairlifts: [
        { name: "Waterfall Express", status: "Open" },
        { name: "Rangatira T-bar", status: "On hold" },
      ],
    });

    expect(result?.lifts).toEqual([
      { name: "Waterfall Express", status: "Open" },
      { name: "Rangatira T-bar", status: "On hold" },
    ]);
  });

  it("prefers `lifts` over the legacy `chairlifts` payload when both exist", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      lifts: [{ name: "Sky Waka", status: "Open" }],
      chairlifts: [{ name: "Waterfall Express", status: "Closed" }],
    });

    expect(result?.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
  });

  it("treats an empty `lifts` array as the current shape rather than falling back", () => {
    // `lifts: []` means "no lifts running", not "legacy payload". The fallback
    // only fires when `lifts` is not an array at all.
    const result = coerceWhakapapaCurlData({
      roadStatus,
      lifts: [],
      chairlifts: [{ name: "Waterfall Express", status: "Open" }],
    });

    expect(result?.lifts).toEqual([]);
  });

  it("defaults visibility to all-visible when the payload omits it", () => {
    const result = coerceWhakapapaCurlData({ roadStatus });
    expect(result?.visibility).toEqual(emptyWhakapapaSectionVisibility());
  });

  it("carries an explicit partial visibility block through, defaulting the rest", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      visibility: { facilities: false },
    });
    expect(result?.visibility).toEqual({
      roadStatus: true,
      lifts: true,
      facilities: false,
      foodAndDrink: true,
      conditions: true,
      trails: true,
    });
  });

  it("drops malformed facility/food/lift entries and coerces missing fields to strings", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      facilities: [
        { name: "Cafe", status: "Open" },
        null,
        "not an object",
        { name: 12, status: false }, // non-string fields → ""
      ],
      foodAndDrink: [{ name: "Knoll Ridge" }],
      lifts: [{ status: "Closed" }],
    });

    expect(result?.facilities).toEqual([
      { name: "Cafe", status: "Open" },
      { name: "", status: "" },
    ]);
    expect(result?.foodAndDrink).toEqual([{ name: "Knoll Ridge", status: "" }]);
    expect(result?.lifts).toEqual([{ name: "", status: "Closed" }]);
  });

  it("drops malformed condition rows and coerces each metric field to a string", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      conditions: [
        {
          name: "Top",
          temperature: "-3",
          wind: "25 km/h",
          snowBase: "120 cm",
          snowfall24h: "5 cm",
          snowfall7d: "30 cm",
        },
        null,
        "bad",
        { name: 5 }, // partial + non-string → all defaults
      ],
    });

    expect(result?.conditions).toEqual([
      {
        name: "Top",
        temperature: "-3",
        wind: "25 km/h",
        snowBase: "120 cm",
        snowfall24h: "5 cm",
        snowfall7d: "30 cm",
      },
      {
        name: "",
        temperature: "",
        wind: "",
        snowBase: "",
        snowfall24h: "",
        snowfall7d: "",
      },
    ]);
  });

  it("coerces non-array section fields to empty arrays", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      facilities: "nope",
      foodAndDrink: 3,
      conditions: { not: "an array" },
    });

    expect(result?.facilities).toEqual([]);
    expect(result?.foodAndDrink).toEqual([]);
    expect(result?.lifts).toEqual([]);
    expect(result?.conditions).toEqual([]);
  });

  it("coerces roadStatus and `updated` fields, defaulting non-strings to empty", () => {
    const result = coerceWhakapapaCurlData({
      updated: 123,
      roadStatus: { name: "Bruce Road", status: 7 },
    });

    expect(result?.updated).toBe("");
    expect(result?.roadStatus).toEqual({
      name: "Bruce Road",
      status: "",
      wheelRequirements: "",
      roadContent: "",
    });
  });
});

describe("coerceWhakapapaSourceConfig (import/export round-trip)", () => {
  it("accepts an exported file: keeps known non-empty selectors and a valid URL", () => {
    const exported = {
      type: "whakapapa-mountain-conditions-selectors",
      version: 1,
      sourceUrl: "https://www.whakapapa.com/report",
      selectorOverrides: {
        item: '[class*="row_"]',
        itemName: "  .name  ",
        bogusKey: "ignored",
        blankValue: "",
      },
    };

    const config = coerceWhakapapaSourceConfig(exported);

    expect(config.sourceUrl).toBe("https://www.whakapapa.com/report");
    // Unknown keys and blank values are dropped; whitespace is trimmed.
    expect(config.selectorOverrides).toEqual({
      item: '[class*="row_"]',
      itemName: ".name",
    });
  });

  it("falls back to the default URL when the imported URL is off-allowlist", () => {
    const config = coerceWhakapapaSourceConfig({
      sourceUrl: "https://evil.example.com/report",
      selectorOverrides: { item: ".x" },
    });

    expect(config.sourceUrl).toBe(WHAKAPAPA_DEFAULT_SOURCE_URL);
    expect(config.selectorOverrides).toEqual({ item: ".x" });
  });

  it("returns defaults for a non-object / garbage import", () => {
    const config = coerceWhakapapaSourceConfig("not json");
    expect(config.sourceUrl).toBe(WHAKAPAPA_DEFAULT_SOURCE_URL);
    expect(config.selectorOverrides).toEqual({});
  });
});

describe("selector-defaults seed migration", () => {
  const SEED_SQL = readFileSync(
    path.join(
      process.cwd(),
      "prisma/migrations/20260731130100_seed_whakapapa_selector_defaults/migration.sql",
    ),
    "utf8",
  );

  it("seeds a JSON selector set the DB can parse (dollar-quoted block)", () => {
    const block = SEED_SQL.match(/\$wsel\$([\s\S]*?)\$wsel\$/);
    expect(block, "the migration must carry a $wsel$…$wsel$ JSON block").not.toBeNull();

    const seeded = JSON.parse(block![1]) as Record<string, unknown>;
    for (const [key, value] of Object.entries(seeded)) {
      expect(WHAKAPAPA_SELECTOR_KEYS).toContain(key);
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it("seeds exactly the current code defaults (authoring guard)", () => {
    // If the code defaults ever change, ship a NEW seed migration and update
    // this expectation — old migrations are immutable, and under the
    // "DB always wins" model already-seeded sites keep their stored values.
    const seeded = JSON.parse(
      SEED_SQL.match(/\$wsel\$([\s\S]*?)\$wsel\$/)![1],
    );
    expect(seeded).toEqual(WHAKAPAPA_DEFAULT_SELECTORS);
  });
});

// #2841 (CodeQL js/request-forgery, alert 29). The allowlist is the barrier for
// the server-side report fetch, so it has to hold on every redirect hop as well
// as on the URL an admin saved. These cases are the bypasses that were tried
// against it.
describe("validateWhakapapaSourceUrl", () => {
  it("accepts the allowlisted hosts and their subdomains", () => {
    for (const url of [
      "https://whakapapa.com/report",
      "https://www.whakapapa.com/report",
      "https://snow.nz/report",
      "https://www.snow.nz/report",
    ]) {
      expect(validateWhakapapaSourceUrl(url).ok, url).toBe(true);
    }
  });

  it("refuses the standard allowlist bypasses", () => {
    for (const url of [
      // Suffix confusion: the check must be anchored on a dot, not endsWith.
      "https://evilwhakapapa.com/report",
      "https://whakapapa.com.evil.example/report",
      // Credentials confusion: the host is evil.example, not whakapapa.com.
      "https://whakapapa.com@evil.example/report",
      "https://user:pass@evil.example/report",
      // Scheme downgrades and non-http schemes.
      "http://www.whakapapa.com/report",
      "file:///etc/passwd",
      // Cloud metadata, in the encodings that usually slip past a regex.
      "https://169.254.169.254/latest/meta-data/",
      "https://0xa9fea9fe/latest/meta-data/",
      "https://[::ffff:169.254.169.254]/latest/meta-data/",
      "https://localhost/",
    ]) {
      expect(validateWhakapapaSourceUrl(url).ok, url).toBe(false);
    }
  });
});

describe("resolveWhakapapaRedirectTarget", () => {
  const from = "https://www.whakapapa.com/report";

  it("resolves a relative Location against the hop that issued it", () => {
    const result = resolveWhakapapaRedirectTarget("/report/summer", from);
    expect(result).toEqual({
      ok: true,
      url: "https://www.whakapapa.com/report/summer",
    });
  });

  it("accepts an absolute Location that stays on an allowlisted host", () => {
    const result = resolveWhakapapaRedirectTarget(
      "https://www.snow.nz/report",
      from,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a Location that leaves the allowlist", () => {
    for (const location of [
      "http://169.254.169.254/latest/meta-data/",
      "https://evil.example/report",
      // Protocol-relative: keeps the scheme, swaps the host.
      "//evil.example/report",
      // Suffix confusion again, this time arriving as a redirect.
      "https://evilwhakapapa.com/report",
    ]) {
      expect(resolveWhakapapaRedirectTarget(location, from).ok, location).toBe(
        false,
      );
    }
  });

  it("refuses a missing, blank or unparseable Location", () => {
    expect(resolveWhakapapaRedirectTarget(null, from).ok).toBe(false);
    expect(resolveWhakapapaRedirectTarget(undefined, from).ok).toBe(false);
    expect(resolveWhakapapaRedirectTarget("   ", from).ok).toBe(false);
    expect(resolveWhakapapaRedirectTarget("http://", from).ok).toBe(false);
  });
});
