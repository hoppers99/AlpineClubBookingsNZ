- **A member loading a page while Xero is down can no longer pause the club's
  invoicing (#2423).** When Xero starts failing, the system deliberately stops
  talking to it for a couple of minutes rather than hammering a service that is
  already struggling. That pause is a good thing when it is triggered by work
  that matters — sending invoices, syncing, replaying a Xero notification — but
  it was also being triggered by a small background lookup that runs on ordinary
  member page views, purely to find out which month the club's financial year
  ends in.

  That lookup does not need a live answer: when it cannot reach Xero it quietly
  uses the month it already knows. But it could still start the pause, and while
  Xero was unwell it ran often enough that steady member traffic could keep the
  pause running more or less continuously — with invoices queued in that window
  being marked as failed and needing an administrator to send them again.

  It can no longer start the pause, and the club is still protected from a
  genuine Xero outage exactly as before: invoicing, syncing, Xero notifications
  and the accounting-period lock check all still trigger the pause themselves,
  and the year-end lookup still **observes** a pause any of them started.

  Being unable to start the pause also meant the lookup no longer paused
  *itself*, so it now backs off on its own instead: while Xero is unreachable
  and it already knows the month, it waits about two minutes between attempts
  rather than a few seconds, and it only asks Xero once per attempt instead of
  twice. If it has no month yet it keeps checking every few seconds, so a fresh
  server picks up the real month as soon as Xero can give it one, and an
  administrator's **Try again** always checks immediately.

- **Invoices that Xero was never even asked about are now retried
  automatically.** While that couple-of-minutes pause is running, every queued
  Xero job is refused before anything is sent. Those jobs were being recorded as
  *failed* even though nothing had been attempted, and a failed job waits for an
  administrator to press **Requeue** — so a short Xero wobble could leave a
  batch of members' invoices sitting unsent with nobody aware. A job refused by
  the pause now goes back into the queue and is picked up by the next run once
  Xero is available again. Jobs that Xero genuinely rejected still show up as
  failures for an administrator to look at, exactly as before.
