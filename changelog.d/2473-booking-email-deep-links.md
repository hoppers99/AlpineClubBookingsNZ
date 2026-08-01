- **Booking emails now open the booking they are about without exposing a
  private link to the wrong reader (#2362).** Signed-in booking owners, linked
  members, and staff with booking-view access can follow **View this booking**
  straight to the booking detail page. Public contacts and aggregate operator
  emails do not receive that authenticated link, while their existing secure
  payment, quote, consent, and response links continue to work.

  Clubs can use the optional `{{bookingUrl}}` chip in concrete-booking email
  templates. Existing saved wording is not rewritten, unauthorized recipients
  get no dangling link label, and failed-delivery retries recheck both booking
  access and the member's current direct or inherited mailbox before sending.
