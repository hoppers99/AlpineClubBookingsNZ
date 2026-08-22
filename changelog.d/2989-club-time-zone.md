- **The club's time zone is now a club setting instead of a server setting
  (#2989).** Every date and time this platform shows a member is written in the
  club's own time, and until now that time zone came from the `TZ` value whoever
  ran the server happened to start it with. It is now recorded in the database
  and edited in-app at **Admin → System → Club Time Zone**, so the club owns it
  rather than the container.

  It is stored as a place — `Pacific/Auckland` — not as a number of hours, so
  the platform keeps its own daylight-saving rules and knows on its own when New
  Zealand clocks move. Abbreviations such as `NZT` and fixed offsets such as
  `+12:00` are refused, because neither names a place and neither carries any
  promise about next spring's rules.

  **Nothing changes at this upgrade.** The first time the upgraded application
  starts, it records the time zone it is already effectively using, so the
  displayed time before and after is the same whatever zone you run on. A club
  outside New Zealand is not reset to New Zealand; `Pacific/Auckland` is used
  only on a brand-new installation that has nothing configured at all. Confirm
  it afterwards on the **Club Time Zone** step of the setup checklist.

  Changing it later is a Full Administrator job: it asks for an explicit
  confirmation and records who changed it and what it was before. **It rewrites
  nothing.** No stored date or time moves, and a stay keeps the same lodge
  nights — what changes is how recorded moments are written out from now on, and
  the club-local hour that overnight work runs at.

  `TZ` and `NEXT_PUBLIC_TZ` are now a seed only: they are what an existing
  installation's zone is copied from, once, and editing them afterwards no
  longer changes what members see. The club's time zone and the server's own
  clock setting are two different things, and from here the server's is
  deliberately irrelevant to what anybody reads.
