- **Adult-member hosting is now two settings instead of one, and one of them can
  stop a booking (#2569).** What happens when a non-member guest has no adult
  member cover is chosen separately from which adult members count, and each
  setting has a club-wide default with a per-lodge override that carries an
  explicit "inherit the club-wide choice" option. A lodge with a custodian can
  therefore switch the requirement off while an unattended lodge enforces it, and
  the card shows which of the two settings is inherited, which is overridden, what
  is actually in force, and a plain-English preview of the result.

  **The new consequence is "stop the booking unless it is corrected or an
  exception is approved".** A booking that would breach it is refused rather than
  made, and the member is told which nights are uncovered and offered the four ways
  out: add adult member cover, change the guests or the dates, choose another
  lodge, or ask a Booking Officer to approve an exception. An exception request for
  a new booking holds no beds, so capacity is checked again when you approve it. A
  member refused on a waitlist offer keeps that offer — it is not spent by the
  refusal — and a non-member joining a group booking is simply pointed back to the
  organiser, because there is no account for them to ask from.

  **The exception queue now tells you which of the two happened.** "Adult member
  must host" used to look the same whether the booking had been made and flagged for
  you or refused outright, which are opposite situations — in the second there is no
  booking at all until you approve, and somebody is waiting for a bed. Each request
  now says which, in a sentence, taken from the evidence frozen at the time rather
  than from today's setting.

  **Who counts as an adult member is now a choice.** "An eligible adult member on
  the same booking" is the rule the club has always had and stays the default. The
  new option is **another booking on the same account**: a qualifying adult member
  on another confirmed booking owned by the same member account can cover the same
  lodge and the same nights, which is the split-booking case where a member books
  their family on one booking and their guests on another. It has to be the same
  member account — not the same surname, email address, family group or the
  administrator who entered the bookings — and the covering person has to be
  genuinely attending on that exact night at that exact lodge. The two options are
  independent, so a night counts as covered when either of them covers it, and
  different nights of one stay may be covered differently.

  **Nothing moves for an existing club.** Disabled stays disabled, "send it to an
  admin to review" stays exactly that, the member-facing review sentence is
  unchanged to the byte, and the only adult members who count remain those staying
  on the same booking until you say otherwise. The stopping consequence is never
  selected for you.

  **School and organisation bookings are excluded** from the new consequence.
  Their hosting hazard is still recorded for a Booking Officer to see, but the
  booking is never stopped by this policy — those requests have their own approval,
  organiser and supervision arrangements, and any change to them is a separate
  decision. Everything else a club does is covered, including approving a member's
  whole-lodge request: at a lodge set to stop uncovered bookings, that approval is
  stopped too and the officer is told which rule stopped it, with the request left
  exactly as it was. There is no exception link on that message, because the officer
  reading it is already the person an exception would be asked of.

  **Once "another booking on the same account" is on, a change that would break
  the cover is stopped (#2576).** When one of a member's bookings is relying on the
  adult member staying on another, cancelling that other booking, moving its dates
  or lodge, taking the adult member off it, or losing the member-guest consent that
  put them there, is refused. The member is told which of their own bookings would
  be left without cover, at which lodge, on which nights, and is pointed at the
  three things that fix it: sort the affected booking out first, provide other
  qualifying cover, or ring a Booking Officer. Nothing is written, so their booking
  is exactly as it was.

  It never mentions anybody else's booking — every booking named is on the member's
  own account — and it never stops a change that leaves alternative cover in place.
  If a third booking on the account still has a qualifying adult member on those
  nights, the change simply goes through and nothing is flagged, because the rule
  asks whether cover exists and not whether one particular person is still there.

  **A Booking Officer is asked to confirm rather than refused.** Your change is
  always allowed — you are the authority the member's message points at — but where
  it would leave one of that member's bookings without cover you are shown which
  bookings and which nights, and asked to confirm it and give a reason. Re-submit
  with the reason and the change goes through, recorded against your name so anybody
  reading the history later can see who allowed it and why. Where nothing would be
  left uncovered you are not asked anything, so an ordinary edit is unchanged.

  **The changes nobody can sensibly block are never stopped, and the club gets an
  urgent entry instead.** A membership lapsing, being made inactive, cancelled or
  archived; a payment failing; an automated status change; a group settlement that
  did not complete — all of these are allowed, and each one records the check it owes
  at the moment it happens, so the club is told rather than finding out later. So is
  a self-removal by somebody who is a guest on another member's booking: they are
  never shown that member's other bookings and never asked to fix something that is
  not theirs. What happens instead in every one of these cases is that the affected
  booking stays confirmed and keeps its beds and its payments, nothing is ever
  cancelled automatically, the booking owner is emailed once naming the lodge and the
  uncovered nights, and the booking appears on a new **Bookings without required
  adult member cover** entry on the Stuck States queue. That entry clears itself when
  the problem goes away — cover is restored, the booking is amended, an exception is
  approved, or the booking is cancelled — so there is nothing to tick off. Repeatedly
  re-checking the same unchanged problem does not re-send the email or duplicate the
  entry.
