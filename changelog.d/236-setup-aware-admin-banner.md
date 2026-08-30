- **The admin banner now nudges toward the setup wizard, not stale site-style
  advice (#236).** The only pre-launch nudge in admin used to gate on the
  public site's own launch flag and always say "Complete your site style
  before opening the public website" with a link to Site Style — a specific
  page that, for a club that has retired the older setup surfaces (#223),
  no longer has anything to do with publishing. It also only ever showed to a
  content editor, so the support officer the setup wizard actually serves
  never saw a nudge at all.

  The banner now shows whenever the club's setup journey isn't finished, says
  so in general terms, and links straight to the setup wizard — visible to any
  admin who can open the wizard itself, not content editors specifically. It
  never appears on the Setup pages, since you are already there.

  It now also covers the club that finishes the setup journey without ever
  opening the public site: once the journey is marked finished but the site
  hasn't launched, the banner switches to saying so, still linking to the
  wizard rather than to Site Style directly — the wizard's own Ready to open
  screen is what actually launches the site. The banner disappears only once
  both are true, and a database fault reading the journey's completion now
  hides the banner rather than 500ing the admin area or showing a false nag.
