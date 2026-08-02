- **Booking Officers, Membership Officers and Treasurers now receive the admin
  alerts for their own area (#2548).** Until now every admin alert email went to
  Full Admins only. A Booking Officer never learned that a member had asked to
  change a booking or requested a booking-policy exception, even though they are
  the person who actions it; a Treasurer was never told a payment had failed or
  that Xero sync had broken. Anyone holding a custom access role received
  nothing at all and could not even be added to the Recipients grid by hand.

  Each alert now belongs to one admin permission area, and it is sent to
  everyone whose access role can **edit** that area. A Booking Officer starts
  receiving the eight booking alerts, a Membership Officer the member-request
  and member-delete alerts, a Treasurer the payment, refund and Xero alerts, and
  a Full Admin continues to receive all fifteen exactly as before. Alerts for
  areas a role cannot edit are never sent to that person — widening the alerts
  someone gets is a matter of widening their access role.

  The **Recipients** page (Notifications & Email → Recipients) now lists every
  admin user rather than just Full Admins, shows each person's role, and greys
  out the alerts that fall outside their areas so it is clear why they are not
  on offer. Nobody's saved preferences were changed. Delivery Rules still sit
  upstream of all of this: a template muted club-wide stays muted for everyone.

  Worth a look after upgrading: open Recipients and check the officers who have
  just started receiving alerts are the people you want alerted.
