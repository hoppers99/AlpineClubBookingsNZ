- **Members can now ask a Booking Officer to let a booking past a club rule, and
  manage that request themselves (#2562).** Until now a member stopped by a
  minimum-stay rule, or by the requirement that an adult member is present for
  non-member guests, had to telephone the club: the request, the officer's queue and
  the approval that creates the booking all worked, but there was no button on the
  member's side of the screen.

  There is now a **Request Booking Officer approval** step on both the booking
  wizard and the edit screen of an existing booking. It appears only where the
  server has confirmed the rule is one an officer can actually waive — a full lodge,
  dates in the past, a night the member already holds, a guest they have no
  authority over and a missing consent draw no such option at all, because none of
  them can be waived. Before sending, the member sees exactly what an officer will
  decide (the lodge, the nights, every guest and their nights, the guest-night
  total, the price, and every rule involved), must say why they are asking, and
  reads plainly that sending a request books nothing and that approval is at the
  officer's discretion.

  **The wording about beds is now true per path rather than reassuring in general.**
  A request for a booking that does not exist yet holds no beds, and says so;
  availability is checked again when an officer reviews it, approval can never put
  the lodge over capacity, and approval is not itself a reservation — the booking it
  creates holds nothing until it is paid, which the pending row now says rather than
  implying that an approval secures the nights. A request to change an existing booking states
  whether that particular change is holding any extra beds. A request an officer has
  already tried to apply, and the lodge had no room for, now reads "waiting — the
  lodge was full" instead of sitting silently as though nobody had looked.

  **My Bookings carries a new "My booking-rule requests" section.** It lists every
  request the member has raised with its exact proposal, what they told the officer,
  what the officer told them, whether beds are held, and a link to the booking once
  an approval has created one. While a request is open they can withdraw it, or
  replace it with a corrected one — a request cannot be edited after it is sent,
  because an officer decides the exact proposal that was submitted. The section is
  absent for a member who has never raised a request.

  **For officers, the decision note is now two fields.** The existing note has
  always been shown to the member, which left nowhere to record private commentary;
  the decision form now labels that field as member-visible before it is submitted
  and adds a separate **internal note** that only admins ever see. A refusal still
  requires the member-facing explanation — an internal note cannot stand in for it,
  because a refusal the member cannot read is a refusal they cannot act on. Existing
  decision notes are unchanged and stay member-visible, which is what they have
  always been.

  **A refused request now emails the member.** The officer's explanation is
  mandatory on a refusal so the member can act on it; until now it was recorded and
  delivered nowhere, so the member had to keep checking My Bookings or ring the
  club. They now get a message naming the nights, the officer's reason, and the fact
  that nothing was booked and any beds the request was holding have been released.
  A refusal about an existing booking is withheld by that booking's "No emails"
  switch like every other message about it.

  **An approved new booking no longer tells the member their beds are secured.** The
  booking an approval creates is unpaid, and an unpaid booking holds no beds — so
  the request now says so and points at paying it, and it changes to "holding its
  beds" once the payment lands. If that booking is later cancelled, or lapses because
  it was never paid, the row says it is no longer live instead of telling the member
  to pay something they cannot. An approved change to an existing booking says the
  change was applied rather than describing a booking that was never created.

  **The request card no longer shows a price the club could not charge.** On the
  booking wizard a promo code, a working-bee discount, account credit, a room
  request, an arrival time, a note and the payment-method choice are not part of an
  exception request, and the card now names each one it is leaving out and shows the
  club's normal-rate figure instead of the discounted one. On the edit screen, a
  quote that included a promo or account credit no longer has its figure shown at
  all, because the frozen proposal is priced without them. And a request card left
  over from an earlier refusal is retired the moment the member changes the lodge,
  the dates or the party, so nobody is offered a request for a booking they could
  now simply make.

  **Locked-period change requests get the same two-field officer note.** That queue
  writes the same member-visible note as the exception queue and its box was headed
  only "Admin notes", so it now names its audience before the decision is submitted
  and offers the internal-note counterpart beside it. The member's own booking page
  labels the note it shows them as coming from the club. Two further things changed
  on that form: neither decision can be sent until the member-facing explanation is
  written (before, a card nobody had typed into could be decided with no explanation
  at all), and each card keeps its own draft — one per request, whichever field is
  typed in and in whatever order — so a note started against one request can no
  longer appear on, unlock, or be submitted with another member's.

  **The help pages now describe the request limit as it is actually enforced:** one
  open request per identical proposal for a new booking and one per booking for a
  change, with **Replace** as the way to switch an existing ask to different dates.
  The previous wording promised a single open request per member, which would have
  let a member end up with two approvable requests without realising.

  Nothing about how policies are evaluated, how capacity is calculated, or how an
  approval creates the booking changed. Operators need do nothing: the member step
  appears wherever a waivable rule already applies.
