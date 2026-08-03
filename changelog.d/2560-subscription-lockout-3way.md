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

  **This release needs a short maintenance window, and your operator should read
  the upgrade notes before scheduling it.** The old on/off column is removed in the
  same release that replaces it, rather than being left behind for a later one. That
  keeps the system honest — there is only ever one record of your setting — but it
  means the previous version cannot run once the upgrade has been applied, so the
  site goes into maintenance mode for the few minutes the change takes instead of
  rolling over seamlessly. Your setting is carried across automatically, a fresh
  backup is taken and verified first, and a tested reverse script ships with the
  release in case the new version does not start. `docs/UPGRADING.md` has the
  sequence in plain English.

  If you do choose the new option, this is what a member experiences. Their own
  nights are charged at the club's existing non-member rate, using the same Xero
  item code as any other non-member, so the invoice reads as an ordinary
  non-member line with nothing new for a treasurer to explain. Nobody else on the
  booking is affected — only the person whose subscription is unpaid. They are
  told why, in a sentence on the quote screen, the edit screen and the waitlist
  offer email that explains member rates are unavailable while the subscription is
  unpaid and that renewing restores them. It names no person and no amount, so it is
  safe on a screen a family member may be reading — and for the same reason it is
  worded about the booking rather than about the reader, so a paid-up member booking
  for an unfinancial relative is never told their own subscription is in arrears.

  The invoice line for that member now reads **Non-member** rather than Member,
  matching the non-member amount and the non-member item code it has always been
  coded to. One side effect worth knowing about: if your club uses a membership type
  that is deliberately configured onto non-member rates, those members' invoice lines
  change the same way. It is wording only — no amount, item code or account code moves.

  The **Book a stay** screen's subscription warning is now aware of the setting: it
  only says "pay it before booking" where that is actually true. Under the new option
  it explains the repricing instead, and where the club ignores subscriptions it says
  nothing.

  The booking must still have at least one adult member on it whose subscription
  **is** paid. If it does not, the booking is refused — but the member can ask a
  Booking Officer to allow it, and **the bed is held while that request is
  pending**, so they are not made to race for capacity while the club decides.

  **That requirement follows the unpaid subscription, not just the bed.** It applies
  when somebody staying on the booking is being repriced, and also when the person
  who **made** the booking has an unpaid subscription, whether or not they are
  staying on it. Otherwise the softer option would quietly hand back the one thing
  "stop them booking" reliably prevents: a member could let their subscription lapse
  and go on booking beds for other people with no friction at all. It is still
  gentler than stopping them — today that member cannot book at all, and here they
  get the Booking-Officer override with the bed held — and if a paid-up adult member
  is on the booking, a financial spouse or parent say, it simply books. A booking
  with nobody unpaid on it, made by a member who is paid up, is judged exactly as
  before: an all-non-member group, a family whose only member row is a child and a
  paid-up youth member booking their own bed are all untouched. Relatedly, if the
  club also runs the adult-member hosting rule, a member being charged non-member
  rates no longer counts as the responsible adult member who hosts non-member
  guests — their guests need a genuinely paid-up adult member present.

  The new charge is applied at the single point every part of the system already
  uses to price a booking, so the quote, the booking, a later edit, adding a
  guest, confirming a draft and joining a group booking cannot disagree about what
  somebody owes. The paid-up-adult requirement is checked wherever the party can
  change — including when somebody is REMOVED, so a booking cannot be approved on
  the strength of a paid-up adult and then have that adult taken off in a second
  step — and when a waitlist offer is confirmed, including an offer for a different
  lodge. A refused waitlist offer is **not used up**: the entry goes back on the
  waitlist at its place, so the member can fix the party or ask a Booking Officer
  instead of losing their turn. A member who declines a member-guest invite can
  always still be taken off a booking; that is never blocked.

  **Two narrow cases become reviewable where they used to just go through**, and both
  are worth knowing before you switch a live club. Because the paid-up-adult
  requirement looks at the whole booking while the old checks looked only at guests
  being added, a draft confirmed by a paid-up youth member with an unfinancial member
  guest on it, and an edit to a booking that already carries an unfinancial member,
  can now be refused — with the Booking-Officer override path and the bed held, not a
  dead end. No previously-blocking refusal becomes stricter, and the member booking
  for other people while their own subscription is unpaid is not a third case: they
  are refused outright today.

  Reversing the choice is a settings change: pick a different answer and save.
  Bookings already taken keep the rate they were given, and a night somebody has
  already bought keeps both its price and its invoice coding even when the rest of
  the stay is re-priced by a later edit.
