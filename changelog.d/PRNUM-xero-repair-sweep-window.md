- **The Xero booking-repair sweep now covers exactly the dates you ask it for
  (#2868).** Running the repair tool with `--from 2026-07-01 --to 2026-07-31`
  actually searched 30 June to 30 July. Bookings checking in on the last day of
  the range were left out of the repair unless they happened to have been
  created or changed earlier in the window, and bookings checking in the day
  before the range were pulled into it.

  The report's own header echoed the same shifted dates back, so there was
  nothing on screen to reveal the mismatch — it simply looked like the tool had
  been asked for a different fortnight than it had.

  Both are fixed: the two dates you type are now the two days that are swept,
  inclusive at each end, and the header repeats what you typed. If you are
  reading a repair report produced before this change, treat its window as one
  day earlier at both ends than whoever ran it intended, and re-run any sweep
  whose last day mattered.
