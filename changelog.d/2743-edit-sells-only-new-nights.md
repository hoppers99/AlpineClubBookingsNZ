- **Editing a booking that is under way no longer puts a guest who has already
  gone home back on it, and charges them for the rest of the stay (#2743).** A
  guest can be booked for only part of a booking's nights. If their own nights
  had finished and somebody then edited the booking — even a change that left
  the dates exactly where they were, like correcting a name or adding a guest —
  the software put that guest back on the booking for every remaining night and
  billed the member for all of them. In the club's own worked example, a guest
  booked for two nights of a nine-night booking was charged seven more by a save
  that changed nothing about the dates.

  An edit now adds a night to an existing guest only when it actually moves the
  check-out, and only for nights past the old check-out. An edit that leaves the
  check-out where it is cannot add a night to anybody.

  **Nothing changes for the ordinary case** — a guest who stays for the whole
  booking is priced, quoted and charged exactly as before, extension included,
  and so is a guest whose stay ends on the day the booking does. Where the
  correction does apply, the member always pays **less** than they would have,
  never more.

  Extending the check-out still adds the new nights to every guest still on the
  booking, including one whose stay had already finished. That is not an
  oversight: an edit to a booking in progress has no way to give one guest a
  different departure date, so "everybody gets the new nights" is the only thing
  it can say. The quote shows those nights before the save, and the club's
  invariants record the behaviour rather than leaving it to be discovered.

  One kind of save is now refused that used to go through: an edit to a booking
  whose check-out is still ahead but whose guests have all finished their stays.
  Those remaining nights used to be sold to a guest who had left; now nobody
  holds them, so the save is stopped and the check-out date that matches who is
  actually there is named.

  **Bookings edited before this fix are left exactly as they are.** Nothing is
  recalculated, reversed or credited in the background. If a member was
  over-charged this way, that stands on the booking until the club decides what
  to do about it — #2745 is where that decision gets made, with a read-only
  audit as the first step.
