import { headers } from "next/headers";
import { WebsiteChrome } from "@/components/website/website-chrome";
import { CSP_NONCE_HEADER } from "@/lib/csp";

/**
 * The PER-REQUEST public route group: the three public-website pages that keep a
 * freshly minted CSP nonce (#2352, owner decision 3 Aug 2026).
 *
 * `/hut-leader-instructions`, `/join/[code]` and `/join/verify/[token]`. They look
 * and behave exactly like the rest of the public site — same header, footer,
 * banners, help widget, theme and pre-setup holding screen, all from the one
 * shared `WebsiteChrome` — and they differ from `(website)` in exactly one
 * respect: the nonce below is minted for this request, not for this release.
 *
 * ## Why these three are here rather than in `(website)`
 *
 * The first cut of D1 gave the fixed per-release nonce to the whole `(website)`
 * group, on the structural argument that one shared layout can stamp only one
 * nonce. The owner narrowed it back on 3 Aug: the fixed nonce is a real, if small,
 * loss of defence — the value is readable in the page source, so it no longer
 * stops a fully injected `<script>` tag — and it was accepted only for the five
 * pages whose content is double-sanitised admin HTML and whose benefit is a stored
 * page. These three get none of that benefit:
 *
 *  • `/hut-leader-instructions` is per-assignment and PIN-gated (`?a=` from an
 *    assignment email), so there is no shared copy to store;
 *  • `/join/[code]` and `/join/verify/[token]` carry a group code and a one-time
 *    token in the URL, and a stored copy is a page that skips its own re-check.
 *
 * All three are `force-dynamic`, so nothing about them is ever stored, so nothing
 * about them needs a nonce that outlives a request — and paying the fixed nonce's
 * cost for no benefit is the trade the owner reversed.
 *
 * ## Why the group-level declaration, and why reading the request here is safe
 *
 * `export const dynamic = "force-dynamic"` is declared on the LAYOUT so it covers
 * every route in the group including any added later, the same shape
 * `(public)/layout.tsx` uses. Each page also states it for itself, because each
 * has its own permanent reason and the reason belongs next to the route;
 * `scripts/ci/check-website-render-modes.mjs` requires both.
 *
 * The `headers()` read below is the exact call whose removal from the shared
 * layout was the whole of slice 1. It is safe here and nowhere else: it opts THIS
 * group's routes out of static rendering, which is what they already are, and it
 * cannot reach the five — `(website)/layout.tsx` is a sibling, not a parent. That
 * containment is the reason the split is two route groups rather than a
 * conditional inside one layout.
 */
export const dynamic = "force-dynamic";

export default async function DynamicWebsiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // `?? undefined` rather than `?? ""`: an empty nonce attribute is worse than no
  // attribute, and `AnalyticsConsent` already treats undefined as "stamp nothing".
  // In production the proxy always sets this header — it runs on every address the
  // matcher admits, with no header a caller can use to skip it (#2404) — so the
  // fallback covers a direct `next start` with no middleware, not a live request.
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

  return <WebsiteChrome nonce={nonce}>{children}</WebsiteChrome>;
}
