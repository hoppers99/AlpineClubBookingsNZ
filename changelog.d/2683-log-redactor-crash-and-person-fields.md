- **The application no longer stops responding when it tries to log a record
  that refers back to itself, and members' names and addresses stay out of the
  logs (#2683).** Everything written to a log or sent to the error-reporting
  service passes through a filter that strips out secrets and personal details
  first. That filter walked a record's linked information without any limit, so
  a member linked to a family group that lists the member again sent it round in
  circles until the server gave up — and because it happens while something is
  being logged, it usually struck when the site was already reporting a problem.

  The filter now stops after six levels, recognises when it has come back to
  where it started, and marks the point plainly in the log rather than dropping
  the rest silently, so the surrounding detail an administrator needs is still
  there. It also no longer has any way to fail while it is running: a record it
  cannot read is marked as unreadable instead of bringing the server down, which
  was the whole point of the change.

  Two further problems in the same area are fixed. A record that referred to the
  same piece of information from several places could produce a log entry of
  several megabytes from a handful of items, which is now bounded. And error
  reports were losing the very things that explain them — the underlying cause,
  the database error code, and the file trace, which was being discarded
  wholesale whenever it mentioned a package name containing an "@".

  On personal details, the filter now removes first, last, middle and given
  names, the combined "full name" spellings that various screens produce,
  street and postal addresses, town, region and country, date of birth, gender
  and occupation. It also removes stored password hashes and two-factor
  secrets, which it had been letting through. Web address parameters are now
  checked against the same list, so a member's name or email address in a link
  is removed rather than only login tokens being removed.

  Six places that were handing whole records to the log — the Xero member
  import, the two family-group screens, the webhook recorder, a family request
  for a child, and the nightly hut-leader job — now log reference numbers and
  counts instead. The Xero contact records the system keeps for its own history
  no longer store a member's name, although the request sent to Xero still
  carries it, because Xero requires it.

  The admin-action audit trail is deliberately different and is unchanged: an
  audit record still shows a member's name and street address, so that "who did
  what to whom" stays readable to the officer reviewing it. Reading that trail
  needs the audit permission and the records are kept under the usual retention
  rules.

  Nothing an administrator sees in the application changed, except that the Xero
  operations panel now labels a contact-group sync with the member's reference
  number rather than their name.
