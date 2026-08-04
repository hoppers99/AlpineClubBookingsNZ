- **The obsolete family-group rank column is now removed from the database
  (#2520).** The #2565 entry in this release describes the change itself: a
  family-group membership no longer records a rank, because every adult with a
  login in a family group is equal. That entry stopped the club's software using
  the value. This one removes the column that stored it.

  **Nothing your club does changes and no screen changes.** The one power the value
  ever gated is re-anchored in this same release onto a deliberate signal instead, and
  nothing ever displayed the value. Family groups, family requests, invitations,
  member merge, billing family and Xero member import all behave exactly as they do
  now.

  **This release needs a maintenance window, and your operator should read the
  upgrade notes before scheduling it.** The change that stops using the column and
  the change that removes it ship together, rather than carrying an obsolete column
  through another upgrade — that was a deliberate decision. It means the previous
  version cannot run once the upgrade has been applied, so the site goes into
  maintenance mode instead of rolling over seamlessly. The removal itself is quick;
  the outage lasts as long as a careful shutdown, a verified backup, the recorded
  checks and a smoke test take, which is longer than the change. Your operator will
  give you a time when they schedule it — the upgrade notes tell them to measure it on
  a rehearsal rather than guess. A fresh backup is taken and verified first, the
  stored values are recorded before they go, and a tested reverse script ships with
  the release in case the new version does not start. `docs/UPGRADING.md` has the
  sequence in plain English.

  **If your operator is also applying the subscription-lockout change in this
  release, the two share one maintenance window** — not two. The site goes down
  once, both changes are applied in the same step, and it comes back up. One thing
  for them to note before the day: if that combined upgrade ever has to be undone,
  it takes both changes' reverse scripts, not one. The upgrade notes say which
  order.

  One thing to know rather than to act on: the old rank values themselves cannot be
  put back by script once removed, because a database cannot un-remove a column. The
  upgrade notes therefore have your operator save a copy of them first — that copy is
  required, not optional — and the reverse script can load it back if it is ever
  needed. Without it, an undo would refill every membership with the plain value.
  Nothing in the new version reads that value at all, so the worst case is one
  convenience path on the *old* version refusing until an admin restores the copy —
  it refuses rather than letting anyone through, and the ordinary way of doing the
  same thing still works.
