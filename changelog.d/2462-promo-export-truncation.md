- **A capped promo-code redemptions export now says it is incomplete (#2244).**
  The CSV on **Admin → Promo Codes → [code] → Redemptions** is fetched in one
  request that stops at 10,000 rows. Past that the file simply ended, with
  nothing on screen or in the file to say so — and the privacy audit entry
  recorded a plain row count of 10,000, which read as a complete export of
  exactly that many redemptions. Anyone reconciling discounts from the file, or
  auditing it afterwards, had no way to tell a full export from a cut-off one.

  A cut-off export now announces itself. The download still happens — a partial
  export is more useful than none — but an **Incomplete export** notice appears
  saying how many of how many matching redemptions the file holds and what to do
  instead (narrow the date range, or take one lodge at a time, and export each
  window), and the file is named `…-partial.csv` so the shortfall travels with
  it. The audit entry records the same thing: the rows exported, the rows that
  matched, the cap, and whether it was truncated. An export that matched exactly
  10,000 rows is complete and is not flagged. The CSV contents are unchanged —
  no warning row was added, because that would break every spreadsheet and
  parser that reads it. The notice belongs to the filter that produced the file,
  so changing a filter — or clicking **Reset** — clears it rather than leaving it
  quoting a count that no longer matches what is on screen; from then on the
  file's own `-partial` name is what carries the shortfall.

  Two smaller corrections ship alongside. Editing a calendar event that somebody
  else deleted a moment earlier now reports **Event not found** instead of a
  server error — both the single-occurrence edit and the whole-series pattern
  rebuild were missing that mapping. And `docs/DOMAIN_INVARIANTS.md` no longer
  describes the public committee endpoint as uncapped: it carries a
  500-assignment backstop, far above any real committee, which the document now
  states along with why it does not narrow the member-photo rule.
