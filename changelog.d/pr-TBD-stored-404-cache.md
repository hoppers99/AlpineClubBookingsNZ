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
