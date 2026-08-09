- **AI Diagnostics can now investigate one selected booking or member with
  permission-matched, read-only evidence (#2376).** Booking Officers can find a
  booking and inspect its stored state, party, links, requests, audit history,
  blockers and night-by-night capacity. Membership Officers can find a member and
  inspect their stored state, subscriptions, family links, booking involvement,
  audit history and current eligibility. Neither role needs Support & System access.

  Three tools cross that boundary deliberately and require both Bookings and
  Membership view access: a member's booking summary, a booking's blocker state,
  and the double-bed sharing verdict. The last one reads the live membership state
  and confirmed partner link for both occupants, and the other occupant can belong
  to another booking. Those cross-booking identifiers are classifier inputs only
  and are never returned; a caller missing either permission is denied before any
  membership row or partner link is queried.

  Booking blockers now use the platform's canonical persisted hosting evaluation,
  shared with the booking lifecycle rather than recreated from a proposed party.
  That preserves sparse guest nights, accepted-consent attendance, split
  parent/child coverage, subscription settlement and current-booking exclusion. A
  pending-consent adult cannot host, a split parent's adult can cover the child
  booking, and a booking cannot use itself as same-owner cover.

  Date and capacity evidence now fails closed around corrupt legacy data. Guest
  stays remain half-open: `stayStart` is the first occupied night and `stayEnd` is
  the exclusive departure day, so equal endpoints contain zero nights and are
  refused instead of becoming a fabricated one-night stay. Allocation counts read
  only the selected booking's own guests inside `[checkIn, checkOut)`, stop at the
  30-guests × 31-nights ceiling plus one, and refuse an oversized population rather
  than clipping it. PostgreSQL enforces read-only mode and a five-second statement
  timeout for that bounded query; the outer JavaScript deadline is not treated as
  database cancellation.

  Whole-lodge evidence now separates current effect from historical storage. A
  booking is reported as effectively holding the lodge only when its raw flag is
  set and its canonical lifecycle state still holds capacity. Cancelled, bumped,
  deleted and otherwise non-capacity-holding records can still show the raw flag,
  but never claim an active exclusive hold.

  Member eligibility now reads the persisted financial-year settings strictly. A
  genuinely absent singleton still uses the documented default; a rejected
  database read becomes `evidence_unavailable` instead of being mistaken for proof
  that March applies. Diagnostics still never calls Xero to fill a missing fact.

  Mobile search now normalises the stored country, area and number fragments as
  well as the operator's input, so legacy `+`, spaces, hyphens and parentheses can
  match. It uses one fixed PostgreSQL punctuation translation rather than wildcard
  or regular-expression language, and no tool returns the phone number.

  Operators must re-run `npm run diagnostics:provision-role` after deployment. The
  allowlist is still exactly 26 relations and 243 columns, including 23 on
  `Member`; the deployment guide now publishes every exact relation-column set and
  a test compares those sets with the source declaration in both directions, so a
  same-count column swap fails. Provisioning copy also states honestly that email
  is projected once while all three phone fragments are predicate-only.

  The opt-in real-PostgreSQL privilege proof now exercises the punctuated stored
  mobile case and fails closed during teardown: it closes restricted connections,
  terminates remaining sessions, revokes role memberships, drops owned privileges,
  drops every known-password test role and verifies that each role is absent. The
  suite remains off in ordinary local tests and runs only against the dedicated
  loopback scratch database in its hosted proof job.

  Diagnostics remains dormant until its assistant surface ships. Nothing in this
  pack can create, change, cancel, confirm, approve, refuse, allocate, move,
  complete, sign off, link, unlink or release anything, and it contacts no external
  provider. Stored text remains untrusted evidence, and invocation audit records
  contain metadata and non-reversible hashes rather than arguments, results,
  questions or answers.
