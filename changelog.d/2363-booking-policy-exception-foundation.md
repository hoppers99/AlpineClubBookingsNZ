- **Minimum-stay rules now say what happens to capacity during a review, keep a
  revision so two admins cannot overwrite each other, and are applied on every
  way a member commits to nights (#2363).** When you add or edit a minimum-stay
  rule you now choose explicitly whether a future exception request holds the
  requested beds while the club decides, or holds nothing until it is approved.
  Existing rules keep holding capacity. Each rule also carries a revision: if
  another admin or a config import saved first, your out-of-date save is refused
  and the current rule is reloaded for you instead of quietly overwriting theirs.
  Your published booking-rules page states the choice in plain language.

  The rule itself is now enforced everywhere a member commits to nights, not
  just when they make a new booking: changing the dates of an existing booking,
  joining a group booking, and a non-member signing up through a group's public
  link are all checked. The public sign-up is checked twice — when they ask to
  join and again when they click the confirmation email — so a rule you tighten
  in between is honoured, and nothing is booked or charged if it now fails.
  Admins and booking officers are never blocked, including when they book or
  edit on behalf of a member.

  When a member is stopped, they are told which rule and which nights, rather
  than a general "couldn't save" message.
