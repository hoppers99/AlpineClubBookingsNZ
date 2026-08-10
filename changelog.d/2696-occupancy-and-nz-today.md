- **The nightly "lodge is nearly full" alert now counts everything that is
  actually taking up a bed (#2681).** The alert that emails administrators when a
  lodge is filling up worked out its own bed count instead of using the club
  system's main capacity calculation, and over time the two drifted apart. Three
  things the booking screens counted, the alert did not.

  It did not count beds a *held* policy-exception request has provisionally
  reserved, so a lodge could be close to full with nobody being told. It had no
  idea about exclusive whole-lodge holds, so a small group booking out an entire
  lodge never triggered the alert — the lodge was unbookable and looked nearly
  empty. And for a guest staying non-consecutive nights it fell back to their
  first and last night, counting them as present on the nights in between when
  they are not there, so the alert could also speak about a night that was free.

  Nothing an administrator does changes. The booking screens, the calendars, the
  member availability and the over-capacity confirmations all behave exactly as
  they did; only the nightly alert's numbers move, and only towards the truth.
  One smaller fix rides along: the confirmation shown when a hut-leader bed hold
  would push a lodge past its ceiling was also missing the held-request beds, so
  it could stay silent when the hold really did tip the lodge over. It now
  counts them.

- **Dates on the public booking forms and the finance screens now follow the New
  Zealand day, not the UTC day (#2682).** New Zealand is twelve to thirteen hours
  ahead of UTC, so for roughly the first half of every New Zealand day, "today"
  in UTC is still yesterday here — and a number of places in the system worked
  today's date out the UTC way.

  Four of them mattered. The public *Request to Book* and *School Booking* forms
  set the earliest selectable night from that date, so anyone filling one in
  before about midday was offered a night that had already started — the club
  system then refused it, on the club's own public pages. Two finance figures
  (the "as at" cut-off deciding which stays count as realised) had the same
  problem, so a treasurer reconciling in the morning saw a different day's
  numbers than they would that afternoon, with nothing having changed in between.

  The rest only stamped a date onto a downloaded file's name or a date-of-birth
  field's upper limit, and they are converted too. The profile page's
  date-of-birth limit brought a small companion fix with it: the club system used
  to refuse today's New Zealand date as "in the future" all morning, so the date
  the form offered was a date it would then reject. It is accepted now.

  Treasurers pulling the legacy finance export on an automatic overnight schedule
  will see its "as at" label step forward one day, once, on the day this ships.
  That is the correction, not a new drift.
