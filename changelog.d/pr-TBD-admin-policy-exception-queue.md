- **Booking Officers can now decide the booking-policy exceptions members ask
  for, and approving one actually does it (#2526).** A new **Policy Exceptions**
  tab on **Admin → Booking Requests** lists every open ask from both places a
  member can raise one — a booking they have not made yet, and a change to a
  booking they already have — in one queue, newest first, with a count on the
  tab so nothing sits unnoticed. Waiting exceptions also raise the **Needs
  Attention → Booking Requests** badge in the sidebar, so an officer sees one
  without going looking.

  Each card is written to answer the decision, not to describe the data: who
  asked and **how long ago** in plain English, the dates and party they
  proposed, exactly which rules it breaks (named, at the policy version that was
  reviewed), which nights are affected, the member's own words, and whether the
  request is holding beds while it waits. If an earlier approval attempt was
  held back because the lodge filled up, the card says so and when.

  Approving is deliberately two steps — open the decision, write a reason, tick
  the confirmation — and it **applies the exact proposal on the card**: the
  booking is created, or the change is made, as part of approving. There is no
  second "now go and do it" step and no window where a request looks approved
  but nothing happened. A reason is required to refuse (the member reads it) and
  to approve an adult-member hosting exception, which is then recorded against
  the booking with the officer's name on it, so an approved request never leaves
  a review hanging for somebody else to find.

  The refusals are honest. Approving overrides only the rules listed on the
  card: lodge capacity, payment, membership and privacy rules all still apply,
  and the officer is never treated as someone who can overbook the lodge. If the
  lodge has filled since the member asked, the officer is told the request
  **stays pending** and nothing was created — they can approve it later if space
  frees up, or refuse it. If the live booking or the club's policies moved after
  the member asked, the approval refuses and explains which, so nobody approves
  something different from what was reviewed. Permission is re-checked from live
  data at the moment of approval, so access removed since the queue was opened
  cannot execute a booking. A booking waiting on any admin review still cannot
  check in — approving a policy exception is not a way around that.

  Also in this change: the operator and member guides now describe the flow end
  to end, and browser tests cover the whole round trip — a member being refused
  a one-night stay, asking, being approved and ending up with a real booking;
  a request the lodge can no longer fit staying pending instead of being
  approved; and, at a two-lodge club, an exception raised at the second lodge
  being executed at that lodge rather than the club's default one.
