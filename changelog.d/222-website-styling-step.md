- **The setup wizard's guided journey now includes a Website Styling step
  (#222).** Alongside Foundation, Booking Rules, Operational Integrations and
  Finance, the rail carries a new **Website** section with one step —
  **Website Styling** — that reports done the moment your colours, fonts, logo
  or custom CSS differ from the shipped defaults. It does not embed a second
  colour picker: it links straight through to the existing **Site Style**
  page, and reads exactly the same saved theme whichever surface you used to
  configure it.

  **This step never launches the public site.** Making the site visible stays
  exactly where it was — the wizard's final **Ready to open** screen — and this
  step says so plainly whenever it is done but the site is still dark. A club
  happy with the shipped default look does not need to touch this step at all;
  **Skip for now** is the intended path for that club, and the step stays
  visibly outstanding rather than silently passed.

  If you upgraded a club that finished setup a while ago, you will see this
  step arrive as **Not started** the next time you open the wizard or the
  readiness checklist — the same "a new release added a step you have never
  seen" behaviour the wizard was already built to handle (epic #213), working
  exactly as designed on its first real addition since launch.
