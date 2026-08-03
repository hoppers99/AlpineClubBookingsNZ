- **A deploy now proves the new version of the site works before members are sent
  to it (#2566).** Until now, switching the website over to a new release was done
  as soon as the new copy reported itself healthy. "Healthy" only meant it had
  started up and could reach the database — nobody had actually opened a page on it.
  The first real visitor after every deploy was the one who found out whether the
  home page, the join pages, the contact page and the club's information pages
  worked, and they also paid the slow first load of each one.

  The deploy now opens every one of those pages on the new copy first, checks the
  answer, and only then moves the public address across. For the information pages
  an admin writes in Page Content it goes further and confirms the page was really
  kept ready to hand out again, rather than just accepting that it loaded once.
  Because the pages are already built by the time the switch happens, the first
  member to visit after an upgrade gets a fast site instead of the slowest one of
  the day.

  If one of the club's main pages fails — an error, a missing page, an unexpected
  redirect, or a page that loads but was never kept — the deploy stops before the
  switch and leaves the old version serving. Nothing members can see has changed at
  that point, so it is a halted upgrade rather than an outage: the deploy log names
  the exact address and what came back. One isolated failure on a single content
  page is allowed through so that a deploy is not held up by one broken page, but
  only within a deliberately narrow allowance (at most one page, and at most a
  tenth of the club's published pages, so a club with fewer than ten pages allows
  none). When that happens the deploy is labelled as finished with a warning and
  the failing page is printed for follow-up rather than passed over quietly.

  Both copies of the application that can serve the public site are warmed, not
  just the new one, because the second copy takes over if the first ever stops
  answering — a warm site with a cold understudy is only half the improvement.

  A club whose site setup is not finished yet is skipped rather than blocked; there
  are no public pages to open until the site is launched. `DEPLOYMENT.md` sets out
  the whole gate, the settings that adjust it, and what to do when it refuses.
