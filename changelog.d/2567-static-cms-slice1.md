- **The club's own information pages are now built once and kept, instead of being
  rebuilt for every visitor (#2352).** Every page an admin writes in Page Content —
  the privacy policy, the rules, the FAQ, the committee page and anything else added
  there — used to be assembled from scratch each time anyone opened it. On a quiet
  club site that meant almost every visit was a slow one, because the server had
  nothing warm to work from. Those pages are now built the first time someone asks
  for one and then handed out ready-made.

  Editing still takes effect straight away. Saving a page, hiding or publishing it,
  changing the site colours or logo, adding or removing a site banner, switching a
  module on or off, changing the lodge capacity or its bed allocation, and uploading,
  deleting or reorganising Image Manager photos all clear the stored copy
  immediately. The one thing that got slower is anything that changes with no save
  behind it — a site banner whose start time simply arrives. That now takes at least
  five minutes, and then one more visit: the first visitor after the five minutes is
  still shown the old copy and only triggers the rebuild, so the change appears from
  the visit after that. Five minutes was chosen deliberately; a shorter window would
  have the site quietly rebuilding itself every minute and give back much of the
  speed.

  Because one copy is now shown to everybody, the "Log In" / "Dashboard" button in
  the top bar sorts itself out in your browser a moment after the page appears. A
  signed-in member may see "Log In" for a fraction of a second first. Nothing
  personal has ever been shown in that bar, and every page behind those links is
  still checked properly when you open it.

  There is one security trade here, and it was decided rather than assumed. These
  pages now carry a fixed security token for the life of a release instead of a
  fresh one per visit — a stored page can only carry one. It still blocks the
  commoner ways an attacker tries to run code in a page, and the club's own page
  content is filtered twice before it is ever displayed. Every other protection is
  unchanged, and Stripe was removed from the list of scripts allowed on these pages,
  where it is never used. Sign-in, the member area and the admin area keep a fresh
  token per visit exactly as before. The reasoning, the options that were rejected,
  and what a fork serving several clubs from one server would need to know are all
  written up in `docs/SECURITY-ATTACK-SURFACE.md`.

  One naming rule got stricter as part of this. A content page may no longer start
  with a word the application itself owns — `pay`, `calendar`, `notices`, `profile`,
  `chores`, `bookings`, `lodge`, `finance`, `display` and the like, alongside the
  `admin`/`login`/`register` names that were already refused. Saving one now returns
  a clear error. Those addresses could be created before and appeared to work, but
  under whole-page caching they would have been served with a security token that no
  longer matched, so nothing on the page would run. If you already have such a page
  it now shows "page not found" until you rename it. It also stops being advertised —
  the site menu drops it and a Book Now button aimed at it goes back to the normal
  booking flow — so no link points at the dead address, which is also why it is worth
  looking for one after upgrading: `CONFIGURATION.md` ("Some slugs are refused, and the
  list grew") lists the reserved words, and Admin > Page Content still shows the page
  with its address, ready to rename.

  The home page, Join, Contact and the membership application form are deliberately
  unchanged for now; they follow in a later step once this one has been measured on
  a real deployment.
