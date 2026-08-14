- **The member merge screen no longer shows two of its dates a day early
  (#2860).** Before two member records are merged, an administrator is shown
  them side by side so they can judge which record should survive — a decision
  that cannot be undone once the merge runs. Two of the dates in that comparison
  were worked out from the UTC clock instead of the club's calendar, so for
  roughly the first half of every New Zealand day they read as the previous day.

  The two are the duplicate's profile-photo "last updated" stamp and the
  hut-leader eligibility date. Both record a moment something happened, and both
  now show the club's calendar day — which matters here because the photo date
  is one of the few signals on the screen for deciding which record is the more
  recent. Date of birth, joined date and life member date are ordinary calendar
  dates rather than moments, so the way they are displayed is unchanged.

  One thing this does **not** fix, so that nobody reads the above as a clean bill
  of health: some dates of birth brought in from Xero were SAVED a day early when
  they were imported, and this screen shows what was saved. Those still read a
  day early here, and correcting them means correcting the stored value — which
  is being handled separately (#2859).

  Nothing stored has changed, no merge behaves differently, and no other screen
  is affected: this only fixes which day those two values are shown as.
