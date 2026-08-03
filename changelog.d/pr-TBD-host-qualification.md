### Added

- Adult-member hosting is now two settings instead of one. **What happens** when a
  non-member guest has no adult member cover is chosen separately from **which
  adult members count**, and each has a club-wide default with a per-lodge
  override that carries an explicit "inherit the club-wide choice" option. A lodge
  with a custodian can therefore switch the requirement off while an unattended
  lodge enforces it (#2569).
- A third consequence, **stop the booking unless it is corrected or an exception is
  approved**. A booking that would breach it is refused with a 409 rather than
  made, and the member is offered the existing Booking Officer exception door: add
  adult member cover, change the guests or dates, choose another lodge, or ask for
  an exception. An exception request for a new booking holds no beds, so capacity
  is checked again when it is approved (#2569).
- The Adult Member Hosting settings card now shows what is actually in force at the
  selected scope — whether each of the two settings is inherited or overridden, the
  effective values, and a plain-English preview of the resulting policy.

### Changed

- Nothing moves for an existing club. Disabled stays disabled, "send it to an
  admin to review" stays exactly that, the member-facing review sentence is
  unchanged to the byte, and the only adult members who count remain those staying
  on the same booking. The enforced consequence is never selected by the upgrade
  and has to be chosen deliberately (#2569).
- School and organisation bookings are explicitly excluded from the new
  consequence: their hosting hazard is still recorded for a Booking Officer, but
  the booking is never stopped by this policy (#2569).
