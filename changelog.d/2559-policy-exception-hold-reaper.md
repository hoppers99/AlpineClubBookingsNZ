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
  request as Expired. The member is then free to raise a fresh request. The
  setting that turns these holds on now says the deadline out loud, on the option
  itself and on the saved rule, so nobody chooses Hold expecting it to last until
  they get back from leave.

  Two limits are deliberate. A request that reserves no beds — most exception
  requests, and any request that only shrinks a booking — is never closed by the
  job, because it costs the club nothing to leave it open for a human to decide.
  And a decision and an expiry can never both land on one request: whichever gets
  there first wins, so a decision made before the job claims the request stands,
  and an officer who is beaten to it by seconds is told the request is already
  closed and asks the member to raise a fresh one.

  Nobody is left guessing when a request lapses. The member who raised it gets a
  short email saying the request was not decided in time, that the beds it was
  holding have gone back to the pool, and that their booking itself has not
  changed, so their next move is a fresh request rather than a duplicate raised in
  the dark. That email is sent only after the beds have actually been returned, so
  a mail problem can never undo or repeat a release, and never stops the job
  working through the rest of its list. The request also shows as Expired on the
  member's booking, and every expiry writes an audit entry naming the request, the
  booking and the beds released, so "why did this close?" has an answer without
  reading server logs.

  Officers can find expired requests through the exception-request queue's All
  filter; a dedicated Expired view arrives with the officer queue screen (#2526).
  The new job appears on the admin cron health page like the others, and reports
  any past-deadline request it could not close, so a stuck hold cannot hide behind
  a green health row.
