import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLUB_THEME_VALUES,
  MAX_LOGO_DATA_URL_BYTES,
  isValidLogoDataUrl,
  isValidLogoUrl,
  normaliseThemeValues,
} from "@/lib/club-theme-schema";
import { clubBrandingForDisplay } from "@/lib/lodge-display-state";
import {
  MAX_LOGO_DATA_URL_WRITE_BYTES,
  clubThemeUpdateSchema,
  isLogoDataUrlWithinWriteBudget,
} from "@/lib/club-theme-update-schema";

/** A well-formed logo data URI whose DECODED payload is exactly `bytes` long. */
function dataUrlOfDecodedBytes(bytes: number): string {
  const base64 = Buffer.alloc(bytes, 0x61).toString("base64");
  return `data:image/png;base64,${base64}`;
}

function updatePayload(overrides: Record<string, unknown> = {}) {
  return {
    brandGold: "#57b3ab",
    brandDeep: "#17231c",
    brandSafety: "#b04d28",
    headingFontKey: "LEAGUE_SPARTAN",
    bodyFontKey: "INTER",
    logoUrl: null,
    logoDataUrl: null,
    rawCss: "",
    ...overrides,
  };
}

describe("logo data-URI budgets are asymmetric by design (#2322)", () => {
  it("keeps accepting an existing ~860KB stored logo on the READ path", () => {
    // The Tokoroa deployment stores a data URI close to the read bound. If the
    // read path were tightened, upgrading would silently null its logo.
    const existing = dataUrlOfDecodedBytes(860_000);

    expect(isValidLogoDataUrl(existing)).toBe(true);
    expect(normaliseThemeValues({ logoDataUrl: existing }).logoDataUrl).toBe(
      existing,
    );
  });

  it("accepts a data URI right at the read bound and rejects one past it", () => {
    expect(isValidLogoDataUrl(dataUrlOfDecodedBytes(MAX_LOGO_DATA_URL_BYTES))).toBe(
      true,
    );
    expect(
      isValidLogoDataUrl(dataUrlOfDecodedBytes(MAX_LOGO_DATA_URL_BYTES + 3)),
    ).toBe(false);
  });

  it("the STATELESS schema accepts an oversized existing logo", () => {
    // Critical to the grandfathering rule: the zod layer cannot see what is
    // already stored, so enforcing 64KB here would reject a deployment's own
    // ~860KB logo on every save and lock it out of editing anything at all.
    // The budget is a CHANGED-value rule and lives in the PUT route.
    const parsed = clubThemeUpdateSchema.safeParse(
      updatePayload({
        logoDataUrl: dataUrlOfDecodedBytes(860_000),
      }),
    );

    expect(parsed.success).toBe(true);
  });

  it("the write-budget predicate splits at 64KB", () => {
    expect(
      isLogoDataUrlWithinWriteBudget(
        dataUrlOfDecodedBytes(MAX_LOGO_DATA_URL_WRITE_BYTES),
      ),
    ).toBe(true);
    expect(
      isLogoDataUrlWithinWriteBudget(
        dataUrlOfDecodedBytes(MAX_LOGO_DATA_URL_WRITE_BYTES + 3),
      ),
    ).toBe(false);
  });

  it("write budget is far below the read bound", () => {
    expect(MAX_LOGO_DATA_URL_WRITE_BYTES).toBeLessThan(MAX_LOGO_DATA_URL_BYTES);
  });
});

describe("logoUrl is gated to same-origin served images", () => {
  it("accepts the served-image path form", () => {
    expect(isValidLogoUrl("/api/images/clx123_ab-CD")).toBe(true);
  });

  it.each([
    ["an absolute external URL", "https://evil.example/logo.png"],
    ["a protocol-relative URL", "//evil.example/logo.png"],
    ["a javascript: scheme", "javascript:alert(1)"],
    ["a data URI", "data:image/png;base64,AAAA"],
    ["path traversal out of the image route", "/api/images/../../secret"],
    ["a different route entirely", "/api/members/abc/photo"],
    ["a query-string tail", "/api/images/abc?x=1"],
    ["an unanchored prefix", "x/api/images/abc"],
    ["the bare route", "/api/images/"],
  ])("rejects %s", (_label, value) => {
    expect(isValidLogoUrl(value)).toBe(false);
  });

  it("nulls a hostile stored value at the render chokepoint", () => {
    // normaliseThemeValues is the single path every render goes through, and
    // config-transfer import / hand-edited rows bypass the zod write schema.
    expect(
      normaliseThemeValues({ logoUrl: "https://evil.example/x.png" }).logoUrl,
    ).toBeNull();
  });

  it("passes a valid stored value through unchanged", () => {
    expect(normaliseThemeValues({ logoUrl: "/api/images/abc123" }).logoUrl).toBe(
      "/api/images/abc123",
    );
  });

  it("defaults to no logo of either kind", () => {
    expect(DEFAULT_CLUB_THEME_VALUES.logoUrl).toBeNull();
    expect(DEFAULT_CLUB_THEME_VALUES.logoDataUrl).toBeNull();
  });

  it("REQUIRES logoUrl — an omitted field must not silently default", () => {
    // The migration's fail-safe story depends on this: a stale client that omits
    // logoUrl gets a 400 rather than a successful save that NULLs a logo already
    // migrated to URL form. A future `.optional()` would break that silently.
    const payload = updatePayload();
    delete (payload as Record<string, unknown>).logoUrl;

    expect(clubThemeUpdateSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects an external logoUrl on the write path too", () => {
    const parsed = clubThemeUpdateSchema.safeParse(
      updatePayload({ logoUrl: "https://evil.example/logo.png" }),
    );

    expect(parsed.success).toBe(false);
  });
});

describe("kiosk display sanitises the logo it renders (#2322)", () => {
  it("nulls a hostile stored logoUrl before it reaches an unattended screen", () => {
    // The kiosk reads the ClubTheme columns directly, not through
    // normaliseThemeValues, so it must sanitise for itself.
    const club = clubBrandingForDisplay("Alpine Sports Club", {
      logoUrl: "https://evil.example/x.png",
      logoDataUrl: null,
    });

    expect(club.logoUrl).toBeNull();
    expect(club.logoDataUrl).toBeNull();
  });

  it("nulls a malformed stored data URI", () => {
    const club = clubBrandingForDisplay("Alpine Sports Club", {
      logoUrl: null,
      logoDataUrl: "javascript:alert(1)",
    });

    expect(club.logoDataUrl).toBeNull();
  });

  it("passes valid values through", () => {
    const club = clubBrandingForDisplay("Alpine Sports Club", {
      logoUrl: "/api/images/abc123",
      logoDataUrl: null,
    });

    expect(club.logoUrl).toBe("/api/images/abc123");
    expect(club.name).toBe("Alpine Sports Club");
  });

  it("tolerates a missing theme row", () => {
    expect(clubBrandingForDisplay("Alpine Sports Club", null)).toEqual({
      name: "Alpine Sports Club",
      logoUrl: null,
      logoDataUrl: null,
    });
  });
});
