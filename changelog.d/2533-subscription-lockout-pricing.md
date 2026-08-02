- **A member whose subscription is unpaid is now told, at booking time, that
  member rates are unavailable until they renew (#2533).** The owner has decided
  that the subscription lockout should eventually stop blocking these members
  outright and instead charge them non-member rates — letting a
  subscription-locked member still book for their family, charging any unpaid
  individual on the booking non-member rates, and requiring at least one paid-up
  adult member on every booking. This release lands the reviewed rule as a pure,
  tested policy (reusing the #2364 adult-member-hosting predicate so the two
  never drift) and the first member-facing piece of it: the member's subscription
  status now carries a plain-English notice explaining that member rates are
  unavailable while the subscription is unpaid, worded so it is accurate under
  today's hard-block lockout as well.

  Nothing about booking prices or the hard block changes yet: an unpaid member is
  still blocked exactly as before. Turning the block into "charge non-member rates
  and require a paid-up adult" is a money-regime change that needs an owner
  decision on rollout (all clubs or opt-in, how unpaid members count toward
  capacity, and the Xero invoice wording), tracked as a follow-up.
