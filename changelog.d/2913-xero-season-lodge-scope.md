- **Invoices raised to Xero now take their season from the booking's own lodge
  (#2913).** A club running more than one lodge can give each lodge its own
  season dates. When two lodges both had an active season covering the same
  night, the invoice could pick up the *other* lodge's season, and with it the
  wrong hut-fee item code — so the revenue could post to the wrong account in
  Xero.

  Bookings, booking-invoice updates and combined group-settlement invoices all
  now look up the season against the lodge the stay is actually at. A club with
  a single lodge, or one whose lodges share the same season dates, will see no
  change: the account those invoices were already posting to was the right one.
