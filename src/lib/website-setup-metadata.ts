import "server-only";

import type { Metadata } from "next";
import { getCachedWebsiteThemeRenderState } from "@/lib/public-layout-config";
import { SETUP_IN_PROGRESS_COPY } from "@/lib/setup-in-progress-screen";

/**
 * The `<head>` half of the pre-setup holding screen (#2420 review finding F1).
 *
 * ## The hole this closes
 *
 * `src/proxy.ts` answers every public-website address with 503 until setup is
 * complete — but only for a path `isPublicWebsitePath()` CLAIMS, and only where
 * the proxy runs at all. Both halves have had holes.
 *
 * The header half is now closed: the matcher used to skip any request bearing
 * `next-router-prefetch` or `purpose: prefetch`, so
 * `curl -H 'Purpose: prefetch' https://club/about` reached the app directly, and
 * the earlier framing of that as "a prefetch issued from an admin page" was
 * wrong — it was ordinary request headers, craftable by anyone. #2404 first
 * narrowed the exemption to a real flight prefetch and then, on the owner's
 * decision (1 Aug 2026), deleted it outright. No header now takes a URL outside
 * the proxy.
 *
 * The classifier half remains, and it is why this guard is still load-bearing.
 * `isPublicWebsitePath()` refuses asset-extension paths on purpose — the holding
 * screen is an HTML document and must never be the answer to a request for an
 * image — so a URL of that shape that reaches a render is rendered with no gate
 * in front of it. `/API/x.png` is the live case: the rewrites hand it back
 * unchanged and Next's case-sensitive route table then leaves it to the
 * `(website)` catch-all.
 *
 * `(website)/layout.tsx` catches those requests and substitutes the holding
 * screen for `{children}`, so the page component never runs. That suppresses the
 * BODY and nothing else. In the vendored next@16.2.11 the document head is a
 * SEPARATE flight slot from the page's seed data (`app-render.js` builds
 * `initialHead` alongside `seedData`) and `createMetadataComponents()` resolves
 * from the loader tree, so `generateMetadata()` still runs and still emits
 * `<title>` and `<meta name="description">` for a page the visitor is not being
 * shown. Pre-setup, an anonymous prober with a slug wordlist could therefore
 * recover the whole page inventory of an unlaunched site, each page's title, and
 * the plain text of its header — including pages the club has not published.
 *
 * ## The rule
 *
 * EVERY `generateMetadata()` under `(website)` calls this FIRST and returns its
 * result when non-null — before looking anything up, and on the hit path as well
 * as the miss path. A guard that only fires when the page is missing is worse
 * than none: it makes "exists" and "does not exist" answer differently, which is
 * precisely the oracle. `website-metadata-setup-gate.test.ts` walks the route
 * tree and fails if a page skips it.
 *
 * The title is byte-identical to the `<title>` of the 503 document
 * (`buildSetupInProgressDocument`), so the gated and the ungated responses
 * describe the same screen. `noindex` matches that document's own robots meta.
 *
 * ## What this is and is not
 *
 * A LAUNCH-STATE SIGNAL, not an authorisation boundary. It keeps an unlaunched
 * club from advertising content it has not opened; it is not a substitute for
 * per-resource authorisation, and nothing behind a `(website)` URL — route
 * handlers, server actions, the CMS reads themselves — may rely on it.
 */
export async function setupInProgressMetadata(): Promise<Metadata | null> {
  // The layout's own tagged cache, so this is not an extra query on a
  // configured club — it is the read the layout makes on the same request.
  const { isComplete } = await getCachedWebsiteThemeRenderState();

  if (isComplete) {
    return null;
  }

  return {
    title: SETUP_IN_PROGRESS_COPY.eyebrow,
    robots: { index: false, follow: false },
  };
}
