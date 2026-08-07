- **The retroactive-stay browser test can now be run twice in a row, and its
  calendar step says what went wrong (#2625, #2626).** Nothing an administrator
  uses has changed — this is the automated test suite that guards the "record a
  past stay on behalf of a member" journey.

  Two faults in the same test file. First, the test created a real past booking
  and never removed it, so running it a second time against the same test
  database failed: the booking it made the first time was already occupying the
  dates it tries to use. Worse, the dates are worked out relative to the day the
  test runs, so a booking left behind by yesterday's run could block today's. The
  test now clears its own leftovers before it starts, covering every date any of
  its attempts can land on, and it leaves the club's own seeded example bookings
  alone.

  Second, the test that checks a member cannot pick past dates was giving up
  after ninety seconds with a message about the browser being closed, which said
  nothing useful. The real cause was the "Confirm member details" pop-up sitting
  open over the calendar, because that part of the test only knew how to dismiss
  two of the pop-up's three steps. The pop-up is now handled by the shared,
  fully-tested routine, and the calendar step reports exactly what it could not
  reach — in fifteen seconds rather than ninety — so the next failure of this kind
  explains itself instead of looking like a crashed browser. The same fifteen-second
  limit now covers the click on the day itself, and a step that only needs the month
  already on screen no longer presses "Next" and walks away from it.
