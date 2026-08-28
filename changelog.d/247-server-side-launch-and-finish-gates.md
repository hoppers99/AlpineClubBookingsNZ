- **Opening the public site and finishing setup are now decided by the server,
  not by the button (#247).** Two of the setup journey's endings took the caller
  at their word. Anything that could reach the address — a script, a stale tab
  left open, a double-click landing while the page was reloading — could publish
  the club's public site or mark setup complete, whatever state the club was
  actually in. The controls on screen were the only check, and a control is not a
  rule.

  **Mark Setup Complete is refused while steps are outstanding.** If anything is
  neither finished nor deliberately skipped, the click reports which steps are
  holding it back and changes nothing at all — no record, no audit entry, no
  half-finished state to explain afterwards. Skipping still counts as settled, so
  a club that means to open with work outstanding does exactly what it did
  before: skip those steps, then finish. This replaces the older behaviour of
  recording a finish that did not take effect: nothing is written, so there is
  nothing to annotate, and the reason goes to the person who clicked instead of
  into the log.

  **Making the public site visible is refused while nothing has declared what
  this installation is.** If the environment role reads *not configured* — the
  variable is unset, holds something the application will not guess at, or the
  safer override could not be read — the site stays on its holding screen and the
  message names what to set and where. A **declared** role never blocks
  publishing, either of them: an internal test site that is deliberately visible
  and deliberately not production remains a perfectly normal permanent state.
  What is blocked is publishing with no answer at all, because an installation
  nobody has declared may be a copy restored from the club's live database, and
  opening one puts a second version of the club's site in front of the public.

  The same refusal covers the older **Finish setup** button on the Site Style
  page, which writes the same flag by a different route. An ordinary Save there
  is untouched, so an undeclared installation can still work on its colours while
  somebody sorts the declaration out.

  Nothing changes for a club that is already set up and already open, and no
  existing setting, record or permission moves.
