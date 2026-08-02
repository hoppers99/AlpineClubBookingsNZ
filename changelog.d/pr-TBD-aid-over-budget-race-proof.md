- **The AI Diagnostics monthly spending cap now has a proof that it cannot be
  overspent by two things happening at once (#2532).** The cap was already
  written to be safe when several diagnostics answers are being produced at the
  same moment, and the safety was checked by tests that did not need a database.
  What was missing was a test that puts two genuinely simultaneous requests
  against a real database and watches what happens.

  That test now exists and runs on every pull request. It deliberately holds the
  two requests still at the exact moment they would collide, confirms that
  neither one has been allowed to claim any of the budget yet, then lets them go
  and checks that exactly one of them gets it. It was proved to work by breaking
  the protection on purpose in two different ways — removing it, and applying it
  a moment too late — and confirming the test caught both, every time.

  Nothing an administrator sees or sets has changed — the budget, the warnings,
  and the spend figures all behave exactly as before. This is assurance that the
  cap holds under load, not a change to what the cap does.
