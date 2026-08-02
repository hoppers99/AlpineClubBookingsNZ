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
  held back because the lodge filled up, the card says so and when. **Show the
  guests** opens the exact party the approval would put on the booking — names,
  age groups, and a clear marker for a member guest from outside the requester's
  family — because approving executes that party for real and a guest count
  cannot show an unrelated member being attached to somebody else's stay.

  Approving is deliberately two steps — open the decision, write a reason, tick
  the confirmation — and it **applies the exact proposal on the card**: the
  booking is created, or the change is made, as part of approving. There is no
  second "now go and do it" step and no window where a request looks approved
  but nothing happened. A reason is required to refuse and to approve an
  adult-member hosting exception, which is then recorded against the booking with
  the officer's name on it, so an approved request never leaves a review hanging
  for somebody else to find. The member reads that note on **any** decision, not
  only a refusal, and the field now says so. If the change reduces the price of a
  booking that is already paid, the same form asks where the refund goes — card
  or account credit — so the archetypal "let me shorten my stay" exception can
  actually be approved instead of only refused.

  **Approving a new booking now emails the member** what was approved and what is
  left to pay. They are not standing in the payment screen the way an ordinary
  booker is, and an unpaid booking holds no beds, so silence meant the lodge could
  fill without them ever knowing they had a booking. An approved change is still
  announced by the usual "your booking was changed" email.

  **Approving overrides the rules on the card and nothing else — including the
  rules the officer was never shown.** A member guest from outside the
  requester's family is still refused, or still has to be asked, exactly as on the
  member's own booking path; the guest's own membership and age group come from
  their member record rather than from what the requester typed; a party of minors
  with no adult still opens the child-safety review, PENDING, with the member's own
  explanation on it, rather than being stamped approved in the name of an officer
  who was never asked about supervision. The party frozen for review is now
  produced by the same code the booking service uses to apply it, so the stay an
  officer approves is the stay that gets built — down to a guest with a gap in the
  middle of their nights.

  The refusals are honest. Approving overrides only the rules listed on the
  card: lodge capacity, payment, membership and privacy rules all still apply,
  and the officer is never treated as someone who can overbook the lodge. If the
  lodge has filled since the member asked, the officer is told the request
  **stays pending** and nothing was created — the queue refreshes itself so they
  can approve it again the moment space frees up, or refuse it. A request for a
  booking that does not exist yet always reads **No beds held**, because there is
  nothing for a reservation to hang off; telling an officer those beds were safe
  invited them to deprioritise the one request that could be beaten to them. If
  the live booking or the club's policies moved after the member asked, the
  approval refuses and explains which, so nobody approves something different from
  what was reviewed — and an old request stored before this workflow shipped now
  says exactly that, instead of blaming an edit to a booking nobody touched.
  Permission is re-checked from live data at the moment of approval, so access
  removed since the queue was opened cannot execute a booking. A booking waiting on
  any admin review still cannot check in — approving a policy exception is not a
  way around that.

  **A committed approval is never reported as still pending.** Work that runs
  after the booking is saved — an email, an accounting hand-off, an audit write —
  can fail on its own, and when it does the officer is told the booking was
  created or changed **but some follow-up work failed**, with a nudge to check the
  booking and the member's email. Previously that read as "nothing happened, the
  request is still pending", which sent officers into a stale-version refusal or
  into creating the same booking a second time by hand. And a request kept pending
  because the lodge is full now always records why, so both the officer's card and
  the member's own view can tell "the lodge filled up" apart from "nobody has
  looked yet".

  Also in this change: the operator and member guides now describe the flow end
  to end, and browser tests cover the whole round trip — a member being refused
  a one-night stay, asking, being approved and ending up with a real booking;
  a request the lodge can no longer fit staying pending instead of being
  approved; and, at a two-lodge club, an exception raised at the second lodge
  being executed at that lodge rather than the club's default one. One honest
  limitation: **members cannot raise one of these requests themselves yet** —
  there is no button on their side of the screen, so for now the club raises it
  for them. The member help says so plainly, and the member-facing screens are
  tracked as #2562.
