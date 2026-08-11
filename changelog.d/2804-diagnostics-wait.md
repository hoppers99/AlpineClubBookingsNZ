- **Diagnostics now waits for a busy database instead of giving up (#2804).** When
  several people are using the system at once, a diagnostic question used to give up
  after two seconds and tell you it could not gather the evidence — even though nothing
  was wrong and the database was simply busy for a moment.

  It now waits up to twenty seconds for its turn. If it does eventually give up, it says
  so honestly: **"the database was too busy to start that diagnostics read — nothing is
  broken, try again shortly"**, which is a different message from the one you get when
  something has actually failed. Those two used to look identical, which sent people
  looking for a fault that did not exist.

  **Diagnostics does not let a query itself run any longer than before.** Waiting longer
  for a turn is safe; letting a slow query keep running is what makes a busy database
  busier, so that limit is unchanged at five seconds.

  There is no visible screen for Diagnostics yet, so nothing looks different today. When
  that screen arrives it will show a "still working" message while it waits, so a slow
  answer never looks like a frozen page.
