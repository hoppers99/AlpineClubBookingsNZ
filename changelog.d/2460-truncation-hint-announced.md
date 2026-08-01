- **"Keep typing to narrow this down." is now read out, not only printed
  (#2460).** Two member searches stop early when too many people match: the
  member-guest finder on the booking screens, and **Link Parent** on a member's
  admin page. Both put that sentence under the list, and neither told a screen
  reader about it — so somebody who had just typed heard the results and then
  nothing, with no way to know the list had been cut short and that one more
  letter was the answer.

  Both screens now announce the sentence the moment it appears. Nothing on
  screen changed: the same words, in the same place, under the same
  circumstances — the hint still appears only when the search really did run out
  of room, and it still never says how many people were left out.

  The two were fixed together on purpose. The admin picker's wording is a
  deliberate character-for-character copy of the booking screens', so fixing one
  alone would have quietly broken the promise that the club says the same thing
  in the same way wherever a member search is cut short.
