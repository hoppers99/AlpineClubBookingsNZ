- **The setup wizard's Seasons And Rates step now carries the season-window
  editor itself (#261).** It shows the same list as Admin → Seasons inline,
  beneath the step's check: pick a lodge, review its season windows, **Edit
  window** to change a name, type, dates or active state, **Activate**/
  **Deactivate**, or **Delete**. It is the same editor saving through the same
  routes, not a second copy, and Admin → Seasons is unchanged in what it does.

  **Adding a new season and setting its nightly rates still happen at Admin →
  Fees → Hut Fees**, which this pane links to. That is not a shortfall this
  release is deferring — a season cannot be created without at least one rate,
  and rates are set there, never on this page, so the step's badge can still
  read blocked or amber after a perfect save here. The pane's own text says so.

  Editing, deactivating or deleting a window from inside the wizard makes the
  step's badge and detail lines catch up straight away, the same as every
  other inline editor in the wizard — saving here does not tick the step off;
  **Mark this step done** is still the one confirmation that a person agreed.
