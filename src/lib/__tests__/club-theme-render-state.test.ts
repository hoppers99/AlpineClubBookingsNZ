import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getWebsiteThemeRenderState()` must distinguish "the club has not finished
 * setup" from "the database did not answer" (#2420 review finding F4).
 *
 * Both used to arrive as `isComplete: false`. That is harmless for the theme
 * VALUES — the fallback palette is right either way — but not for the callers
 * that turn the flag into a statement about the club. `(website)/layout.tsx`
 * paints "Site setup in progress" from it, with a 200, on a page (`/`) that is
 * allow-listed as anonymously cacheable for 60 seconds and stale-servable for
 * 300. A two-second database blip on a club that launched years ago therefore
 * pinned a launch-state lie into every anonymous visitor's cache.
 */

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { clubTheme: { findUnique: mocks.findUnique } },
}));

import { getWebsiteThemeRenderState } from "@/lib/club-theme";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getWebsiteThemeRenderState", () => {
  it("reports a completed setup", async () => {
    mocks.findUnique.mockResolvedValue({ completedAt: new Date() });

    const state = await getWebsiteThemeRenderState();

    expect(state.isComplete).toBe(true);
    expect(state.readFailed).toBe(false);
  });

  it("reports an unfinished setup as a POSITIVE answer, not a failure", async () => {
    // The row exists and says completedAt IS NULL. This is the real pre-setup
    // state, and the one case where the holding screen is the truth.
    mocks.findUnique.mockResolvedValue({ completedAt: null });

    const state = await getWebsiteThemeRenderState();

    expect(state.isComplete).toBe(false);
    expect(state.readFailed).toBe(false);
  });

  it("treats a missing row as a positive answer too", async () => {
    // A club that has never saved a theme. The database answered; there is
    // simply nothing there yet.
    mocks.findUnique.mockResolvedValue(null);

    const state = await getWebsiteThemeRenderState();

    expect(state.isComplete).toBe(false);
    expect(state.readFailed).toBe(false);
  });

  it("flags a THROWN read separately, and still serves usable theme values", async () => {
    mocks.findUnique.mockRejectedValue(new Error("Can't reach database server"));

    const state = await getWebsiteThemeRenderState();

    expect(state.readFailed).toBe(true);
    expect(state.isComplete).toBe(false);
    // Unchanged for every caller that only wants a palette: the default theme
    // still renders, so a blip does not strip a page of its styling.
    expect(state.css).toContain("--brand-gold");
    expect(state.values).toBeTruthy();
  });
});
