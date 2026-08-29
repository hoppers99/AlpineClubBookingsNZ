- **The setup wizard now remembers which finished steps an upstream change put
  back in question (#217).** Some setup steps only make sense once an earlier one
  is settled, so reopening that earlier step puts everything downstream of it —
  and everything downstream of *that* — into **Needs another look**.

  That state is now written down rather than worked out afresh on every view, so
  closing the tab, coming back tomorrow, or a second officer opening the wizard
  all show the same picture. Nothing you did is thrown away: a step needing
  another look is still recorded as done, and it returns to **Done** on its own
  once the step it depends on is settled — you do not have to open it again.

  While anything needs another look the wizard counts it as outstanding, so it
  holds the **wizard's** progress percentage back and keeps **Ready to open**
  locked. The Setup checklist page keeps its own separate counter, which does not
  yet know about the new state — that follows when the checklist cards move over
  to the wizard's view (#223). And if you had already finished setup, the wizard
  stops showing "Setup complete" while steps need another look; once they are
  settled, an administrator finishes setup again from the checklist. A club
  should never be told it has finished over work that is still waiting, and the
  club rather than the software decides when it is finished, so the flag is never
  quietly put back.

  Two new Audit Log event types record it: one for steps that started needing
  another look, one for steps that stopped. Both are in the **system** category
  alongside the existing setup-progress entries, so exactly the same people can
  read them and nobody's access changes. (Pressing **Finish setup** while
  something still needs another look was originally recorded with the list of
  steps that held it back; #247 in this same release refuses the click outright
  instead, so there is no such entry — the reason goes to the person who clicked.)

  **If the list cannot be worked out, nothing is changed.** Deciding which steps
  need another look means reading the rest of the installation's settings, and
  when that read fails the wizard refuses the change and says so, rather than
  saving it with the list guessed at. Nothing is recorded, nothing is logged, and
  the same click works normally once the problem clears.

  **Upgrading does not put your finished steps back into question.** A step that
  a new release adds arrives as **Not started**, which is a different thing —
  nobody has done it yet, rather than somebody having done it and something
  having changed underneath it. Existing installations upgrade with nothing
  marked as needing another look.
