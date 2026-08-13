- **A booking made in the morning is no longer dated to the day before on the
  invoice and in the finance export (#2697).** New Zealand runs 12 to 13 hours
  ahead of UTC, so for roughly the first half of every local day the club's date
  and the world clock's date disagree. Two places still read the world clock's
  date: the due date the club sends to Xero on a new booking invoice, and the
  `created_date` column of the legacy finance export. A booking made at 9am on
  the 8th was invoiced as though it had been made on the 7th, and reported under
  the 7th, which also pulled its overdue comparison forward by a day.

  Both now use the club's own calendar, the same one the rest of the system uses
  for a lodge night. Nothing else about how invoices or the export are produced
  changed, and the lodge nights themselves were already correct.

  **Invoices already sent to Xero are left exactly as they are.** This changes
  new output only — nothing is written back to the accounting system, and no
  historical figures are restated. An invoice raised before this release keeps
  the due date it was issued with.
