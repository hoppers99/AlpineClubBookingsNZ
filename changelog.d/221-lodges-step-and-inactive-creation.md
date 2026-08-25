- **A lodge you add is no longer bookable the moment you name it (#221).** Adding
  a lodge used to make it available for booking immediately — before it had a
  single room, bed, season or rate. A new lodge is now created **Inactive**, and
  the last step of the guided setup you already land in is where you activate
  it. The Add-lodge form says so before you commit, and the setup flow repeats
  it at the top of every step while the lodge is still closed.

  **Nothing about your existing lodges changes.** This is a change to what the
  *Add lodge* form asks for, not to any stored value: no lodge's Active setting
  moves, there is no migration, and installing, seeding or restoring a club from
  a config transfer still produces active lodges exactly as before. Only the
  admin *Add lodge* path is affected.

  You can build a closed lodge out in full while it is closed — rooms, beds,
  lockers, seasons, rates and chores all work on it, and so does copying seasons
  or chores across from an existing lodge. Activation is the last thing you do.
  Leaving a lodge closed indefinitely is a legitimate answer too: a property the
  club has bought but not opened stays Inactive for as long as you want, and is
  reported as outstanding rather than nagged about.

  Two consequences worth expecting. Lodge pickers across the member and admin
  screens still appear only once a **second active lodge** exists, so they now
  turn up when you open the new lodge rather than when you name it — which is
  when the club genuinely has two. And a new lodge can never become the club's
  default lodge while it is closed.

- **The setup wizard's guided journey now includes a Lodges step (#221).** A new
  **Lodges** section sits between Foundation and Booking Rules — the club's
  buildings come before the rules that are rules about them. It embeds no lodge
  editor: it lists every lodge with its own state and its active room and bed
  counts, links to each lodge's own guided setup, and reads done when every
  lodge is open for booking. It warns while any one of them is still closed.

  **A lodge's completeness is reported separately from the club's.** However
  many lodges you have, this is one step of the journey — so adding a second
  lodge does not push the club's percentage backwards, and a half-built lodge
  shows up as a named, linked line rather than as a mystery in the total. Room
  and bed counts are shown but never decide the verdict, because a lodge can
  legitimately run on a capacity override with no beds recorded.

  On upgrade, a club whose lodges are all open sees this step arrive already
  **Complete**; a club with a lodge switched off sees it arrive as a warning
  naming that lodge. Either way it is the "a new release added a step you have
  never seen" behaviour the wizard was built for.
