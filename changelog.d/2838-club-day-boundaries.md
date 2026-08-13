- **The lodge surfaces now appear on the days they were always meant to
  (#2838).** A member with a paid booking, and a hut leader with an assignment,
  are both supposed to get the lodge view from the day BEFORE they are due —
  the evening before you drive up is exactly when you want the instructions.
  That day-before access had never actually worked. Every one of these windows
  was running a day behind, so members and hut leaders got the surface on their
  first day rather than the day before, and then kept it for a day after their
  stay or assignment had already ended.

  What changes for a member: the lodge buttons now appear the day before
  check-in and disappear at the end of the check-out day, instead of appearing
  on the check-in day and lingering through the following day. A hut leader
  sees the same shift — the day before the assignment starts, through to the
  last day of it. A single-day hut-leader assignment still grants access on the
  day itself, and now also on the day before, which is what the rule always
  said.

  One smaller change on the same page: a stay that began yesterday no longer
  counts as an "Upcoming Booking" for one extra day.

  For an administrator, the age-tier settings screen counted a guest whose stay
  ended yesterday as still staying, which could refuse a tier removal for a day
  longer than necessary. It never allowed a removal it should have blocked, and
  the cut-off is now the day it says it is.

  The cause was the same in all three places: "today" was being worked out from
  the server's clock rather than from the club's calendar, and the two disagree
  by a day for the whole of every New Zealand day.
