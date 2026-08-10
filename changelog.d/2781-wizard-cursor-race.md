- **An integration setup wizard no longer jumps back to step one when you click
  a step as it opens (#2781).** Each guided setup wizard — Xero, Stripe, Google,
  backups, the lobby display — remembers where you got to last time and takes
  you back there. Fetching that saved position happens in the background, and if
  you clicked a step in the stepper before the answer arrived, the wizard threw
  your click away and put you back on the first step. On a slow connection, or
  on the first visit of the day when the site is waking up, that could happen
  often enough to be maddening.

  Clicking a step now always wins: whichever step you pick is where the wizard
  stays, and the saved position is only used when you have not chosen a step
  yourself. Everything else about resuming is unchanged — open a wizard and
  leave it alone and it still returns you to the step you were last on, still
  refuses to let you skip ahead past a step you have not completed, and a first
  visit still starts at step one so you see the introduction.
