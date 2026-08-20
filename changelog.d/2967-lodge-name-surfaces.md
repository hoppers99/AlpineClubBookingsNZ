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

  Review of that third fix turned up something worse on four *other* screens that
  show the same admin-written messages: the payment page, the payment choices in
  the booking flow, the group-join panel and the organiser's group-settlement
  card each filled in the payment reference and printed every other merge field
  as literal text — so a club that wrote `{{CLUB_LODGE_NAME}}` into a payment
  message put those characters in front of a member. All four now fill in every
  field, from the lodge that booking (or, in the booking flow, the lodge the
  member has selected) is actually at. A field with no value for that booking
  comes out blank; braces never reach a member.

  The fourth surface is for whoever reads the finance dashboard. Its "Rest of
  Season" forward window read every lodge's seasons regardless of the Lodge
  (occupancy) selector, so one lodge's season could quietly set another lodge's
  date range with nothing on screen saying which. It now follows that selector on
  the two views that show it — Bookings and Pricing sensitivity — and pick a lodge
  with no season configured and you get the existing "configure seasons" warning
  instead of another lodge's dates. The accounting views (P&L, cash, balances)
  stay club-wide, as they always have, so a lodge left in the address bar by an
  earlier submit cannot set a range on a page with no lodge selector to explain
  it. Left on All lodges at a club with more than one, the window names the lodge
  the winning season belongs to; a deactivated lodge's seasons are left out
  entirely, since that lodge is absent from the selector too.

  A club with one lodge sees no change to the finance dashboard's wording, and
  none of these screens change for a club whose booking messages are the shipped
  defaults — none of those mention a lodge.
