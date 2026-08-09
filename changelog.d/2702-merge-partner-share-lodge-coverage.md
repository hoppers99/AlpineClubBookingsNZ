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
  to stop a bed being handed out. Against a real database we confirmed that half:
  an officer's date change on a finished booking slipped past a running merge
  with nothing making it wait. The further step — someone then being hand-placed
  into a double bed beside a partner the merge is about to take away — we could
  not make happen, because that hand placement queues behind a club-wide bed key
  the date change is already holding. So this is a gap in what the merge covers
  rather than a fault anyone has been able to trigger, and we have closed it as
  the former.

  The merge now asks a question that cannot go stale: *which lodges has either
  person ever had a booking at?* Dates no longer come into it, so a date change
  can no longer move a lodge in or out of the answer, and the officer making
  that change simply waits for the merge instead of slipping past it. Just
  before it tidies the beds, the merge also re-checks that no new booking has
  appeared at some further lodge; if one has, the whole merge is refused with
  "a lodge booking for one of these members changed while the merge was running
  — nothing was merged, please try again", and a retry picks the new lodge up.

  What an operator will notice, stated at full size. A merge of a long-standing
  member now holds **every lodge that person has ever booked at** — on a
  two-lodge club, in practice all of them — for as long as the merge takes, up
  to two minutes. While it runs, a booking creation, confirmation, payment
  capture, cancellation or bed-board edit at one of those lodges is not merely
  delayed: after about five seconds it is **refused outright** with a "please try
  again" and has to be repeated. Merges are rare and short in the ordinary case,
  but this is the trade. Nothing is ever half-saved — a refused edit, and a
  refused merge, roll back completely.
