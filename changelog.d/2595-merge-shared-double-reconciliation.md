- **Merging a duplicate member can no longer leave two people sharing a double
  bed without being partners (#2595).** The bed board lets an administrator put
  two people in one double bed for a night, but only when the club has a
  confirmed partner relationship recorded between them. Every other event that
  breaks that relationship already tidied up after itself: ending a partner
  link, deactivating somebody, correcting an adult to a junior age band,
  approving an account deletion, or a seasonal membership change all take the
  second person out of the bed and put that night back on the
  awaiting-allocation list. Merging two duplicate records of the same person did
  not.

  It could happen like this. The duplicate record has a confirmed partner and a
  future night booked in a double bed with them. The record being kept already
  has its own confirmed partner — and the club only ever records one partner per
  person, so the merge has to drop the duplicate's partner link. Until now the
  bed booking stayed exactly as it was, which left the surviving member and
  somebody else's partner down as sharing one double bed on a future night, with
  nothing in the club's records saying they were a couple. Nobody was warned,
  and nothing in the system would have corrected it later.

  A merge now checks every future double bed either of the two records is
  involved in and asks the same question the board asks before it ever allows
  sharing: do these two people actually have a confirmed partner relationship?
  Only the ones that no longer do are undone, and only the second person is
  taken out — the first keeps their bed. The surviving member's own genuine
  partner booking is deliberately left completely alone. Each affected booking
  gets a note in its history, and administrators are emailed afterwards under the
  existing "Booking review required" setting, so the freed night is looked at
  rather than quietly forgotten.

  Nothing changes for a merge that broke no bed sharing, and past nights are
  never touched — they are history.

  Because the merge now touches bed bookings, it briefly holds the bed board for
  the lodges those two records have future nights at — not for the whole club, so
  ordinary payments, cancellations and bed changes at other lodges carry on
  untouched. In the rare case where somebody adds one of the two records to a
  booking at a lodge the merge had not already accounted for, while the merge is
  running, the merge stops and reports that a booking changed and nothing was
  merged; trying again picks the new booking up.
