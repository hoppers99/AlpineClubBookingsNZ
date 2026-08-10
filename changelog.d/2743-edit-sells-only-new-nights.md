- **Editing a booking that is under way no longer puts a guest who has already
  gone home back on it, and charges them for the rest of the stay (#2743).** A
  guest can be booked for only part of a booking's nights. If their own nights
  had finished and somebody then edited the booking — even a change that left
  the dates exactly where they were, like adding another guest to the party —
  the software put that guest back on the booking for every remaining night and
  billed the member for all of them. In the club's own worked example, a guest
  booked for two nights of a nine-night booking was charged seven more by a save
  that changed nothing about the dates. (Correcting a spelling on its own was
  never affected: a name-only edit takes a separate path that cannot move money
  at all.)

  An edit now adds a night to an existing guest only when it actually moves the
  check-out, and only for nights past the old check-out. An edit that leaves the
  check-out where it is cannot add a night to anybody.

  **Nothing changes for the ordinary case** — a guest who stays for the whole
  booking is priced, quoted and charged exactly as before, extension included,
  and so is a guest whose stay ends on the day the booking does. Where the
  correction does apply, the member always pays **less** than they would have,
  never more.

  **It applies to guests who are still in the lodge, too.** The test is not
  whether somebody has gone home; it is whether their nights run all the way to
  the booking's own check-out. Someone who is here tonight but leaves on the 23rd
  of a booking that runs to the 27th is affected the same way: extend the
  check-out and they are given the new nights with a gap in front of them, and a
  smaller bill than before. The bed board shows them out for those nights and
  back for the new ones, which is what they actually booked.

  Extending the check-out still adds the new nights to every guest still on the
  booking, including one whose stay had already finished. That is not an
  oversight: the edit screen for a booking in progress gives no way to set one
  guest's departure date, so "everybody gets the new nights" is the only thing it
  can say. Be aware that the quote shows this as a **single total** for the whole
  party — one "future-night date change" figure — not as a per-guest or
  per-night breakdown, so an extension that gives four departed guests three
  nights each shows up as one dollar amount. The club's invariants record the
  behaviour and that limit rather than leaving either to be discovered.

  One kind of save is now refused that used to go through: an edit to a booking
  whose check-out is still ahead but whose guests have all finished their stays.
  Those remaining nights used to be sold to a guest who had left; now nobody
  holds them, so the save is stopped and a check-out date that both matches who
  is actually there **and** can actually be saved is named. Related: because
  nobody is back-filled any more, taking the longest-staying guest off a booking
  can leave its check-out date later than the last night anybody holds. That is
  allowed — refusing it would block an ordinary removal — but such a booking will
  eventually hit the refusal above and need its check-out corrected.

  **Bookings edited before this fix are left exactly as they are.** Nothing is
  recalculated, reversed or credited in the background. If a member was
  over-charged this way, that stands on the booking until the club decides what
  to do about it — #2745 is where that decision gets made, with a read-only
  audit as the first step.
