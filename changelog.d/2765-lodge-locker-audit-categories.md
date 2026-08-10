- **No audit rows move between Audit Log tabs, and the reason chore, locker,
  work-party and lodge records stay under "Admin" is now written down (#2765).**
  Changes an officer makes to chore templates, lockers, work parties, lodge
  instructions, lodge settings and the lodge records themselves keep appearing
  under the **Admin** category, exactly as they do today — nothing moves to
  **Lodge**, nothing is withdrawn from anyone, and no row's retention date
  changes. Every one of these events also stays where it is for the AI
  Diagnostics correlation tools, so an operator reading a lodge-operations
  question still gets the same "these are filed under Admin" note rather than an
  empty answer that looks like nothing happened.

  Two earlier releases moved twenty-two bed-allocation events and the lodge
  display configuration to **Lodge**, and this group looked like it should follow.
  It does not, and the club-facing reason is worth stating: those events were
  being filed in two different places depending on which screen an officer used,
  so somebody looking at one place saw half the story. This group has always been
  filed in one place, so moving it would fix nothing while taking the events out
  of reach of an officer who has support access but no lodge access.

  Lockers were reviewed on their own, because a locker belongs to a named member
  while sitting in a building, and the locker screens require Membership access
  rather than Lodge access. Filing them where a Membership Officer would look for
  them turned out to mean filing them somewhere **members can read**: every locker
  change would have appeared on the activity page of the **officer who made it** —
  officers are members too — while the member the locker is allocated to would
  still have seen nothing. So lockers stay under Admin, and the choice goes back to
  the club as its own decision (#2777) rather than being made in passing. Nothing
  an operator does changes; the record of why simply exists now, and a future
  change of mind will fail the build unless it is deliberate.
