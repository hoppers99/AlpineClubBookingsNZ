- **The price a member is shown before saving a booking change is now worked out
  by exactly the same code that saves it (#2563).** Nothing about the answer
  changes: the fix is that there is no longer a second copy that could drift.

  When a member or an administrator edits a booking, the screen first asks the
  system for a preview — the new dates, who is staying which nights, whether the
  lodge has room, and what the change costs. Saving then asks a different part of
  the system to do the real work. Both had to answer the question "given these
  requested changes, who ends up staying which nights?", and until now both
  answered it with their own copy of the rules. The copies agreed, but only
  because somebody had checked them side by side; the last time two copies of this
  same rule were left to agree by inspection, one of them showed an approver a
  three-guest, three-night party while the system went on to book a different
  party at a different price.

  The preview now asks the one authoritative piece of code, the same one used when
  the change is saved and when a policy exception is frozen for an officer to
  review. Its own copy — including the way it worked out the overall booking dates
  and each guest's arrival and departure — has been removed outright rather than
  kept behind tests. The preview keeps only the wording of its refusals, which is
  unchanged: a guest range with a start but no end is still refused with the same
  sentence and the same guest number the member saw before, and the same sentence
  the save would use.

  For any edit that the two used to agree on, everything is identical: the same
  dates, the same guest nights, the same capacity and minimum-stay outcomes, the
  same quoted total to the cent, the same validation messages and error codes. A
  preview still changes nothing in the database. What is new is a test suite that
  drives all three surfaces — the preview a member reads, the save that writes the
  booking, and the party an officer approves — over the same twenty-three kinds of
  change and ten kinds of invalid input, and requires all three to agree before
  the code can ship. Each of those changes also has a written-down expected
  answer — the dates, who stays which nights, and the total — so a future change
  to the rule itself has to be a deliberate one, and a booking that is already
  under way is covered as well as one still in the future.
