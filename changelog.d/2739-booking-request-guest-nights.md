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

  **Nobody's total changed.** The total a requester agreed is still the total
  they owe, split across their nights so it adds back up to the same cent. Where
  an officer set a flat figure, and on every booking repaired by the release, the
  split is the same one the accounting invoice already used behind the scenes, so
  those invoices are unchanged to the cent. Where the price came from the club's
  own rates instead, each night now records the rate that night was actually
  charged at — so a stay crossing a rate change is written down as what it was,
  rather than averaged.

  **Three figures do move, all of them because they were previously wrong.** The
  finance revenue reconciliation now counts booking-request hut fees on the
  club's side of the comparison (it read the per-night records, so these bookings
  contributed nothing against invoices the accounting system already held). A
  member an officer linked to a guest on one of these bookings is now credited
  with the nights they actually stayed. And on a member whole-lodge booking,
  linking one placeholder to a real member no longer re-prices everybody ELSE on
  the booking at today's rates: the rest of the party keeps the price that was
  negotiated with them, which is what the booking-request edit rules were always
  meant to protect. That last one changes what that screen charges, so it is
  called out for the committee rather than buried.

  **For whoever runs the upgrade:** the repair of existing bookings runs before
  the switch-over, so any request approved in the minutes between the two is not
  covered by it — re-run the repair afterwards (it is safe to run twice and does
  nothing where it has already run), or take the deploy with quoting paused. The
  details are in the migration's own header.
