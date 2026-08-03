import { WebsiteChrome } from "@/components/website/website-chrome";
import { getPublicWebsiteNonce } from "@/lib/release-nonce";

/**
 * The FIXED-NONCE public route group: exactly the five addresses owner decision
 * D1 approved (#2352, narrowed 3 Aug 2026).
 *
 * `/`, `/join`, `/contact`, `/join/apply` and the `[...slug]` CMS catch-all — and
 * nothing else. `scripts/ci/check-website-render-modes.mjs` holds that census, so
 * a new page cannot join this group by accident: adding one fails CI until the
 * census is deliberately amended, which is the point of the guard.
 *
 * Everything visible is in `WebsiteChrome`, shared with
 * `(website-dynamic)/layout.tsx`. The ONLY difference between the two layouts is
 * the line below, and it is the whole of the D1 split: this group is served the
 * ONE nonce of this release, because the catch-all's pages are STORED and a
 * stored page's inline scripts have to keep matching the policy on every later
 * response. The other group mints a fresh one per request.
 *
 * This layout reads neither the session nor the request — see `WebsiteChrome`,
 * where the reasoning and the enforcement live. `getPublicWebsiteNonce()` is a
 * digest of a value baked into the image, not a request read, so it does not opt
 * the group out of static rendering.
 */
export default async function WebsiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <WebsiteChrome nonce={await getPublicWebsiteNonce()}>
      {children}
    </WebsiteChrome>
  );
}
