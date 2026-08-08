- **Merging two member records now holds the right lodges, including lodges the
  duplicate only ever stayed at in the past (#2672).** When a merge drops a
  duplicate's confirmed partnership, it has to tidy up any future double bed the
  two of them were sharing on the strength of it. To do that without freezing
  the whole club for the length of a merge, the merge locks only the lodges that
  could be affected — and it worked out which lodges those were by asking where
  either person had a *future* night booked.

  Stay dates can be changed while a merge is running. An officer shifting a
  finished booking's dates forward, or extending an in-progress booking's
  check-out, could pull one of the two people onto a future night at a lodge the
  merge had already written off as irrelevant — and the merge held nothing there
  to stop a bed being handed out. In the worst case the merge could finish with
  two people sharing a double bed at that lodge with no partnership behind it.
  We reproduced that end to end against a real database before fixing it.

  The merge now asks a question that cannot go stale: *which lodges has either
  person ever had a booking at?* Dates no longer come into it, so a date change
  can no longer move a lodge in or out of the answer, and the officer making
  that change simply waits for the merge instead of slipping past it. Just
  before it tidies the beds, the merge also re-checks that no new booking has
  appeared at some further lodge; if one has, the whole merge is refused with
  "a lodge booking for one of these members changed while the merge was running
  — nothing was merged, please try again", and a retry picks the new lodge up.

  What an operator may notice: on a club with several lodges, a merge involving
  a long-standing member can now hold more lodges at once, so a booking edit at
  one of those lodges may briefly wait or ask to be retried while the merge
  finishes. Nothing is ever half-saved — a refused edit or a refused merge rolls
  back completely.
