import { describe, expect, it, vi } from "vitest";

// The page module pulls in the whole public-content read path; none of it is
// exercised here, and stubbing it keeps this a test of the ROUTE CONFIG.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  generateStaticParams,
  revalidate,
} from "@/app/(website)/[...slug]/page";

/**
 * The full-route ISR configuration of the admin-authored CMS pages (#2352 slice 1).
 *
 * Two numbers and one empty array, and each one is load-bearing in a way no other
 * test would notice:
 *
 *  • `generateStaticParams()` returning `[]` is what makes this route emit NO
 *    build-time HTML. That is what keeps `check-prerendered-script-nonces.mjs`
 *    green — a build-time render has no request and therefore no CSP nonce, so its
 *    inline scripts would be blocked by the very policy on the same response — and
 *    it is why slice 1 was safe to ship before the build-time-nonce question is
 *    answered (#2352 reconciliation, F2).
 *  • `revalidate` is the owner's freshness decision (D3): instant on edit via
 *    `revalidatePublicSite()`, plus a 300-second backstop for the things that
 *    change with no admin write behind them.
 *
 * `scripts/ci/check-website-render-modes.mjs` asserts the same properties from the
 * source text, which catches a route that is renamed or moved; this asserts the
 * values the framework will actually read.
 */
describe("CMS catch-all route configuration (#2352 slice 1)", () => {
  it("prerenders nothing at build time", async () => {
    expect(await generateStaticParams()).toEqual([]);
  });

  it("carries the owner's 300-second freshness backstop (D3)", () => {
    expect(revalidate).toBe(300);
  });

  it("does not force per-request rendering", async () => {
    const routeModule: Record<string, unknown> = await import(
      "@/app/(website)/[...slug]/page"
    );

    // The one route in the group that must NOT: per-request rendering here is the
    // cost slice 1 removed.
    expect(routeModule.dynamic).toBeUndefined();
    // And it must not opt into Partial Prerendering, which would emit a
    // build-time shell with no nonce.
    expect(routeModule.experimental_ppr).toBeUndefined();
  });
});
