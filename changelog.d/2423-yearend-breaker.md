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

  It can no longer start the pause. Nothing else changes: the club is still
  protected from a genuine Xero outage exactly as before, because invoicing,
  syncing, Xero notifications and the accounting-period lock check all still
  trigger the pause themselves — and the year-end lookup still **observes** a
  pause any of them started, so it never adds load during an outage either.
