- **The nightly "lodge is nearly full" alert now counts everything that is
  actually taking up a bed (#2681).** The alert that emails administrators when a
  lodge is filling up worked out its own bed count instead of using the club
  system's main capacity calculation, and over time the two drifted apart. Three
  things the booking screens counted, the alert did not.

  It did not count beds a *held* policy-exception request has provisionally
  reserved, so a lodge could be close to full with nobody being told. It had no
  idea about exclusive whole-lodge holds, so a lodge booked out entirely for one
  group never produced a fullness warning at all. And for a guest staying
  non-consecutive nights it fell back to their first and last night, counting
  them as present on the nights in between when they are not there. The first two
  made the alert stay quiet when it should have spoken; the third could make it
  speak on a night that was actually free.

  All of that is fixed, and fixed at the cause rather than the symptom. The bed
  count is now written once, in one place, and every screen and job that needs it
  — the four booking and calendar checks, the nightly alert, and the hut-leader
  bed-hold form — asks that one calculation. A new test refuses to let a seventh
  copy appear, or a term be dropped from the one that remains. Nothing an
  administrator does changes: the booking screens, the calendars and the
  over-capacity confirmations all behave exactly as before, and the alert now
  fires in the situations it was always meant to.

  One smaller fix rides along: the confirmation shown when a hut-leader bed hold
  would push a lodge past its ceiling was also missing the held-request beds, so
  it could stay silent when the hold really did tip the lodge over. It now uses
  the same calculation as everything else.

- **Dates on the public booking forms and the finance screens now follow the New
  Zealand day, not the UTC day (#2682).** New Zealand is twelve to thirteen hours
  ahead of UTC, so for roughly the first half of every New Zealand day, "today"
  in UTC is still yesterday here. Fifteen places in the system worked today's
  date out the UTC way.

  Four of them mattered. The public *Request to Book* and *School Booking* forms
  set the earliest selectable night from that date, so anyone filling one in
  before about midday was offered a night that had already started — the club
  system then refused it, on the club's own public pages. Two finance figures
  (the "as at" cut-off deciding which stays count as realised) had the same
  problem, so a treasurer reconciling in the morning saw a different day's
  numbers than they would that afternoon, with nothing having changed in between.

  The remaining eleven only stamped a date onto a downloaded file's name or a
  date-of-birth field's upper limit, so the effect was cosmetic — but they are all
  converted too, so there is now nothing in the system that asks for "today" the
  wrong way. A test freezes the clock at nine in the morning New Zealand time —
  inside the window where the two dates disagree — and fails the build if the old
  pattern reappears.
