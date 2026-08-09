- **The application no longer stops responding when it tries to log a record
  that refers back to itself, and members' names and addresses stay out of the
  logs (#2683).** Everything written to a log or sent to the error-reporting
  service passes through a filter that strips out secrets and personal details
  first. That filter walked a record's linked information without any limit, so
  a member linked to a family group that lists the member again sent it round in
  circles until the server gave up — and because it happens while something is
  being logged, it usually struck when the site was already reporting a problem.

  The filter now stops after six levels and recognises when it has come back to
  where it started, marking the point plainly in the log rather than dropping
  the rest silently, so the surrounding detail an administrator needs is still
  there.

  It also now removes first and last names, street and postal addresses, date of
  birth, gender and occupation. Those were being written out in full where a
  member record reached a log line. The one deliberate exception is the
  admin-action audit trail: an audit record still shows a first name, so that
  "who did what to whom" stays readable to the officer reviewing it. Reading
  that trail needs the audit permission and the records are kept under the usual
  retention rules.

  Four places that were handing whole records to the log — the Xero member
  import, the two family-group screens and the webhook recorder — now log
  reference numbers and counts instead. Nothing an administrator sees in the
  application changed; the Xero operations panel and the audit screens still
  show the names they always did.
