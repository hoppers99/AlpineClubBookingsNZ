- **Diagnostics questions now carry what you are actually looking at (#2816).**
  Asking from the bookings, waitlist, payments or members lists sends the filters
  that list is really using — the status, the date window, the search — so "why am
  I not seeing this payment?" can be answered with your view in hand.

  What it sends is the filtering the page **applied**, not what the address bar
  shows, and on these screens the two often differ. The payments list defaults to
  the last three months of activity without putting anything in the address, and
  that window is the commonest reason a payment is missing from the screen. The
  bookings list drops its whole filter set if one value in the address is
  malformed, while still displaying them. The members search only counts once you
  stop typing. In each case Diagnostics is now told what the list did, not what the
  address claimed.

  **Your typed search text travels with the question**, and the Diagnostics panel
  says so in a line above the box. The two tick boxes are unchanged and do not
  cover this — they govern reading a record's personal details and searching for
  people, not the filters on the screen you are standing on. Every page is still
  limited to its own registered list of filters; anything else is dropped before it
  reaches the assistant.
