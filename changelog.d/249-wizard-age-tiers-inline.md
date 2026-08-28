- **The setup wizard now carries the age-tier editor (#249).** The **Age And
  Membership Rules** step shows the same boundary editor as Admin → Age Group
  Settings inline, beneath the step's check, so you can set up age tiers
  without leaving the wizard.

  Saving does not tick the step off: **Mark this step done** is still the one
  action that records that a person agreed.

  One thing is worth knowing before you rely on a green badge here: the
  step's check is really two checks. This editor covers the first — whether
  age tiers are configured at all — but it also flags any membership type set
  to "subscription required based on age tier" when no tier actually requires
  one, and that flag lives on Admin → Membership Types, a screen this pane
  does not show. A perfectly saved set of tiers can therefore still leave the
  step amber; the pane's own text says so, and the fix is on that other
  screen.

  **Admin → Age Group Settings itself is unchanged in what it does.** The
  editor moved into a component the wizard can also mount, which leaves the
  page a thin shell around it — nothing about the page's own layout or
  behaviour changed.
