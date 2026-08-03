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

  Two small operator-visible details. The site map (`/sitemap.xml`) was the same
  fault in a more exposed form — a cache could have held it for a year — and it is
  closed the same way; search engines refetch it each time, which is what the club
  wants anyway. And any file added to the shipped `public/` folder that is not an
  image (a self-hosted font, say, or a PDF) will be fetched fresh on every page view
  rather than cached by the browser. Nothing shipped today is affected; if that ever
  matters, the fix is a one-line addition to the shared list of asset file types in
  `src/lib/asset-url-404.ts` rather than a change to the caching rule.
