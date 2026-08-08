- **The expected arrival time stays — cleaned up, honest, and now on the lodge
  display (#2621).** The committee decided the arrival time remains as
  information for hut leaders and guests (it never affects chores — a lodge day
  still runs midday to midday). Four long-standing defects are fixed: the time
  field silently accepted values like 2:10 PM that the picker could never offer
  (one shared half-hour rule now governs the picker, the checks and every
  display, and older odd values still read back correctly); the booking page's
  arrival-time editor used to say "Saved" even when the save had failed — it
  now saves only when you press Save and tells the truth about the result;
  changes to the time are now recorded in the audit log (including who set it,
  on whose booking, and what it was before — the two new audit entries are
  `booking.expected_arrival_time.set` and `.cleared`); and the time dropdown is
  now properly labelled for screen readers everywhere it appears.

  The lodge display TV's arrivals board now shows each arriving party's
  expected time (for example "arr 5:30 PM") — but only on rows already allowed
  to show names under the display's privacy rules, and only for parties whose
  stay begins that day.

  The built-in pre-arrival reminder email gains one sentence for clubs that run
  chore rosters: guests are on the roster on the morning they check out and
  should talk to the hut leader beforehand if leaving early. Clubs without the
  chores module, and clubs with customised templates, see no change.
