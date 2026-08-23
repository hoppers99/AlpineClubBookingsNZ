- **This site now knows whether it is the club's live site or a copy of it, and
  it never guesses (#3034).** A copy restored from the live database holds the
  club's real members and their real email addresses, so anything that leaves the
  app — a booking confirmation, a reminder, an invoice into the club's Xero
  organisation — needs to know which installation it is running on first.

  Each deployment now states it outright, in one setting on the server:
  `APP_ENVIRONMENT_ROLE=production` for the club's live site, or
  `non-production` for a staging site, a rehearsal copy or a developer's
  machine. Nothing is inferred from the hostname, the branch, the database it is
  pointed at, or the `NODE_ENV` build mode — every one of those looks identical
  on a copy of the live site, which is exactly the case that matters.

  Where nothing has said, the answer is **"not configured"** rather than either
  one, and that is deliberate: it is not treated as the live site, and it is not
  treated as a copy either. A new **Production Or Non-Production** step on the
  setup checklist reports it, and start-up logs it.

  A Full Administrator can also force any installation to be treated as a copy,
  at **Admin → Setup & Configuration → Environment Safety**. That switch can only
  ever make the answer safer — there is no setting anywhere in the app that can
  declare an installation to be the live site, which is what stops a restored
  copy of the live database from claiming to be one. Turning it off hands the
  decision back to the deployment's own setting rather than promoting the copy.
  Both directions are Full-Administrator-only, need an explicit confirmation, and
  are recorded in the audit log with who did it and the value before and after.

  **Existing live deployments must add that one line before upgrading.** The
  production deploy script now refuses to run without it, at step 3 of 20 —
  before the database migration and long before any traffic moves — so an
  undeclared upgrade stops with the previous release still serving and nothing
  changed, rather than succeeding and quietly holding back member email. Watch
  out for the near-miss: this is `APP_ENVIRONMENT_ROLE`, not the
  `APP_RUNTIME_ROLE` already beside it, which names the container slot and is
  never read for this. `docs/guides/environment-role.md` is the full walkthrough,
  and `docs/UPGRADING.md` has the upgrade step.

  This release records and reports the answer; the parts that act on it — holding
  back email to members, and keeping a copy's invoices out of the club's real
  accounting — follow in #3035 and #3036, so do not yet treat a copy as safe to
  run against real member data.
