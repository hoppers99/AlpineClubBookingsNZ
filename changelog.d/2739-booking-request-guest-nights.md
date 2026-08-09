- **School and public-request parties now appear on the bed-allocation board
  (#2739).** A booking created by approving a booking request — and the capacity
  hold taken while quoting one — carried no per-night record for its guests, so
  the board did not list them, the auto-allocator never placed them, and the
  dashboard's Bed Allocation card did not count them as awaiting a bed. They
  were real people on a confirmed booking, and an officer found out when the
  group arrived.

  Every booking-request path now writes those per-night records at the moment it
  creates the guests, over exactly the nights of the approved stay. Bookings
  already approved were repaired in the same release, so a request approved
  months ago is on the board now too; cancelled and deleted bookings were left
  alone.

  **No money moved and no price changed.** The total a requester agreed is still
  the total they owe, split across their nights so it adds back up to the same
  cent, and their accounting invoice is unchanged — the same line items, to the
  cent, as before this release. Two figures do move because they were previously
  short: the finance revenue reconciliation now counts booking-request hut fees
  on the club's side of the comparison (it read the per-night records, so these
  bookings contributed nothing against invoices the accounting system already
  held), and a member an officer linked to a guest on one of these bookings is
  now credited with the nights they actually stayed.
