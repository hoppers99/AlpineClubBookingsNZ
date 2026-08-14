- **Members' dates of birth now reach Xero, and ten records that were a day
  early have been corrected (#2859).** A date of birth typed into a member's
  record was never sent to Xero. The club's Xero contacts keep it in the NZBN
  field, and the app has always read it from there when importing a contact —
  but there was no code anywhere that wrote it back, so a date of birth entered
  here stayed here. It is now sent whenever a member's Xero contact is created
  or updated, in the same `dd/mm/yyyy` form the import already understands.

  Three things it deliberately will not do, because that field is a real
  business-number field and the club's own accounting data lives in it. If a
  member has no date of birth, the field is left exactly as it is rather than
  being emptied — an organisation or school account may hold a genuine number
  there. If the field already holds something the app cannot read as a date, it
  is left alone. And if the app has never seen what the contact holds in that
  field, it sends nothing at all and waits until it has, rather than assuming it
  is empty — a contact matched to a member by email address may well be one
  somebody else created, with a real business number already in it.

  Separately, some dates of birth that came in from Xero had been stored one day
  early. The import read the date against the server's local clock instead of as
  a plain calendar day, which put it on the evening before — every time, not just
  sometimes. **Ten of the 375 members who have a date of birth on file were
  affected.** Each one was checked against the date the member's own Xero contact
  holds, and every one of the ten was exactly a day behind it. The import is
  fixed and a one-off correction has moved those records onto the day the member
  was actually born; records that were already right are untouched.

  **What an administrator will notice.** For those ten members, the date of birth
  shown on the member export, on the data a member can request about themselves,
  and on the family card now reads one day later than it did — and that later day
  is the correct one. Nothing else moves. No change of age tier is expected for
  anybody, and the upgrade checks include a query that confirms it against the
  live data. If your Xero contacts show a date of birth that disagrees with the
  app's, the app's is now the one that wins the next time that member's contact
  is updated.

  Three further records could not be corrected automatically and are listed for
  someone to check by hand: they hold a date that is one day behind their Xero
  contact but carry no trace of how it got there, which is what an administrator
  re-saving an affected record before the fix would leave behind.
