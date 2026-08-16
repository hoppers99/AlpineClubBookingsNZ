- **The two biggest content files in the system are now organised by subject,
  with moved output pinned and every discovered residual resolved (#2689).** The club's email
  templates lived in one 5,000-line file and its admin help content in one
  2,695-line file. Both have been broken up: emails now sit in one module per
  kind of message — bookings, membership, waitlist, family groups, the finance
  and booking alerts an administrator receives, and so on — matching the way
  the system already groups who sends what. Help content now sits in one module
  per section of the admin menu, so the help for a page lives under the same
  heading an operator found the page under.

  The 193 pre-existing rendered email bodies compared byte for byte before and
  after the structural move and came out identical. One pre-split recorded pin
  for the repeated-Xero-failure alert was stale; re-rendering the exact old head
  produces the same 5,799 bytes and hash as the split head, so the corrected pin
  records existing output rather than accepting a split-induced change. The
  permanent corpus now pins 219 complete outputs, including the three bodies
  previously built at their send sites. Those three now use the standard branded
  email shell, and the two failure alerts escape their recipient, template, and
  booking values.
  Deliberate mutations proved the gate catches body drift, an unregistered
  module, duplicate renderer names, duplicate case or pin IDs, and a removed
  escaping call.

  The operator-visible corrections are deliberate. The help panel for
  **Admin > Notifications** carried two versions of its text, and the one
  nobody could ever see was an out-of-date description of an older page; that
  has been removed, and the surviving panel now also explains the per-template
  delivery setting (always, only when there is something to report, or off).
  Contact-form and email-failure alerts now carry the same branded shell as the
  rest of the system catalogue rather than one-off raw HTML.

  Three smaller things improved along the way. Booking-money arithmetic now
  lives at the business-logic boundary instead of inside the template folder.
  A member's booking page no longer
  has to load the entire administrator help corpus to show the eleven-line
  booking status glossary. And the one place the system relaxes its
  date-formatting rule — for the chore roster's long weekday date — is now
  scoped to an 88-line file instead of a 5,000-line one.
