- **A chore roster is now always read for the night it names, whatever clock the
  machine reading it happens to be set to (#2478).** Three places in the chore
  roster worked out "which night is this?" from the time zone of the computer
  running them rather than from the roster date itself, so the same date could
  mean different things in different places.

  The printable-roster feed asked the database for the wrong day whenever the
  server was set to New Zealand time, and answered with an empty sheet under the
  correct date heading. On the lodge kiosk's roster setup screen, a chore that
  repeats every few days worked out "last done N days ago" from midnight where
  the browser was, so on the two nights a year daylight saving changes it could
  report a day too few and hold a chore back as not yet due. And chores
  scheduled for particular weekdays were matched against the weekday as the
  server's own region saw it, which only agrees with the roster night on a
  server set to New Zealand time or further east.

  All three now read a roster night as the plain calendar day it is, the same
  way every other roster screen already did. Nothing about who is rostered, or
  how the roster is worked out, has changed — only which night gets read.
