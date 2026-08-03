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
  availability is checked again when an officer reviews it, and approval can never
  put the lodge over capacity. A request to change an existing booking states
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

  Nothing about how policies are evaluated, how capacity is calculated, or how an
  approval creates the booking changed. Operators need do nothing: the member step
  appears wherever a waivable rule already applies.
