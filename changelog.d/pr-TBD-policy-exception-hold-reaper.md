- **Beds held by a forgotten exception request are now given back automatically
  (#2553).** When a member asks the Booking Officers to allow a booking that
  breaks a soft policy, some of those requests quietly reserve real beds while
  they wait, so that an approval is guaranteed to fit. If nobody ever decided the
  request — the member did not withdraw it and no officer approved or rejected it
  — those beds stayed reserved indefinitely and were invisible to everyone else
  trying to book. An officer had to spot the stale request and reject it by hand.

  Each request that reserves beds now carries a deadline, set when it is raised
  and never changed afterwards: seven days, but never past the start of the first
  night it is holding, and never less than 24 hours so a late request still gets a
  real review window. A new "Policy-exception hold reaper" job runs every three
  hours, returns the beds from any request past its deadline, and closes that
  request as Expired. The member is then free to raise a fresh request.

  Two limits are deliberate. A request that reserves no beds — most exception
  requests, and any request that only shrinks a booking — is never closed by the
  job, because it costs the club nothing to leave it open for a human to decide.
  And if an officer decides a request at the same moment the job is releasing it,
  the officer's decision wins.

  No email is sent when a request expires. A member sees the Expired status on
  their request, and officers see it in the exceptions queue. The new job appears
  on the admin cron health page like the others, so an operator can confirm it is
  running.
