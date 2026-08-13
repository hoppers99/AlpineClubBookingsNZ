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

  **A date window now says which date it bounds.** The bookings list can narrow by
  arrival date or by departure date, and one of its older address shortcuts means a
  different one at each end — so a window sent as "up to the 31st" could be read as a
  departure limit when it was really an arrival limit. Diagnostics is now told
  precisely which, so an answer about a missing booking is about the right dates. A
  filter the assistant would only have thrown away — one longer than the channel
  carries, or one the page's own API refuses — is no longer reported as applied at
  all, because being told nothing is better than being told a filter is not there.

  **Text that tries to impersonate the assistant is defused even when it hides.** A
  filter value, a booking note or a member's name can carry invisible characters or a
  look-alike colon that made a phrase like "assistant:" read as a turn in the
  conversation while staying invisible on screen. Every piece of untrusted text is now
  folded to what a reader actually sees before that check runs, and a question or a
  replayed reply carrying non-printing characters is refused outright.

  **Your typed search text travels with the question**, and the Diagnostics panel
  says so in a line above the box. The two tick boxes are unchanged and do not
  cover this — they govern reading a record's personal details and searching for
  people, not the filters on the screen you are standing on. Every page is still
  limited to its own registered list of filters; anything else is dropped before it
  reaches the assistant.
