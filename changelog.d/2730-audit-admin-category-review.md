- **Bed-allocation history is no longer split in half by who performed it, and
  AI Diagnostics can finally return the whole of it (#2730).** The activity
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

  **What you may notice.** If you hold Support access only, you could pull
  bed-allocation history through AI Diagnostics before and will now need Lodge
  access as well — the same access you already need for the rosters and arrivals
  those beds belong to. **Admin → Audit Log is unchanged**: it still shows every
  entry to anyone with Support access, and these entries simply appear under the
  **Lodge** category filter instead of **Admin**. Nothing became visible to
  anybody who could not already see it, no entry is now shown to members, and
  nothing is kept for a different length of time.

  The 96 remaining Admin entries were read one at a time in the same pass and
  deliberately kept; the reasons are written down for whoever looks next.
