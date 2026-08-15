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

  Nothing about what may be saved has changed: putting a guest in another lodge's
  bed was already refused when saving and still is. This is about the board no
  longer offering choices it was always going to turn down.

  Single-lodge clubs see no change at all — there is no lodge selector and no
  club-wide view to choose.
