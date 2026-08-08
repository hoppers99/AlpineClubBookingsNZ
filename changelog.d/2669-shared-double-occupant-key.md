- **Automatic bed allocation can no longer put someone into a double bed that
  is already occupied (#2656).** When two people share a double — the partner
  arrangement an admin sets up on the allocation board — the planner was only
  keeping track of one of them. If it then moved one of those two bookings aside
  to make room for a confirmed booking, it treated the whole bed as empty even
  though the other person was still in it.

  Depending on which of the pair happened to be recorded first, one of two
  things followed. Either the new allocation was quietly dropped, so a
  provisional booking had been moved out of its bed for nothing and the
  confirmed guest was left without a bed and without appearing in the
  awaiting-allocation list. Or the new allocation went through, and an unrelated
  guest was placed into the double alongside somebody else's partner — the exact
  arrangement the partner rules exist to prevent, with no admin involved.

  The planner now tracks each occupant of a bed separately from the bed itself.
  A bed only becomes free when the last person in it leaves; moving one occupant
  of a shared double aside frees no beds and no longer counts toward making a
  room look big enough; a double counts as one freed bed once both occupants
  have gone; and a bed shared between two different bookings is never chosen as
  somewhere to move a booking out of. A confirmed guest who genuinely cannot be
  seated is now reported as awaiting allocation instead of disappearing.

  Two related repairs ship with it. If automatic allocation moves or removes the
  first occupant of a shared double, the remaining partner is promoted to the
  main place on that bed, as already happens everywhere else a shared double
  loses its primary — previously this one path left the bed stuck. And the write
  step now refuses outright to place a guest on a bed the database still shows
  as occupied, rather than relying on a database constraint to notice.

  Nothing about how beds are counted, priced, or shown has changed, and no
  existing allocation is rewritten. Where the planner used to make a wrong
  placement it now leaves the guest-night for an officer to place by hand.
