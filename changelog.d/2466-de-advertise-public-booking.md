- **Nothing on the public site advertises a booking a non-member can just make
  (#2430).** Three changes, one point: the club's public pages should not read
  like a commercial lodge taking bookings off the street.

  **The header button names its audience.** A visitor who is not signed in now
  sees **Member booking** where it used to say **Book Now**. Pressing it never
  did give them a booking — the booking flow opens the member login, and a
  club-chosen content page is only ever a page to read — so the old wording
  promised something the button could not deliver. A signed-in member still sees
  **Book Now**, because for them it is one click to the booking page. Desktop
  header and mobile drawer take the same label from one place, so they cannot
  drift apart, and the label follows the *visitor*, not the destination: an
  anonymous visitor sees it even when an admin has pointed the button at a
  content page of their own.

  **The button now ships switched off.** A fresh install advertises no public
  booking button until an admin ticks **Show the Book Now button** under
  **Admin → Setup & Configuration → Site Appearance & Content → Page Content**.
  The migration changes a column default and writes no rows, so the shipped
  default governs only a club with no stored public-content settings at all —
  there the button disappears on upgrade, which is the intended direction and
  one click undoes it. Any club that already has that settings record keeps
  what the record says. Worth knowing which you are, because the record is not
  created only by the panel above: saving the **Club Contact** panel creates it
  too, and the button's column then silently takes whatever default was in force
  at that moment — so some clubs are advertising the button today without anyone
  having chosen to. Every operator gets the same one-line instruction in
  `docs/UPGRADING.md`: open that panel once and set the box deliberately.

  **The bumped-booking email stops sending non-members to a login they cannot
  use.** When the lodge fills with member bookings and a provisional booking is
  bumped, the notice used to end in *Book Again → /book* for everyone. But that
  message also reaches the organisation or school contact whose booking came
  from a public booking request, and those contacts have no login at all — the
  link could only ever land them on a sign-in screen. The built-in wording now
  ends in a caption and destination chosen for the reader: a club member still
  gets **Book Again** to the member booking flow, while a contact who cannot
  sign in gets **Contact the Club** to the public contact page. Both readers now
  also get the club's support address, as most other built-in messages already
  offer — a club's Contact page need not carry a contact form, and a reader with
  no login should never be left without a way to reply. Saved wording of your
  own is left completely alone, as always — if you have customised **Booking
  Update**, `docs/UPGRADING.md` explains the lines worth updating.
