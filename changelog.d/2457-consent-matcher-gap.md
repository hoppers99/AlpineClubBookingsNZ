- **The member-guests module switch now really does reach the consent endpoint
  (#2435).** Turning a module off is meant to make its routes disappear at the
  front door, before any of the app's own code runs. For `POST
  /api/bookings/[id]/guests/[guestId]/consent` that never actually happened: the
  rule naming the route was written, but the address was missing from the list of
  URLs the proxy is asked to run on at all, so the rule sat there unable to fire.

  **Nothing was left unprotected.** The endpoint checks the member-guests module
  itself and answers the same `403 Forbidden` it gives every other refusal when
  the module is off, before it reads a single booking or guest row — so a club
  with the module switched off was, and always has been, refused. What was
  missing was the second, outer layer that is supposed to sit in front of that
  one. This restores it.

  A new contract test now walks every module route rule and fails if it names an
  address the proxy would never run on. A rule written as a plain path prefix
  covers a whole branch of the site, so it is checked at the prefix itself *and*
  at an address below it; a rule written as a pattern is checked once for every
  address shape it accepts. That turned up two more addresses — the Xero cron and
  webhook paths — where anything filed underneath them would have slipped past
  the module switch, and they are now covered too.

  The rules themselves also now read an address the way a browser can spell it
  before deciding: a trailing slash, or the internal spelling used when a page's
  data is fetched rather than the page, no longer walks past a module switch that
  plainly names that route.
