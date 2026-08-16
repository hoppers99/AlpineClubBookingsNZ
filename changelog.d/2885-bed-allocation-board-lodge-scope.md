- **The bed allocation board now says which lodge it is showing, and "All lodges"
  is something you choose rather than something it falls into (#2701).** In a club
  with more than one lodge the board used to treat "no lodge" as three different
  things at once: a deliberate club-wide view, a board that had not finished
  loading, and a lodge list that had failed to load. It looked identical in all
  three, and in all three the bed pickers offered every lodge's beds — including
  for a booking at a single lodge, where the save was then refused.

  The lodge selector now carries **All lodges** as a real option. Choosing it
  gives a club-wide, **read-only** overview: you can see every lodge's board, and
  the controls that change allocations — Select bed, Allocate, Assign range,
  drag-and-drop, Move to bed, Remove allocation, Run Auto Allocation, Approve
  Visible and Reset allocations — are switched off with one line on screen saying
  that allocation changes need a single lodge selected. Pick a lodge and they all
  come back.

  Opening the board normally now settles on a real lodge before it shows you
  anything, so you no longer see a flash of every lodge's beds on the way in. If
  the lodge list cannot be loaded you get a plain error and a **Try again**
  button instead of a board that silently shows the whole club.

  Following a booking's **Bed allocation** link now opens the board on **that
  booking's own lodge**, even when it is not the first lodge in the list.
  Previously the selector could read one lodge while the board below it showed
  another's. A link that names a booking at one lodge and a board at another —
  which nothing in the app produces, but a hand-edited address can — is refused
  with an explanation rather than shown as a board that contradicts itself.

  Two admin roles get a small improvement out of this too. **Membership Admin**
  and **Finance Admin** can view bookings but have no lodge access, so the board
  now opens for them on every lodge, read-only, and says why — rather than
  asking them to choose a lodge they cannot see. And a club with no active lodge
  is told so, with a link to Lodge settings, instead of the board waiting
  indefinitely.

  Nothing about what may be saved has changed: putting a guest in another lodge's
  bed was already refused when saving and still is. This is about the board no
  longer offering choices it was always going to turn down.

  Single-lodge clubs see no change at all — there is no lodge selector and no
  club-wide view to choose.

- **When the club's lodge list cannot be loaded, the admin pages now say so
  instead of looking like a club with no lodges — and a booking can no longer be
  created against a lodge nobody chose (#2701).** This was the more serious half
  of the same problem. Every lodge selector in the admin area draws on one
  request, and when that request failed it produced an empty list, which looked
  exactly like a club that has only one lodge. The selector then disappeared,
  and anything saved next went to whichever lodge the system treats as the
  default — a lodge nobody had been shown.

  Fifteen edit surfaces could write under the wrong scope. Eight could fall into
  the default lodge: rooms and beds, the roster, seasons, chore templates,
  lockers, hut fee rates, hut leader assignments and lodge capacity. Work
  parties and promo codes could silently turn a lodge-specific choice into a
  club-wide one. Five policy editors also fell into the club-wide scope:
  default cancellation, minimum stay, booking periods, adult-member hosting and
  lodge instructions. Each now explains that the lodge list did not load and
  holds back its downstream reads and every edit, save, create, remove, delete
  or toggle action until a deliberate club-wide choice or a concrete lodge has
  resolved. A transport error offers **Try again**; a role without lodge access
  gets the corresponding access explanation rather than a retry that can only
  fail again.

  **Booking is the part that mattered most.** A member could reach the end of
  the booking wizard during one of these failures and pay for a stay with
  nothing on screen naming a lodge. From now on: a booking must say which lodge
  it is for, and the system refuses rather than guessing; a member is blocked
  with a plain explanation and a retry instead of being charged; an admin
  booking on someone's behalf can carry on, with the lodge shown before anything
  is saved; and **every member now sees the lodge they are booking on the
  summary screen, including at clubs with only one lodge** — that line used to
  be hidden for single-lodge clubs, which is exactly why an outage was
  impossible to spot.

  The same rule now covers other existing booking-creation paths: copying a
  booking keeps its source lodge, and a member joining a group stays at the
  organiser's lodge instead of either path falling back to the club's default
  lodge. The internal create-service type now requires `lodgeId` too, and its
  runtime boundary refuses missing or blank values before any default-lodge
  resolver is reached, so aliases, wrappers and unchecked callers cannot bypass
  the HTTP refusal.

  Three screens are deliberately unchanged: the reports page, the promo-code
  redemptions panel and the public booking-requests panel already show a genuine
  "All lodges" view where every figure is correct, so losing the filter costs
  nothing and an error there would be worse than the gap it closed.
