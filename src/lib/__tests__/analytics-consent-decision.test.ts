import { describe, expect, it } from "vitest";
import {
  resolveAnalyticsDecision,
  type StoredConsent,
} from "@/lib/analytics-consent-decision";

/**
 * The consent decision matrix (#2573, owner decision sections 3, 4, 5 and 6 plus the
 * owner's clarifications 1 and 2).
 *
 * This is the function that decides whether the third-party tag loads at all, so every
 * branch is pinned here rather than exercised only through the component.
 */

const bannerOn = { consentBannerEnabled: true, consentRevision: 3 };
const bannerOff = { consentBannerEnabled: false, consentRevision: 3 };

function stored(
  choice: StoredConsent["choice"],
  revision: number,
  source: StoredConsent["source"],
): StoredConsent {
  return { choice, revision, source };
}

describe("banner enabled — prior consent", () => {
  it("shows the banner and allows nothing when no choice is stored", () => {
    expect(resolveAnalyticsDecision(bannerOn, null)).toEqual({
      analyticsAllowed: false,
      showBanner: true,
      preference: "unset",
    });
  });

  it("loads analytics for an accept recorded at the current revision", () => {
    expect(
      resolveAnalyticsDecision(bannerOn, stored("accepted", 3, "banner")),
    ).toEqual({
      analyticsAllowed: true,
      showBanner: false,
      preference: "allowed",
    });
  });

  it("keeps analytics off for a decline recorded at the current revision", () => {
    expect(
      resolveAnalyticsDecision(bannerOn, stored("declined", 3, "banner")),
    ).toEqual({
      analyticsAllowed: false,
      showBanner: false,
      preference: "declined",
    });
  });

  it("honours a preferences-recorded choice at the current revision too", () => {
    expect(
      resolveAnalyticsDecision(bannerOn, stored("accepted", 3, "preferences"))
        .analyticsAllowed,
    ).toBe(true);
    expect(
      resolveAnalyticsDecision(bannerOn, stored("declined", 3, "preferences"))
        .analyticsAllowed,
    ).toBe(false);
  });

  it("re-prompts, and allows nothing, once the admin bumps the revision", () => {
    // "Ask visitors to choose again": the stored accept is now stale, so the visitor
    // must choose before anything loads.
    const decision = resolveAnalyticsDecision(
      bannerOn,
      stored("accepted", 2, "banner"),
    );
    expect(decision).toEqual({
      analyticsAllowed: false,
      showBanner: true,
      preference: "unset",
    });
  });

  it("re-prompts for a revision this club has never reached", () => {
    // A hand-edited value, a shared browser profile or a rolled-back deploy. Not a
    // choice we can attribute, so it is not treated as one — `!==`, not `<`.
    expect(
      resolveAnalyticsDecision(bannerOn, stored("accepted", 99, "banner")),
    ).toEqual({
      analyticsAllowed: false,
      showBanner: true,
      preference: "unset",
    });
  });
});

describe("banner disabled", () => {
  it("loads analytics automatically when nothing is stored", () => {
    expect(resolveAnalyticsDecision(bannerOff, null)).toEqual({
      analyticsAllowed: true,
      showBanner: false,
      preference: "allowed",
    });
  });

  it("never shows the initial prompt", () => {
    for (const record of [
      null,
      stored("declined", 3, "banner"),
      stored("declined", 1, "preferences"),
      stored("accepted", 99, "banner"),
    ]) {
      expect(resolveAnalyticsDecision(bannerOff, record).showBanner).toBe(false);
    }
  });

  it("ignores a banner-era decline, at the current revision or an older one", () => {
    // Owner section 4: turning the banner off invalidates previously stored declines
    // once, so analytics begins loading for that visitor.
    for (const revision of [1, 2, 3, 99]) {
      const decision = resolveAnalyticsDecision(
        bannerOff,
        stored("declined", revision, "banner"),
      );
      expect(decision.analyticsAllowed, `revision ${revision}`).toBe(true);
      expect(decision.preference).toBe("allowed");
    }
  });

  it("honours a preferences opt-out at ANY revision", () => {
    // Owner clarification 1: banner-off mode must not ignore future opt-outs, or the
    // public preferences control would be decorative. A stale revision must not
    // silently re-enable analytics for someone who can never be asked again.
    for (const revision of [1, 2, 3, 99]) {
      const decision = resolveAnalyticsDecision(
        bannerOff,
        stored("declined", revision, "preferences"),
      );
      expect(decision.analyticsAllowed, `revision ${revision}`).toBe(false);
      expect(decision.preference).toBe("declined");
    }
  });

  it("honours a preferences opt-in as an explicit allow", () => {
    expect(
      resolveAnalyticsDecision(bannerOff, stored("accepted", 1, "preferences")),
    ).toEqual({
      analyticsAllowed: true,
      showBanner: false,
      preference: "allowed",
    });
  });
});

describe("the preference the public control displays", () => {
  it("is only ever 'unset' while the banner itself is still asking", () => {
    const cases: Array<[typeof bannerOn, StoredConsent | null]> = [
      [bannerOn, null],
      [bannerOn, stored("accepted", 2, "banner")],
      [bannerOn, stored("accepted", 3, "banner")],
      [bannerOff, null],
      [bannerOff, stored("declined", 3, "banner")],
      [bannerOff, stored("declined", 3, "preferences")],
    ];
    for (const [context, record] of cases) {
      const decision = resolveAnalyticsDecision(context, record);
      expect(decision.preference === "unset").toBe(decision.showBanner);
    }
  });
});
