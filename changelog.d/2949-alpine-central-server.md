- **Your club can now connect to the Alpine Central Server and keep its "Other
  Clubs" details in step with every other club automatically (#2949).** Until now the
  Other Clubs registry was a purely local list: someone had to type in each
  partner club's booking officer, phone number and bed count, and re-type them
  whenever a club changed its details.

  An administrator connects the club from **Admin → Integrations → Alpine
  Central Server**: turn the module on, enter the central server address and the
  API key the central server issued you, and enable the Other Clubs share. The
  API key is stored encrypted alongside the club's other integration secrets and
  is never shown again or included in any log or audit record.

  Once connected, a nightly job at 3am syncs in both directions. It sends up
  only the entries this club has edited since the last run, and pulls back only
  the entries the central server has changed since the last run, so a quiet
  night costs almost nothing and never overwrites an untouched row. A downloaded
  entry that already matches what you hold is left alone entirely, so it does
  not appear as recently changed. Nothing is sent anywhere until an
  administrator both connects the server and enables the share.

- **The club's own booking officer contact now follows the committee roster
  instead of being maintained by hand (#2949).** Assigning a member to the Booking
  Officer committee role — or removing them — immediately refreshes the booking
  officer name and phone number on the club's own entries in the Other Clubs
  registry, which is what partner clubs see once the central-server share is on.

  The name and phone come from the assigned member, but the email address comes
  from the committee **role's** shared contact address (for example
  `bookings@yourclub.nz`) rather than the member's personal address, so a change
  of officer never publishes a personal inbox. When nobody currently holds the
  role, the contact fields are cleared rather than left showing whoever held it
  last. If a club has renamed the role, it is still recognised.

  A member's phone number is shared only if your club already publishes it on
  your own committee page — the sync honours the same "published" and "show
  phone" settings that page does, so nothing appears nationally that was
  deliberately withheld locally. Turning the module off in **Admin → Feature
  modules** stops the nightly sync entirely.
