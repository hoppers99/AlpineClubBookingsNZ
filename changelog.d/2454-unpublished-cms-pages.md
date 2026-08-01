- **Draft website pages stay private everywhere, not just on admin-created
  pages (#2440).** An admin's "published" toggle is the only control over
  whether website content is public — but the code-backed routes at `/contact`,
  `/join`, `/join/apply`, the home page, and the site's 404 boundary read their
  CMS content without checking it, so a draft row at one of those paths (only
  producible from legacy or hand-written data — the admin screens have always
  refused to hide these built-in pages) would have been served to anonymous
  visitors, title, header and body included. Every public route now reads
  through one shared published-filtering helper: `/contact`, `/join` and
  `/join/apply` fall back to their built-in copy and forms exactly as when no
  row exists, the home page and admin-created pages answer 404, and the error
  boundary falls back to its plain "Page Not Found" screen. A contract test
  bans the unfiltered read from all application code outside the helper's own
  module so the gap cannot quietly return. And because a hidden built-in page
  now genuinely disappears — a hand-edited row could take the home page to a
  404 — the admin Pages panel gains a matching repair: a built-in page that
  somehow shows **Hidden** now offers its one-click **Publish** button (hiding
  it remains impossible).
