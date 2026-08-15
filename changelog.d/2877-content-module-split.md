- **The two biggest content files in the system are now organised by subject,
  with no change to a single email or help page (#2689).** The club's email
  templates lived in one 5,000-line file and its admin help content in one
  2,695-line file. Both have been broken up: emails now sit in one module per
  kind of message — bookings, membership, waitlist, family groups, the finance
  and booking alerts an administrator receives, and so on — matching the way
  the system already groups who sends what. Help content now sits in one module
  per section of the admin menu, so the help for a page lives under the same
  heading an operator found the page under.

  Nothing an operator or a member sees has changed. Every one of the 193
  rendered email bodies was compared byte for byte before and after the move
  and came out identical, and the whole help corpus was compared the same way.
  That email comparison is now a permanent check, so a future reorganisation
  cannot quietly alter what a member receives; it was deliberately broken three
  times first to prove it can actually catch a change.

  Two operator-visible fixes travelled with it. The help panel for
  **Admin > Notifications** carried two versions of its text, and the one
  nobody could ever see was an out-of-date description of an older page; that
  has been removed, and the surviving panel now also explains the per-template
  delivery setting (always, only when there is something to report, or off).
  Nothing else an operator reads has changed.

  Two smaller things improved along the way. A member's booking page no longer
  has to load the entire administrator help corpus to show the eleven-line
  booking status glossary. And the one place the system relaxes its
  date-formatting rule — for the chore roster's long weekday date — is now
  scoped to an 88-line file instead of a 5,000-line one.
