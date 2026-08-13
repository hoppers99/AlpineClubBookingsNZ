- **Diagnostics questions now carry what you are actually looking at (#2816).**
  Asking from the bookings, waitlist, payments or members lists sends the filters
  that list is really using — the status, the date window, the search — so "why am
  I not seeing this payment?" can be answered with your view in hand.

  What it sends is the filtering the page **applied**, not what the address bar
  shows, and on these screens the two often differ. The payments list starts filtered
  to the last three months of activity before the address says so — that window is
  the commonest reason a payment is missing from the screen. The bookings list drops
  its whole filter set if one value in the address is malformed, while still
  displaying them. The members search only counts once you stop typing, and an age
  tier the system does not recognise filters nothing at all. In each case Diagnostics
  is now told what the list did, not what the address claimed.

  If the list failed to load, Diagnostics is told that instead — so "why is this
  payment not here?" cannot be answered by blaming a filter when the real answer is
  that nothing loaded. And because each page registers only some of its filters,
  Diagnostics is told the filter list it receives is a partial one and must not be
  read as the whole picture.

  **Your typed search text travels with the question**, and the Diagnostics panel
  says so in a line above the box. The two tick boxes are unchanged and do not
  cover this — they govern reading a record's personal details and searching for
  people, not the filters on the screen you are standing on. Every page is still
  limited to its own registered list of filters; anything else is dropped before it
  reaches the assistant.
