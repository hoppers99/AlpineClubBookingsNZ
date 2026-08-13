- **"Details last confirmed by ... on" now shows the day the member actually
  confirmed (#2839).** On a family member's card, the read-only line naming the
  adult who last confirmed their details worked out its date from the UTC
  calendar rather than the club's. New Zealand runs 12-13 hours ahead of UTC, so
  for roughly the first half of every club day that date was still *yesterday* —
  a member who confirmed their details at 9am was shown the previous day.

  The date is now derived on the club's calendar, so it reads as the day the
  confirmation was actually made, whatever the time of day.

  Nothing stored changed and nothing was backfilled: the confirmation instant
  itself was always recorded correctly, and only the day shown on that line was
  wrong. Dates of birth on the same cards were never affected — those are
  calendar dates already, not points in time.
