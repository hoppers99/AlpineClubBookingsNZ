- **The two biggest content files in the system are now organised by subject,
  with every email preserved byte-for-byte and one stale help entry reconciled
  (#2689).** The club's email
  templates lived in one 5,000-line file and its admin help content in one
  2,695-line file. Both have been broken up: emails now sit in one module per
  kind of message — bookings, membership, waitlist, family groups, the finance
  and booking alerts an administrator receives, and so on — matching the way
  the system already groups who sends what. Help content now sits in one module
  per section of the admin menu, so the help for a page lives under the same
  heading an operator found the page under.

  Every one of the 217
  rendered email bodies was compared byte for byte before and after the move
  and came out identical. The structural help move was also compared before and
  after for every resolved path before the Notifications correction below.
  That email comparison is now a permanent check, so a future reorganisation
  cannot quietly alter what a member receives; deliberate mutations proved it
  can catch body drift, an unregistered module, and duplicate case or pin IDs.

  One operator-visible help correction travelled with it. The help panel for
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
