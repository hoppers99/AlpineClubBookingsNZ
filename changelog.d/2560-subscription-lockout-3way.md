- **A club can now let a member with an unpaid subscription book at non-member
  rates instead of turning them away (#2543).** Until now the club had one switch:
  either an unpaid annual subscription stopped a member booking altogether, or it
  was ignored. Some clubs want the middle answer — let them book, but charge them
  what a non-member pays until they settle up.

  **Admin → Subscription Lockout → Booking lockout** now asks one plain question,
  "what happens when a member's subscription is unpaid", and offers three answers:

  - **Stop them booking.** What every club does today, and the default.
  - **Let them book normally.** No subscription check at all.
  - **Let them book, at non-member rates.** The new option.

  **Your club stays exactly as it is until an admin changes this.** Whatever your
  old on/off switch said carries straight over — on becomes "stop them booking",
  off becomes "let them book normally" — and no existing booking is repriced.

  If you do choose the new option, this is what a member experiences. Their own
  nights are charged at the club's existing non-member rate, using the same Xero
  item code as any other non-member, so the invoice reads as an ordinary
  non-member line with nothing new for a treasurer to explain. Nobody else on the
  booking is affected — only the person whose subscription is unpaid. They are
  told why, in a sentence on the quote screen that explains member rates are
  unavailable while the subscription is unpaid and that renewing restores them; it
  names no person and no amount, so it is safe on a screen a family member may be
  reading.

  The booking must still have at least one adult member on it whose subscription
  **is** paid. If it does not, the booking is refused — but the member can ask a
  Booking Officer to allow it, and **the bed is held while that request is
  pending**, so they are not made to race for capacity while the club decides.
  That requirement only applies to bookings this repricing actually touches: a
  party with nobody unpaid on it is judged exactly as before. Relatedly, if the
  club also runs the adult-member hosting rule, a member being charged non-member
  rates no longer counts as the responsible adult member who hosts non-member
  guests — their guests need a genuinely paid-up adult member present.

  The new charge is applied at the single point every part of the system already
  uses to price a booking, so the quote, the booking, a later edit, adding a
  guest, confirming a draft and joining a group booking cannot disagree about what
  somebody owes. All five places a member commits to nights enforce the same rule
  in the same way.

  Reversing the choice is a settings change: pick a different answer and save.
  Bookings already taken keep the rate they were given.
