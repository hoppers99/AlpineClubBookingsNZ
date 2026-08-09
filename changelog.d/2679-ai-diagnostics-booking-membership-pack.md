- AI Diagnostics can now investigate a specific booking or member. An administrator
  with **Bookings** view access can look up a booking — by its id, by the
  eight-character reference a member reads off their confirmation, by the member who
  owns it, or by a lodge and a short run of nights — and then ask what is actually
  stopping it. An administrator with **Membership** view access can look up a member
  by record id, exact email address, the start of a name, or a mobile number, and
  then ask why that member is blocked or being charged non-member rates. Neither
  needs Support & System access to do it.
- The answers come from the platform's own rules rather than from a second reading of
  the rows. The blocking answer runs the same minimum-stay, adult-member-hosting and
  paid-up-adult-member evaluator a member's own exception request runs through, the
  same review-reason derivation the officer queue renders, the same per-night
  capacity engine every booking path checks against — so its occupancy figures
  already include custodian bed holds and beds held by pending exception requests,
  neither of which has a booking to show for it — the same member-night conflict
  scan, and the same edit-window rule the member's own Edit button obeys. The
  membership answer runs the platform's own lifecycle resolver, membership-type
  resolution, subscription-settlement rule, lockout mode and adult-member-host
  predicate.
- Diagnostics stays completely read only. It cannot create, change, cancel, confirm,
  approve, refuse, allocate, move, complete, sign off or release anything, it
  contacts no external provider, and every tool description tells the assistant so —
  because an officer who believes an exception has already been approved does not
  approve it, and the member's held beds are then released by the hold reaper.
- Three things the assistant will now say plainly rather than guessing at. A
  **cancelled, bumped or deleted booking** reports only that fact: no policy failure,
  no capacity shortfall and no review is reported against it, because a booking that
  is over is not a booking that is broken. An **outstanding induction** is reported as
  a flag and explicitly not as a booking blocker, because nothing in the booking path
  reads it in this release. And there is **no member number** in this platform, so a
  member quoting one is quoting something else — the assistant says so instead of
  searching for a field that does not exist.
- An exclusive whole-lodge hold is now kept distinct from an ordinary capacity
  shortfall: Diagnostics reports the hard `whole_lodge_held` reason, withholds
  derived spare-bed arithmetic for that night, and never suggests an admin
  over-capacity confirmation could bypass it.
- A selected parent booking now shows its directly linked child bookings within a
  fixed limit. Party consent evidence uses the platform's complete legal-state
  discriminator, and double-bed allocations report whether two occupants satisfy
  the authoritative rule: distinct active adult members with a confirmed partner
  link. Missing, pending and corrupt states remain explicit rather than inferred.
- A search deliberately tells an administrator less than a record does. A member
  search returns names, age tier and lifecycle state, and only *whether* an email
  address and a phone number are on file; the address itself comes back for one
  selected member, and the phone number is never returned at all. Booking notes,
  admin review notes, a member's message to an officer, an officer's private notes, a
  member's private comments, dates of birth, addresses, and every credential and
  two-factor column stay unreadable to the diagnostics database credential — the
  database itself refuses them, not just the code.
- **Operators: this release needs `npm run diagnostics:provision-role` re-run after
  deploy.** It adds relation grants for the booking and membership tables, and until
  provisioning is re-run the diagnostics readiness check reports the credential as
  under-provisioned and every database-backed diagnostics tool refuses by design. That
  re-provisioning is the **only** change this release makes to a running system:
  there is no AI Diagnostics screen yet, nothing calls a diagnostics tool, and every
  entry described above is dormant until the assistant surface ships.
- **Seven columns were also removed from what the diagnostics database credential can
  read**, tightening a boundary this release did not widen. All seven belong to the
  earlier finance release and no diagnostic query ever read one; two of them — a link
  from a refund task to its booking, and the same link on a payment recovery record —
  were harmless only while booking tables were unreadable, and this release makes
  booking tables readable. The check that should have found them had been written but
  never wired up to anything, so it could not fail; it is wired up now, and it
  reconciles what the credential may read against what the queries actually read in
  both directions. PostgreSQL is asked the same question independently, on a real
  database, against the role the shipped provisioning creates: this credential may
  read a column **if and only if** one of the product's own queries reads it.
