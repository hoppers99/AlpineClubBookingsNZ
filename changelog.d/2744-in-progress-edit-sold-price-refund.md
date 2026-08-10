- **Shortening a booking that has already started now gives back what the member
  actually paid (#2744).** When somebody is taken off a stay part-way through, or
  the check-out is pulled back, the club used to value the nights being given up
  at the rate on today's price list rather than the rate the member was charged
  when they booked. Wherever a rate had changed in between — a season boundary, a
  price rise, a member/non-member change — the refund was wrong, and it could be
  wrong in either direction. After a price rise it handed back more than had ever
  been taken, and a guest who really had slept at the lodge could come off the
  booking showing a negative price.

  Those nights are now credited at the price they were sold at, which is what
  every other kind of edit already did. Nights the guest keeps are untouched:
  extending a stay still charges only for the new nights, and nobody is ever
  re-priced for a night they already bought.

  The per-night prices the club stores against a stay are now each night's real
  rate as well. An edit spanning a rate change used to store the average across
  the stay — four nights of $50, $50, $90, $90 stored as $70 each — which then
  became what the next edit believed had been paid. Totals always added up, so no
  invoice was ever out of balance, but the night-by-night record was not the
  price list. It is now.

  Two situations still fall back to the old behaviour, and they are the ones
  where there is genuinely nothing to recover: a booking old enough to have no
  per-night record at all, and one whose stored per-night prices no longer add up
  to its stored total. In both, the nights are valued at today's rate and the
  total is spread evenly, exactly as before.

  **Nothing already charged, refunded or invoiced is recalculated.** This changes
  edits made from here on. Whether the club does anything about bookings edited
  under the old arithmetic is a separate decision, tracked on #2745.
