- **The club's time zone becomes a club setting instead of a server setting
  (#2989).** Every date and time this platform shows a member is written in the
  club's own time, and until now that time zone came from the `TZ` value whoever
  ran the server happened to start it with. It is now recorded in the database and
  edited in-app at **Admin → Setup & Configuration → Club Time Zone**, so the club
  owns it rather than the container.

  It is recorded as a place — `Pacific/Auckland` — not as a number of hours, so
  the platform keeps its own daylight-saving rules and knows on its own when New
  Zealand clocks move. Abbreviations such as `NZT` and fixed offsets such as
  `+12:00` are refused, because neither names a place and neither carries any
  promise about next spring's rules.

  **Nothing changes at this upgrade, on any deployment.** The first time the
  upgraded application starts, it records the time zone you are already running
  on, and displayed times keep coming from `TZ` for now — this release records the
  setting that takes over as the rest of the time-zone work ships. So while both
  exist, keep the two in step. A club outside New Zealand is not reset to New
  Zealand: an older spelling is recorded under its modern name (`GB` becomes
  `Europe/London`), and where `TZ` names no place at all — `UTC`, `Etc/UTC` — the
  upgrade records **nothing** rather than guessing, and the setup checklist asks a
  Full Administrator to choose. Confirm the **Club Time Zone** step on the setup
  checklist after upgrading, and leave `TZ` in place while you do.

  Changing it later is a Full Administrator job: it asks for an explicit
  confirmation and records who changed it and what it was before. **It rewrites
  nothing.** No stored date or time moves, and a stay keeps the same lodge
  nights — what changes is how recorded moments are written out from then on, and
  the club-local hour that overnight work runs at.
