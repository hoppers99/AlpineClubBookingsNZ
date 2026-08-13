- **A booking made in the morning is no longer dated to the day before on its
  invoice and in the finance export (#2697).** New Zealand runs 12 to 13 hours
  ahead of UTC, so for roughly the first half of every local day the club's date
  and the world clock's date disagree. Two places read the world clock's date
  where they should have read the club's: the due date sent to Xero on a **new**
  booking invoice, and the `created_date` column of the legacy finance export. A
  booking made at 9am on the 8th was invoiced as though it had been made on the
  7th, and reported under the 7th, which also pulled its overdue comparison
  forward by a day.

  Both now use the club's own calendar — the same one already used for a lodge
  night. Nothing else about how invoices or the export are produced changed, and
  the lodge nights themselves were already correct.

  **Invoices already sent to Xero keep the due date they were issued with.** This
  changes newly created invoices only. Editing an older booking still syncs that
  booking's other changes to Xero as before, but it will no longer move the due
  date of an invoice that has already been issued, so nothing is restated in the
  accounting system.

  **The finance export is different, and worth knowing about before you compare
  two of them.** It recalculates every row each time it runs, including historical
  ones, so the first export taken after this release will show a `created_date`
  one day later for bookings made before about midday New Zealand time — across
  the whole history window, not just recent bookings. That is the corrected day
  rather than a change of figures: no money value, night count or booking status
  moves. Anyone diffing an export from before the release against one from after
  should expect that shift and not read it as data loss.

  This was the booking-created date specifically. Other dates the club sends to
  Xero are derived the same way and are being corrected separately under #2834.
