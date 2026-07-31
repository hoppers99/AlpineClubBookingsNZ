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
 * complete — but its matcher carries a `missing:` clause that skips any request
 * bearing `next-router-prefetch` or `purpose: prefetch`. Those are ORDINARY
 * REQUEST HEADERS. `curl -H 'Purpose: prefetch' https://club/about` is enough to
 * skip the proxy entirely; nothing about the bypass is internal to the app, and
 * the earlier framing of it as "a prefetch issued from an admin page" was wrong.
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
 * (`buildSetupInProgressDocument`), so the proxied and the prefetch-shaped
 * responses describe the same screen. `noindex` matches that document's own
 * robots meta.
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
