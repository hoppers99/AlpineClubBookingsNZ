- **Members' dates of birth now reach Xero, and the ones already on file have
  been corrected (#2859).** A date of birth typed into a member's record was
  never sent to Xero. The club's Xero contacts keep it in the NZBN field, and
  the app has always read it from there when importing a contact — but there was
  no code anywhere that wrote it back, so a date of birth entered here stayed
  here. It is now sent whenever a member's Xero contact is created or updated,
  in the same `dd/mm/yyyy` form the import already understands.

  Two things it deliberately will not do. If a member has no date of birth, the
  NZBN field is left exactly as it is rather than being emptied — that field is
  a real business-number field, and an organisation or school account may hold a
  genuine number in it. And if the field already holds something that is not a
  date, it is left alone too, so a business number an administrator typed in
  Xero can never be overwritten by a birthday.

  Separately, every date of birth that came in from Xero had been stored one day
  early. The import read the date against the server's local clock instead of a
  plain calendar day, which put it on the evening before — every time, not just
  sometimes. Because almost the whole membership was first brought across from
  Xero, this affected 364 of the 375 members who have a date of birth on file.
  The import is fixed and a one-off correction moves those records onto the day
  the member was actually born. Records that were already right are untouched,
  and one record whose stored value matched neither pattern was deliberately
  left for someone to look at by hand rather than guessed at.

  **What an administrator will notice.** Dates of birth shown on the member
  export, the data a member can request about themselves, and the family card
  read one day later than they did — that later day is the correct one. Nobody's
  age tier changes as a result, and nothing about pricing or hosting
  eligibility moves. If your Xero contacts show a date of birth that disagrees
  with the app's, the app's is now the one that wins the next time that member's
  contact is updated.
