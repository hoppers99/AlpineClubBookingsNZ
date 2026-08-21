- **The members list now says "Non-Member" instead of "Unassigned" (#2978).**
  Booking on behalf of a non-member creates a person record, and on
  Members that row's Type – Tier column read *Unassigned – Adult* — which looks
  like a member whose membership type nobody has got round to setting. Nothing
  was missing: a non-member has no membership type and never will. Those rows now
  read *Non-Member – Adult*, from the same rule that decides what they are
  charged, and school contacts read *School*. If your club has renamed either of
  those types, the column shows your club's own word for it. The person's own
  record agrees: it used to say *None* and *No seasonal type set* on the same
  people. Members who genuinely have no type assigned still read *Unassigned*,
  and the Membership Type filter is unchanged — it now carries a line saying
  where to find these rows, because they are still listed under **Unassigned**.

- **"Member of Other Lodge" now offers a tick box to everyone on the non-member
  rate, not just to non-members (#2978).** The reciprocal rate lets a booking
  officer charge a visiting club's member your own member rate. It only ever
  offered the tick to people marked as non-members — but somebody added to a
  booking with **+ Add Member Guest** can be on the non-member rate too, most
  often a non-member contact created by an earlier booking. They showed as a
  member, paid the non-member rate, and had no tick box, so the one arrangement
  the feature exists for could not be applied to them. Now the tick follows the
  rate.

  **Two groups still get no tick box, for two different reasons.** Somebody
  already on your member rate has nothing to replace. And somebody whose
  subscription is unpaid is withheld deliberately: handing them your member rate
  is the one thing an unpaid subscription is supposed to cost them. That second
  rule holds whichever setting your club uses for unpaid subscriptions — it turns
  on the subscription being owed, not on what the club has chosen to do about it
  — and it covers the awkward case on purpose, where somebody has let your
  subscription lapse while being paid up at the partner lodge. Otherwise anybody
  could lapse, name a partner lodge, and keep your member rate for good. The
  Guests card now says all this on screen, so a missing tick box reads as a rule
  rather than a fault.

  Nothing changes for bookings already taken, and the tick still changes the
  price and nothing else.
