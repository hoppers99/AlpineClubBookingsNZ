- **Mistyped and unclaimed addresses can no longer be held in a shared cache, and
  never carry a browser cookie alongside a caching instruction (#2578).** Since the
  public pages began being stored and re-served, an address that belongs to no page
  at all — a typo under the member or admin area, or a bare `/pay` — was answered
  with a "page not found" that told any cache sitting between the visitor and the
  site that it could keep the answer, and go on serving it for up to a year. Nothing
  the club does, including editing content or deploying, could reach a cache holding
  it.

  Those answers now say plainly that they must not be stored, exactly as they did
  before the change that introduced this. The club's own hosting has no such cache,
  so no club was affected in practice; the exposure was to a CDN or a corporate
  proxy in front of a fork or between a visitor and the site.

  Nothing changes for members or for the public pages themselves: the same content
  is served, at the same speed, and the club logo and other shipped images keep
  their normal browser caching.

  Two small operator-visible details. The site map (`/sitemap.xml`) had a milder
  version of the same fault, and it is closed the same way. It already told caches to
  check with the site every single time, so it could never be served stale — but it
  also called the answer shareable while carrying the sign-in marker cookie, and a
  shared cache that keeps a shareable answer can hand the cookie that came with it to
  the next visitor. It now says plainly that it must not be stored. Search engines
  refetch it each time, which is what the club wants anyway.

  And any file in the shipped `public/` folder that is not an image (a self-hosted
  font, say, or a PDF) is now fetched fresh on every page view rather than cached by
  the browser. `robots.txt` is the one such file shipped today and the practical
  effect on it is nil, because it already told browsers to check every time. If a
  font or a PDF is ever added and its caching matters, the fix is a one-line addition
  to the shared list of asset file types in `src/lib/asset-url-404.ts` rather than a
  change to the caching rule.
