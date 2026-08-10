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

  **Nobody can now come off a booking owing less than nothing.** Two situations
  still have nothing per-night to recover, and they are not both what you would
  guess:

  - A booking with **no per-night record at all**. That is not only old
    bookings: every booking created by approving a booking request — including a
    member whole-lodge booking sold at a negotiated flat price — still gets none
    today (#2739). Those nights are valued at today's rate, as before. What is
    new is a ceiling: the club can never give back more than the guest is
    actually carrying, so a guest taken off after a price rise lands at worst on
    nothing owing, instead of finishing with a negative price the next edit then
    treats as what they paid. For a whole-lodge booking sold at a flat price this
    is a floor under the error, not a cure — the season table still bears no
    relation to the price agreed. Whether #2739 has to land before this counts as
    fixed for those bookings is noted on #2744.
  - A booking whose stored per-night prices **no longer add up to its stored
    total**. Here the nights given back are still credited at the prices those
    rows record — the money is right. Only the per-night figures written back are
    spread evenly, because a night-by-night breakdown built from numbers that
    disagree with each other would be a guess.

  A stored per-night price that is **negative** — which the old arithmetic could
  write on a booking it had already got wrong — is no longer treated as a real
  price. Left alone it would have inverted the sums, so that taking a guest off
  the booking billed them instead of refunding them.

  **Nothing already charged, refunded or invoiced is recalculated**, and no
  existing record is rewritten — including the negative ones. This changes edits
  made from here on. Whether the club does anything about bookings edited under
  the old arithmetic is a separate decision, tracked on #2745.

  One thing this does **not** change: a stay that has already started is priced
  one guest at a time, so nights bought by an in-progress edit never get the
  club's group discount, where the same nights bought before the stay began
  would. That is long-standing rather than new, it only affects clubs that have
  switched the discount on, and it is now written down and carried as its own
  decision on #2756.
