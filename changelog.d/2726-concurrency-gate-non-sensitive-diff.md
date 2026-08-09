- **Automated dependency-update pull requests no longer fail their checks for a
  missing form section (#2726).** The check that asks a pull request to declare
  its concurrency and locking impact demanded that section from every pull
  request, and only afterwards looked at what the pull request had actually
  changed — at which point it accepted "not applicable" from anything that
  touched none of the sensitive areas. So it already agreed those pull requests
  had nothing to declare; it simply refused to say so until somebody pasted the
  heading in by hand.

  Dependabot writes its own pull request description and cannot use this
  repository's template, so every one of its pull requests failed there
  permanently and had to be rewritten by hand and re-run.

  The check now skips the section when the change touches no sensitive area, the
  same way the changelog check already skips pull requests that change no
  application code. Nothing that must produce a real declaration changed:
  anything touching bookings, capacity, payments, refunds, credits, settlement,
  the waitlist, webhooks, cron jobs, Xero, Stripe, membership, member lifecycle
  or the database schema still fails loudly without one. The rule keys off what
  the change touches, never off who opened it, so an automated pull request that
  bumps a payments or database dependency is held to exactly the same standard as
  a human's.
