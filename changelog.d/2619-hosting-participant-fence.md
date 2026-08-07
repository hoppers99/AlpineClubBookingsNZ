- **A safety check that protects bookings during member merges was not running in
  several places (#2619).** The club's booking system holds a brief database lock on the
  members involved whenever it records an adult-hosting obligation, so that two
  administrators working at the same time — one editing a booking, one merging duplicate
  member records — cannot leave a booking pointing at a member who no longer exists. The
  code that issues the "these members are locked" proof had an escape hatch: if it was
  handed a database connection it could not lock with, it returned the proof anyway. Every
  later check trusted that proof, so the protection quietly switched off for the rest of
  that operation.

  **Nothing was ever at risk on a live site.** The escape hatch could only be reached by a
  connection that cannot run a lock statement, and every real database connection can. It
  was reachable only from the project's own automated tests — which is exactly why it
  mattered: fourteen test suites covering booking cancellation, guest changes, date
  changes, booking requests, quotes and waitlist confirmation were all exercising this
  protection with it switched off, so none of them would have noticed if it broke.

  The escape hatch is gone: a connection that cannot take the lock is now refused outright
  rather than handed a proof it did not earn. All fourteen suites were reworked to model
  what the lock genuinely reads, and each one now demonstrably fails if the protection is
  removed — which is the property that was missing before. No club-facing behaviour
  changes, and nothing is required of operators.
