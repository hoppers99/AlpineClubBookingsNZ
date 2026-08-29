- **The setup wizard's Lodges step now carries the lodge list itself (#250).**
  The step used to offer two kinds of link and nothing to do, which is exactly
  how it was reported: an operator walking a fresh install asked "and how do I
  set up a lodge here?" of a screen that had no answer. It now shows the list
  from Admin → Lodges inline, beneath the step's check — every lodge with its
  open-for-booking state, **Edit** to rename it or change its address, door code
  and travel note, **Activate**/**Deactivate** with its dependency confirmation,
  and **Add lodge**. It is the same editor saving through the same routes, not a
  second copy, and Admin → Lodges is unchanged in what it does.

  **A lodge's own six-step guided setup is still reached by link**, from
  **Configure** on each row or from the per-lodge links in the check above.
  That is deliberate: rooms and beds, lockers, seasons and chores are a flow of
  their own and a better place to do that work than a card inside another
  wizard.

  **A fresh install seeds one lodge named after the club**, and until now
  nothing anywhere suggested renaming it. The step now says so, and the rename
  is one **Edit** away in the list it is saying it above.

- **"Open for booking (0 rooms, 0 beds)" now says what it means (#250).** That
  line read as a contradiction, and it was covering two opposite situations in
  the same few words: a lodge running correctly on a per-lodge capacity
  override, and a lodge nobody can book at all. An active lodge with no beds now
  gets its own sentence naming the fact and the setting that decides the rest.
  It does not change the step's verdict — a bed-less lodge can be correctly
  configured, so this is something to read rather than a check that fails.

  Activating, renaming or adding a lodge from inside the wizard makes the step's
  badge, its detail lines and its per-lodge links catch up straight away,
  without a reload. Saving still does not tick the step off: **Mark this step
  done** remains the one action that records that a person agreed.
