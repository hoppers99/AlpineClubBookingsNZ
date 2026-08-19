- **Four more screens now name the lodge a booking is actually at, rather than
  the club's default one (#2919).** A club running more than one lodge saw the
  wrong property named in several places. In each case the booking's own lodge
  was never carried through to the screen, so the copy fell back on whichever
  lodge is flagged as the default.

  Three of them a member reads directly: the payment page's "your booking with
  … is confirmed" line after paying, the group-join email-confirmation page's
  "finalise your spot at …", and any booking message a club has written with
  `{{CLUB_LODGE_NAME}}` in it. That last one was the most confusing, because the
  preview beside the message editor showed a lodge name while the member was
  sent a blank — the live page supplied no value for the token at all. The same
  page had the same gap for `{{CLUB_NAME}}`, `{{BASE_URL}}` and
  `{{SUPPORT_EMAIL}}`, which are now filled in too. The preview still shows your
  default lodge, because it has no real booking to read; that is a sample
  standing in, and the guide now says so.

  The fourth is for whoever reads the finance dashboard. Its "Rest of Season"
  forward window read every lodge's seasons regardless of the Lodge (occupancy)
  selector, so one lodge's season could quietly set another lodge's date range
  with nothing on screen saying which. It now follows that selector like every
  other booking figure on the page; pick a lodge with no season configured and
  you get the existing "configure seasons" warning instead of another lodge's
  dates. Left on All lodges, the window names the lodge the winning season
  belongs to.

  A club with one lodge sees no change on any of the four.
