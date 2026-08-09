- **The bed allocation board no longer opens on every lodge at once when you
  reach it from a booking (#2678).** On a club with more than one lodge, the
  "Bed allocation" link on a booking's admin tools took you to the board without
  saying which lodge the booking was at. The board then loaded the whole club, so
  the bed pickers — the "Select bed" menu on a guest, "Move to bed" on an
  allocated guest, dragging a guest onto a bed, and the range-assign dialog — all
  offered beds at *other* lodges for that booking's guests. Choosing one looked
  fine until you confirmed it, at which point it was refused, correctly, because
  a guest cannot be put in a bed at a lodge they are not staying at.

  The board now opens on the booking's own lodge. The server works the lodge out
  from the booking itself rather than trusting whatever the link asked for, which
  is the same rule already applied to the room picker on a booking and to the
  room preference in the booking wizard.

  Nothing changes for the board when you open it directly and choose a lodge
  yourself. No allocation, hold or booking is altered.

  The same rule now applies to the **hut leaders** bed picker. When you edit an
  existing assignment, the beds you are offered come from that assignment's own
  lodge, worked out from the assignment rather than from the link — so a stale
  or hand-edited address can no longer offer you beds at the wrong property.
  Creating a new assignment is unchanged: there is no assignment yet, so the
  lodge you choose is the lodge you get.

  One consequence to expect: while a booking is focused it now decides the
  board's lodge, so if you switch the lodge selector to a different lodge the
  board stops following that booking — the "Focused booking" tag disappears and
  you get the lodge you asked for. The alternative would have been to keep
  showing the booking's lodge while the selector claimed otherwise.

  One thing this does **not** yet fix, so it is worth knowing: if the list of
  lodges cannot be loaded, the board still falls back to showing the whole club,
  and the bed pickers are club-wide again in that state. Confirming a bed is
  still refused, so nothing incorrect can be saved — but you may be offered beds
  you cannot use. That is being handled separately, along with making "all
  lodges" a view you can actually choose: at present, on a club with more than
  one lodge, the selector always resolves to a real lodge, so there is no
  club-wide board to pick.

- **Internal: the member room-listing endpoint keeps its older, lodge-free form
  on purpose, and that reason is now written down (#2678).** Nothing to do and
  nothing changes. Since the booking wizard started naming a lodge, no screen in
  this club's own site asks that endpoint for "every lodge's rooms" any more — so
  from the inside the older form looks like something left behind, and a future
  tidy-up would remove it. It is kept deliberately: other clubs run their own
  copy of this software and their booking pages still call it the old way, and
  removing it would break them for no gain here. That is now recorded as a rule
  with the reason attached, and a check stops any screen in this site quietly
  going back to the lodge-free form — which is what caused the wrong-lodge room
  pickers in the first place.
