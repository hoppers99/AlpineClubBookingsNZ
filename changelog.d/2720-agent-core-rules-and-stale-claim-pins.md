- **The repository now says in one place that it is a generic product rather
  than one club's site, and checks the claims that used to go stale quietly
  (#2720).** The always-read agent guidance states that each deployment serves
  exactly one club while the codebase must never encode which club, and gives
  the test to apply before asking for a deployment-specific value: would a
  different club answer this differently? If so it belongs on a module toggle, a
  setting or a seed default. `INV-CONFIG-001` records the durable half — a
  club-varying value gets a configuration surface, an upgrade that adds a
  setting falls back to a documented default instead of failing, and where an
  operator has to act the unconfigured state is visible.

  Three documentation claims that nothing verified are now either measured or
  mechanically pinned: the invariant index's ten original section headings
  (renaming one silently breaks links held outside this repository, so the
  check now refuses), the count of admin surfaces that keep the older view-only
  notice, and the list of provider credentials an auth-secret rotation strands —
  which the deployment runbook understated at two providers when there are six.
  The rotation runbook now points at the single security-documentation list
  rather than maintaining a second copy of it.

  Two config-transfer architecture decisions that shipped long ago still read as
  proposals and now record their real status.

  This changes contributor and operator documentation only; it does not change
  booking, payment, membership, lodge or deployment behaviour.
