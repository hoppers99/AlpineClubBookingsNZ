- **Diagnostics now waits for a busy database instead of giving up (#2804).** When
  several people are using the system at once, a diagnostic question used to give up
  after two seconds and tell you it could not gather the evidence — even though nothing
  was wrong and the database was simply busy for a moment.

  It now waits up to eight seconds for its turn. If it does eventually give up, it says
  so honestly: **"the database was too busy to start that diagnostics read — nothing is
  broken, try again shortly"**, which is a different message from the one you get when
  something has actually failed. Those two used to look identical, which sent people
  looking for a fault that did not exist.

  **Eight seconds rather than longer, for a reason worth stating.** The waiting limit is
  shared with everything else the site does. Making diagnostics wait longer than eight
  seconds would have meant raising that shared limit, which would also make a member
  wait longer before being told a booking or payment page had failed. Eight seconds is
  the most diagnostics can take without changing anything members experience.

  **Diagnostics does not let a query itself run any longer than before.** Waiting longer
  for a turn is safe; letting a slow query keep running is what makes a busy database
  busier, so that limit is unchanged at five seconds.

  One readout is unaffected — background job health reads through a shared Admin > Health
  calculation with its own limit, so it behaves exactly as it did.

  There is no visible screen for Diagnostics yet, so nothing looks different today. When
  that screen arrives it will show a "still working" message while it waits, so a slow
  answer never looks like a frozen page.
