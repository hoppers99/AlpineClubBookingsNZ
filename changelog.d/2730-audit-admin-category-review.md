- **Bed-allocation records are no longer split in half by who performed them, so
  AI Diagnostics can return the whole night from here on (#2730).** The activity
  records the club keeps carry a category that decides which permission somebody
  needs before AI Diagnostics will show them the event. Bed allocation was filed
  two different ways: the automatic moves the platform makes when a booking
  changes were filed under **Lodge**, and the manual, bulk and range allocations
  an administrator performed were filed under **Admin**. The same event, filed by
  who started it.

  What that cost a real person: a Lodge Manager asking what happened to the beds
  on a night got the automatic changes, none of the manual ones, and a reply
  saying nothing else matched — which reads as "nothing happened", not "I only
  looked at half of it". Somebody with Support access alone got the opposite half
  with the same false confidence.

  **All bed-allocation activity is now Lodge**, along with the lodge display
  configuration, which was the last display setting still filed under Admin while
  layouts, templates and devices had already moved.

  **Who needs Lodge access now and did not before.** Two groups, and the second
  is the one that matters most: anyone holding **Support access alone**, and a
  **Booking Officer holding Support and Bookings but not Lodge** — the person who
  actually performs these allocations, because the bed-allocation screens are
  gated on Bookings rather than Lodge. A Booking Officer can still make every
  allocation and still read the whole record in Admin → Audit Log, but will no
  longer see their own allocations through AI Diagnostics without Lodge access
  too. Nothing became visible to anybody who could not already see it, no entry
  is now shown to members, and nothing is kept for a different length of time.

  **What you may notice in Admin → Audit Log.** The screen itself is unchanged:
  it still shows every entry to anyone with Support access. The **Category
  filter** does change, and not only for new entries — an entry keeps the
  category it was given when it was written, and this release does not rewrite
  the ones already recorded. So bed-allocation history is **split by date**:
  filter by **Lodge** for entries recorded from this release onwards, by **Admin**
  for the older ones, and **clear the filter** to see the whole run. In AI
  Diagnostics the split disappears about a week after the release, because the
  widest correlation window there is seven days. Reclassifying the older entries
  so both halves sit together is a separate reviewed change, filed as #2751.

  The other 96 Admin entries were read one at a time in the same pass: 87 were
  deliberately kept with the reason written down for whoever looks next, and nine
  are held for a decision, because filing them where they arguably belong would
  make them visible to the member they are about. Those nine are the member
  hard-deletion and archive decisions, the two family-suggestion entries, and an
  administrator's edit to one member's record.
