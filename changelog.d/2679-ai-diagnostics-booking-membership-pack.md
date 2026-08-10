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
  than clipping it.

  Every authoritative answer is now bounded by PostgreSQL itself, not only by a
  JavaScript timer. The blocker state, the per-night capacity read and the member
  eligibility read each run their whole read graph inside one read-only transaction
  with a five-second statement timeout, and the transaction is passed to every
  collaborator they call. A JavaScript deadline only stops waiting: it cannot cancel
  a query, so a slow read used to keep running against the database after the
  operator had already been told the evidence was unavailable. That transaction is
  opened at repeatable-read isolation, which is what makes every fact in a row come
  from one committed instant — inside an ordinary transaction PostgreSQL still takes
  a fresh read of the data for each statement, so a row could otherwise pair a party
  counted at one moment with the lodge's occupancy counted at another. Each row still
  says plainly that being consistent is not the same as being current. The widest read —
  the sibling bookings that can supply hosting cover — gets a deterministic ceiling
  for diagnostics and refuses rather than returning a short list; the booking
  lifecycle's own evaluation is unchanged and still reads every sibling.

  A deleted booking now reports its deletion once. A booking can only be deleted
  after it is cancelled, so the blocker list used to carry both facts and send an
  operator to two screens when only one has a next step.

  Membership seasons are resolved from stored settings rather than from whatever the
  process happens to have cached. The paid-up-adult rule and the hosting
  subscription bridge are handed the season the booking's own check-in night falls
  in, so a club whose financial year does not end in March is no longer judged
  against another season's subscription rows. Where the club follows Xero for its
  financial year and the month is stored nowhere local, the answer is
  `evidence_unavailable` with the remedy named, never a guess.

  Two settings reads that qualify every subscription finding — the age-tier rule and
  the club's lockout mode — are now read strictly for evidence. A genuinely absent
  row still means the documented default applies; a failed read becomes
  `evidence_unavailable` instead of a confident answer nobody observed. Ordinary
  booking screens keep their existing fallbacks unchanged.

  An erased account is now identified by the marker an approved deletion writes, not
  by the shape of an inactive record. Ordinary bulk deactivation is reversible and
  leaves the same shape, so both member search and the member summary used to report
  every deactivated member as possibly erased. The address stays a predicate and is
  never returned by a search.

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
  contain metadata rather than arguments, results, questions or answers. The two
  searches record no argument digest where the term could be guessed: a name prefix,
  a mobile fragment, an email address, an eight-character booking reference and a
  lodge night with a closed window all have too little entropy for a hash to be
  one-way, so the tool, the outcome and the timing are recorded and the digest is
  omitted. Record-id searches keep their digest, because a cuid cannot be walked and
  "the same officer looked this record up twice" is a real audit question.
