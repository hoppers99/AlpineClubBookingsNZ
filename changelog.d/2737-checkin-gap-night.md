- **A guest can no longer be checked in for a night they are not booked for
  (#2737).** A booking can cover some nights and not others — in on Friday, home
  on Saturday, back on Monday. The kiosk has never offered a check-in button on
  the Saturday, but the request behind that button would still have been accepted
  if it arrived, which a page left open from an earlier night could do.

  The server now decides from the guest's actual booked nights rather than from
  the first and last date of their stay, so such a request is refused. The hut
  leader is told plainly that the guest is not booked in for that night and to
  reload the day, instead of the old unhelpful "Failed to update arrival".

  Nothing changes for an ordinary booking with no gap in it, and a guest whose
  booking predates per-night records still checks in on every night of their
  stay exactly as before. Check-out was already correct and is unchanged.
