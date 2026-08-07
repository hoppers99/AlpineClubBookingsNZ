- **The automated checks no longer fail at random on the recovery-message
  accessibility test (#2635).** When an action fails somewhere other than where an
  administrator is looking — a Xero sync, a booking approval, a deletion request, a
  card payment — the system moves the keyboard cursor onto the explanation, so
  someone using a keyboard or a screen reader is taken to it rather than left on a
  button that has just come back to life. Forty-seven automated checks, spread over
  eighteen screens, make sure that still happens.

  Those checks were asking the question a fraction of a second too early. The
  cursor moves one beat after the message appears, and the checks looked at the
  moment the message appeared, so on a busy build machine they occasionally
  reported a failure that was not real. That happened on the main branch, and the
  same code passed when the identical build was simply run again. A check that
  cries wolf is worse than no check: it teaches everyone to re-run it, which is how
  a genuine failure gets waved through.

  All forty-seven now ask the question properly — they wait for the cursor to arrive
  and then confirm it is *still* there once everything has settled, which is a
  stronger guarantee than before, not a weaker one. Nothing about what an
  administrator sees or does has changed.

  Two related problems were fixed on the way. Four checks on the card-payment
  screen had the same too-early timing on the message text itself and are now
  deterministic. And the investigation turned up a trap worth recording: making
  the cursor move in the same instant as the message — which looks like the tidier
  fix — actually breaks it, because a confirmation dialog closing at that moment
  takes the cursor away and drops it nowhere. The reason is now written down beside
  the code and pinned by its own check, so it cannot be "tidied" back in.
