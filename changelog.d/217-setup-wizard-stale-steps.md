- **The setup wizard now remembers which finished steps an upstream change put
  back in question (#217).** Some setup steps only make sense once an earlier one
  is settled, so reopening that earlier step puts everything downstream of it —
  and everything downstream of *that* — into **Needs another look**.

  That state is now written down rather than worked out afresh on every view, so
  closing the tab, coming back tomorrow, or a second officer opening the wizard
  all show the same picture. Nothing you did is thrown away: a step needing
  another look is still recorded as done, and it returns to **Done** on its own
  once the step it depends on is settled — you do not have to open it again.

  While anything needs another look it counts as outstanding, so it holds the
  progress percentage back and keeps **Ready to open** locked. And if you had
  already finished setup, the Setup page stops saying "Setup complete" until the
  list is empty again — a club should never be told it has finished over work
  that is still waiting.

  Two new Audit Log event types record it: one for steps that started needing
  another look, one for steps that stopped. Both are in the **system** category
  alongside the existing setup-progress entries, so exactly the same people can
  read them and nobody's access changes.

  **Upgrading does not put your finished steps back into question.** A step that
  a new release adds arrives as **Not started**, which is a different thing —
  nobody has done it yet, rather than somebody having done it and something
  having changed underneath it. Existing installations upgrade with nothing
  marked as needing another look.
