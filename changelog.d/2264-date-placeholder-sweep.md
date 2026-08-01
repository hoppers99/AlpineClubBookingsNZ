- **Dates and times now always read in New Zealand time, everywhere in the club
  system (#2264).** Most screens already did, but a long tail of them was still
  formatting dates using whatever time zone and regional settings the viewer's
  own computer happened to have. An administrator working from overseas could
  see a booking listed against the wrong night, an operational email could be
  stamped with the wrong date, and the clock on the lodge lobby display showed
  the time wherever the television's browser thought it was rather than the time
  at the lodge.

  Every remaining screen, email and report now goes through the club's shared
  date formatting, which is fixed to New Zealand time and New Zealand date
  style. A safeguard has been added that stops a new screen from slipping back
  into the old behaviour, so this class of problem cannot quietly return.

  A few dates read slightly differently as a result, all in the house style you
  already see elsewhere: operational email timestamps now say
  `17 Apr 2026, 10:30 am` instead of `17/04/2026, 10:30:00 am`; some long-form
  dates shorten from `17 April 2026` to `17 Apr 2026`; and the "last refreshed"
  indicators on the admin status pages no longer show seconds. Nothing about
  which night a booking is for has changed — only how the date is written out.
  Formats that are deliberately different, such as the chore-roster emails and
  the weekday-bearing lodge display boards, are untouched.

- **Form fields now show their example values as a hint underneath, not as grey
  text inside the box (#2264).** Andy's report was that "greyed out text as
  Example text looks like a field is already filled in" — and it also vanished
  the moment you started typing, which is exactly when you still wanted to see
  it. Around ninety fields across the admin, member and public pages have had
  their example value moved out of the box and rendered as a short hint below
  it, so the field itself is visibly empty until you type in it and the example
  stays readable while you do.

  Instructions that genuinely belong inside a box are unchanged — search boxes
  still say what they search, and fields where leaving the box blank means
  something ("Use configured amount", "Unlimited") still say so in place. Where
  the example text had been doing double duty as the field's only name, the
  field has been given a proper label at the same time, so screen readers now
  announce the field name, then any error, then the example.
