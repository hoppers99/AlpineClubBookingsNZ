- **The group discount now actually reaches the nights an edit buys — including
  on a stay that has already started (#2756).** At a club that has switched the
  group discount on, two things were wrong and they compounded.

  First, **no edit of any kind applied the discount if the club had left it
  restricted to summer**, which is the default setting. The season information
  handed to pricing on every edit path was missing the field that says whether a
  season is summer, so the summer test could never pass. A booking was discounted
  when it was made and then priced at the full rate by any later change —
  extending the check-out, adding a person, changing the dates, removing somebody.
  Clubs on the default setting will now see the discount applied to nights an edit
  buys, on every one of those paths. **That is a price change to ordinary edits,
  not only to edits of stays already under way**, and it is the behaviour the
  setting always described.

  Second, an edit to a stay that had **already started** priced each guest on
  their own, so the discount saw a party of one and could never qualify however
  many people were in the lodge. Adding a person or extending the check-out
  charged the full rate whenever the stay had begun, while exactly the same change
  to a booking starting tomorrow got the discount — same club, same night, same
  party, two prices depending on the day of the edit, and the difference ran
  against the member. The whole party is now priced together, so the discount sees
  how many people will actually be in the lodge on each night. Eligibility is
  still counted per night: somebody who has already gone home does not make up the
  minimum for a night they are not there for.

  **Nights already paid for do not move.** A night a guest keeps costs them what
  it cost them before the edit, whether or not the party has just grown or shrunk
  past the discount's minimum size. A night given back is credited at the price
  recorded against it, discount included — that is what makes a removal return
  exactly what the club charged. Where a booking has no record of what a night
  cost (a booking made before the club kept per-night prices, or one created by
  approving a request), the credit is worked out at that guest's own rate rather
  than at the discounted one, so the member is not handed back less than they
  paid; as before, it can never exceed what the booking is carrying.

  Clubs that have not switched the group discount on will see no change of any
  kind.

  Nothing already charged, refunded or invoiced is recalculated. Bookings edited
  before this release keep the prices they were given; putting anything right for
  a member who was charged the undiscounted rate is a separate, audited
  adjustment. The admin switch for whether later edits receive the discount at all
  is a separate change and is not in this release — edit-time discounting is on for
  any club whose discount is enabled, which is that switch's intended default.
