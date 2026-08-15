- **The lodge buttons now appear on the days they were always meant to
  (#2838).** A member with a paid booking, and a hut leader with an assignment,
  are both supposed to be offered the lodge view from the day BEFORE they are
  due — the evening before you drive up is exactly when you want the
  instructions. That day-before button never appeared.

  **This is a change to which links are shown, not to who may do what.** The
  lodge kiosk itself was already working out the day correctly, and already
  allowed a member in from the day before their check-in. So a member who typed
  the address in, or followed an older link, got straight through on the day
  before — they simply had no button pointing at it. In the other direction the
  button lingered for a day after check-out, but by then the kiosk turned them
  away, so it was a dead link rather than access they should not have had.
  Nobody loses anything they could actually use.

  What changes for a member: the lodge buttons now appear the day before
  check-in and disappear at the end of the check-out day, instead of appearing
  on the check-in day and lingering (uselessly) into the following one. A hut
  leader sees the same shift — from the day before the assignment starts through
  to its last day. A single-day hut-leader assignment still shows the button on
  the day itself, and now on the day before it as well, which is what the rule
  always said.

  One smaller change on the same page: a stay that began yesterday no longer
  counts as an "Upcoming Booking" for one extra day. That list also feeds the
  "Next Stay" card, so a member whose stay is already under way now sees "No
  upcoming stays" there — with their stay in progress still listed under Recent
  Bookings — a day earlier than before.

  For an administrator, the age-tier settings screen counted a guest whose stay
  ended yesterday as still staying, which could refuse a tier removal for a day
  longer than necessary. It never allowed a removal it should have blocked, and
  the cut-off is now the day it says it is.

  The cause was the same in all three places: "today" was being worked out from
  the server's clock rather than from the club's calendar, and the two disagree
  by a day for the whole of every New Zealand day.
