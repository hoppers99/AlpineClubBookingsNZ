- **The Xero booking-repair sweep now covers exactly the dates you ask it for
  (#2868).** Running the repair tool with `--from 2026-07-01 --to 2026-07-31`
  searched *check-in* dates from 30 June to 30 July. Bookings checking in on the
  last day of the range were left out of the repair unless they happened to have
  been created or changed earlier in the window, and bookings checking in the
  day before the range were pulled into it.

  The report's own header echoed those shifted dates back, so there was nothing
  on screen to reveal the mismatch. The header understated things, though: only
  the check-in half of the search was shifted. Bookings were still matched on
  having been created, updated or modified within exactly the days you asked
  for, so an old report's findings on those are accurate even though its header
  says otherwise.

  Both are fixed: the two dates you type are now the two days that are searched,
  inclusive at each end and on every field, and the header repeats what you
  typed. Re-run any sweep whose check-in dates mattered.

- **The repair tool now refuses an impossible date instead of quietly moving it
  (#2868).** `--to 2026-04-31` was accepted and silently read as 1 May, so a
  sweep could run a day past the month it named; `2026-02-30` became 2 March,
  and 29 February in a non-leap year became 1 March. All three are now rejected
  with a message naming the flag and the value you typed. Real dates, including
  a genuine 29 February in a leap year, are unaffected.
