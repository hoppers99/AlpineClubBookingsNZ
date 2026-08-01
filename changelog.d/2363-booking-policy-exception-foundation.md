- **Minimum-stay rules now say what happens to capacity during a review, keep a
  revision so two admins cannot overwrite each other, and are applied on every
  way a member commits to nights (#2363).** When you add or edit a minimum-stay
  rule you now choose explicitly whether a future exception request holds the
  requested beds while the club decides, or holds nothing until it is approved.
  Existing rules keep holding capacity. Each rule also carries a revision: if
  another admin or a config import saved first, your out-of-date save is refused
  and the current rule is reloaded for you instead of quietly overwriting theirs.
  Two rules that are both switched on in the same place can no longer share a
  name: the save is refused and asks you to pick a different one, because a
  configuration transfer identifies a rule by its name and could not tell them
  apart. (A rule you have deactivated does not block the name, but if you later
  export your settings while both exist, the export now tells you which two rules
  clash and asks you to rename one, instead of failing with no explanation.)

  The rule itself is now enforced everywhere a member commits to nights, not
  just when they make a new booking: changing the dates of an existing booking,
  joining a group booking, and a non-member signing up through a group's public
  link are all checked. The public sign-up is checked twice — when they ask to
  join and again when they click the confirmation email — so a rule you tighten
  in between is honoured, and nothing is booked or charged if it now fails.
  Admins and booking officers are not blocked when they book or edit on behalf
  of a member. An admin making a booking for themselves is held to the rule like
  any other member, which is how it already worked.

  It is not applied when nothing about the stay's nights changes: adding a guest
  or fixing a name on a booking that already sits outside a rule still saves, so
  a rule added after a booking was made never leaves a member stuck.

  Accepting a waitlist offer is now checked too, including an offer for a
  different lodge, which has its own rules. If the rule no longer allows those
  nights, nothing is booked or charged and you keep your place on the waitlist.

  When a member is stopped, they are told which rule and which nights, rather
  than a general "couldn't save" message.
