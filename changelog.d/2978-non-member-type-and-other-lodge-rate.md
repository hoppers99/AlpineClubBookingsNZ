- **The members list now says "Non-Member" instead of "Unassigned" (#2978).**
  Booking on behalf of a non-member creates a person record, and on
  Members that row's Type – Tier column read *Unassigned – Adult* — which looks
  like a member whose membership type nobody has got round to setting. Nothing
  was missing: a non-member has no membership type and never will. Those rows now
  read *Non-Member – Adult*, from the same rule that decides what they are
  charged, and school contacts read *School*. Members who genuinely have no type
  assigned still read *Unassigned*, and the Membership Type filter's
  **Unassigned** option is unchanged.

- **"Member of Other Lodge" now offers a tick box to everyone on the non-member
  rate, not just to non-members (#2978).** The reciprocal rate lets a booking
  officer charge a visiting club's member your own member rate. It only ever
  offered the tick to people marked as non-members — but somebody added to a
  booking from your own people list can be on the non-member rate too, most often
  a non-member contact created by an earlier booking. They showed as a member,
  paid the non-member rate, and had no tick box, so the one arrangement the
  feature exists for could not be applied to them. Now the tick follows the rate.

  Two groups still get no tick box, both because there is no non-member rate
  there to replace: somebody already on your member rate, and a member whose
  unpaid subscription has moved them onto non-member rates. The second is
  deliberate — ticking them would restore the member rate and quietly cancel the
  lockout your club configured.

  Nothing changes for bookings already taken, and the tick still changes the
  price and nothing else.
