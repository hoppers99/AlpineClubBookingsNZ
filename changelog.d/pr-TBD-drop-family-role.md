- **The obsolete family-group rank column is now removed from the database
  (#2520).** The entry above describes the change itself: a family-group
  membership no longer records a rank, because every adult with a login in a
  family group is equal. That entry stopped the club's software using the value.
  This one removes the column that stored it.

  **Nothing your club does changes and no screen changes.** Nothing has read the
  value since the power it once gated was re-anchored elsewhere, and nothing ever
  displayed it. Family groups, family requests, invitations, member merge, billing
  family and Xero member import all behave exactly as they do now.

  **This release needs a short maintenance window, and your operator should read
  the upgrade notes before scheduling it.** The change that stops using the column
  and the change that removes it ship together, rather than carrying an obsolete
  column through another upgrade — that was a deliberate decision. It means the
  previous version cannot run once the upgrade has been applied, so the site goes
  into maintenance mode for the few minutes the change takes instead of rolling over
  seamlessly. A fresh backup is taken and verified first, the stored values are
  recorded before they go, and a tested reverse script ships with the release in
  case the new version does not start. `docs/UPGRADING.md` has the sequence in plain
  English.

  **If your operator is also applying the subscription-lockout change in this
  release, the two share one maintenance window** — not two. The site goes down
  once, both changes are applied in the same step, and it comes back up.

  One thing to know rather than to act on: the old rank values themselves cannot be
  put back by script once removed, because a database cannot un-remove a column. The
  upgrade notes have your operator save a copy of them first, and the reverse script
  can load that copy back if it is ever needed. Nothing reads those values, so this
  is a record-keeping point, not a risk to how the club works.
