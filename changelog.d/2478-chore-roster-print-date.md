- **The lodge kiosk no longer holds a repeating chore back for a few nights
  after the spring clock change (#2478).** On the roster setup screen, a chore
  that repeats every few days is either offered ready-ticked or shown with a
  note like "Last done 2 days ago, next due in 1 day" and left unticked. That
  gap was counted from midnight where the kiosk's browser is, so the hour New
  Zealand loses on the last Sunday in September counted as a missing day: from
  that Sunday until the chore's own cycle had passed, a chore that was in fact
  due read as a day short and was left off the roster unless the hut leader
  ticked it back on. The gap is now counted between the two roster nights
  themselves, which are plain calendar days, so it reads the same before, during
  and after a clock change. The autumn change, which adds an hour rather than
  taking one away, never miscounted and is unaffected.

  Two related reads were tidied up at the same time, and neither had gone wrong
  in practice, because the club's server runs pinned to New Zealand time. The
  weekday used to decide whether a chore is scheduled for, say, Mondays only was
  read in the server's own region rather than off the roster night — those two
  agree on any server at or ahead of UTC, which is where this club's is. And the
  printable-roster data feed asked the database for the day before the one it
  was given, and was not limited to a single lodge. Nothing in the club system
  calls that feed, so nobody has printed a blank or a wrong sheet from it; it is
  simply correct now for whatever uses it next, including at a club running more
  than one lodge.

  Nothing about who gets rostered, or how a roster is worked out, has changed —
  only which night gets read.
