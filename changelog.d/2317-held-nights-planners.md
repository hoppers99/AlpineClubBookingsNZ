- **Beds are no longer allocated automatically on nights a group has taken the
  whole lodge (#2317).** When a booking holds the whole lodge for a night, that
  group really is sleeping in every bed — but the bed-allocation planners could
  not see it, because a held booking is deliberately never placed on individual
  beds. Auto-allocation, and the automatic placement that runs whenever a
  booking changes, could therefore put another booking's guest into a bed the
  held group was using, with nothing to warn you.

  Both now count every bed as taken for the nights of a whole-lodge hold. Any
  overlapping booking's guests simply stay in the awaiting-allocation list for
  those nights. The hold keeps its own banner above the board and the
  overlapping booking keeps its **Overlaps exclusive hold** warning, which
  together tell you which nights are taken and which booking is clashing. The
  bed grid itself is unchanged: a held night's beds are still drawn like empty
  ones, and the held group is never named on them.

  You will see more red on the board for a situation you have already been told
  about: a booking overlapping a hold is never refused when it is made, and the
  clash is shown to you when the hold is set. That is the intended trade —
  the clash is now visible in the allocation list instead of hidden inside a
  placement nobody chose. **Placing a guest by hand is unchanged**: drag,
  **Select bed** and **Assign range…** all still work on those nights, so if
  you have agreed something with the group you can still record it. The system
  simply stops making that decision for you.

  Whether a hold blocks is judged exactly as the lodge's capacity rules judge
  it, so a hold left on a booking that no longer reserves the lodge blocks
  nothing here either.
