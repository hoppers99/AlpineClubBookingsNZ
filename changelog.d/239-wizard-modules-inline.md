- **The setup wizard now carries the module toggles, and the rail redraws
  beside them (#239).** The **Feature Flags** and **Address Autocomplete** steps
  show the module grid from Admin → Modules inline, beneath the step's check.
  Both steps show the same grid, because Address Autocomplete is a single
  checkbox on it rather than a screen of its own, and it is the same editor
  saving to the same place — not a copy.

  A module that is switched off contributes no setup steps, so this is the one
  inline editor that changes the journey rather than a setting the journey
  reports on: ticking **Xero integration** and saving makes its two setup steps
  appear in the rail as you watch, clearing it takes them away again, and the
  percentage moves because the number of steps it divides by has just changed.
  Doing the same thing on the Modules page in another tab behaves as it always
  has — the rail catches up when you come back to the wizard's tab.

  One case is worth knowing about. Address Autocomplete is the only step whose
  own module's checkbox sits on the grid underneath it, so clearing that
  checkbox while you are standing on that step removes the step you are on. The
  wizard moves you to the next outstanding step and tells you it has. Nothing
  can disappear from behind you — every module-owned step sits later in the
  journey than the two steps this editor appears on.

  Saving the toggles does not tick the step off: **Mark this step done** is
  still the one action that records that a person agreed. The two permissions
  stay separate as on every other inline editor — recording progress needs
  Support edit, and so does changing the modules, so here they happen to be the
  same answer and an officer with Support view sees a read-only grid with the
  reason above it.

  **Admin → Modules itself is unchanged in what it does.** The editor moved into
  a component the wizard can also mount, which leaves the page a thin shell
  around it; the only visible difference is that Refresh and Save now sit on
  their own row beneath the page's heading rather than beside it.

- **The wizard says so whenever it moves you off a step, not only when you
  picked that step yourself (#239).** It used to announce the move only if you
  had clicked the step in the rail; if you were simply resuming where you left
  off, the screen could change under you without a word. That was harmless while
  nothing on the wizard could delete a step, and it is not any more.
