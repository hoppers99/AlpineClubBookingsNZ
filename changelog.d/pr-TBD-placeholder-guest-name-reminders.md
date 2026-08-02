- **The club now chases bookings that still say "Guest 1" and "School Child 2"
  before anyone arrives (#2550).** Two kinds of booking are created from a
  headcount rather than a list of names: a school or organisation trip, and a
  member's whole-lodge booking. Until somebody fills the names in, that is what
  the lodge chore list and arrival roster print — "School Child 1, School
  Child 2" — which is confusing up at the lodge and hard to spot in advance.

  School bookings already got a nudge; member whole-lodge bookings got nothing
  at all. They do now. Starting the same number of days before check-in as the
  school prompt (the **School Attendee Confirmation** timing under **Admin →
  Booking Policies → Public Requests**), the member is emailed a plain-English
  reminder asking who is coming, repeated on the same reminder interval and
  escalating to once a day from two days out, with a last reminder on the
  morning they travel. It stops the moment every guest has a real name. School
  bookings keep their existing tokenized confirmation email and cadence exactly
  as they were.

  Alongside it, **Stuck States** gains a **Bookings with unnamed guests** row
  covering both kinds of booking, so an admin can see what is coming and fix it
  from the booking. The row is honest about who is being chased: a school list
  the contact already confirmed while leaving the placeholder names in place,
  and a booking still held for approval, get no reminder, so they are there for
  an admin to work through by hand. Renaming a guest keeps the same guest
  record, so chore and bed assignments follow the new name, and it never changes
  anybody's age group or what the stay costs.

  **This never holds anything up.** An unnamed party is chased and made visible,
  never blocked: the booking confirms, the roster generates, and the group
  checks in exactly as normal whether or not the names ever arrive — a
  last-minute substitution must not be stranded at the lodge over a name. The
  new `placeholder-guest-name-reminders` job appears on **Background Jobs** with
  the rest of the three-hourly cycle, and re-running it never sends twice.
