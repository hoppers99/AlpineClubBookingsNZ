- **Booking dates now stay put no matter where in the world a member books from
  (#2474).** When someone picked check-in and check-out on the booking calendar
  or the admin "book on behalf" screen, the chosen nights were held internally as
  a moment in time in the member's OWN device timezone rather than as plain
  calendar days. On its own that read correctly, but it was one careless step
  away from naming the wrong night — an earlier fix (#2264) had already had to
  patch four screens that showed the day before or after the one being booked to
  a member abroad, and any new date-handling code carried the same risk.

  The calendar, the member booking wizard, and the admin booking screen now carry
  each lodge night as a plain New Zealand calendar date from start to finish, so
  the night submitted, the night shown on screen, the number of nights, and the
  provisional-hold deadline all name the same day for a member booking from
  Auckland, from a timezone behind New Zealand, or from one ahead of it —
  including on the night the clocks change for daylight saving.

  Nothing about availability, pricing, capacity, or how a booking is stored has
  changed — only how the browser carries the dates a member picks before it sends
  them.
