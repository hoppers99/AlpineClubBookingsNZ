- **The public school-group booking page is now a full, editable website page
  with a menu link.** Like the booking-request page, `/school-bookings` used to be
  a fixed, code-only page. It is now a database-backed built-in page with the same
  makeup as the membership Apply page: it has a header band (so your site-style
  hero image applies), it appears in the site navigation, and you can edit its
  heading and surrounding copy under **Site Appearance & Content → Page Content**.
  Its body is the new `{{school-bookings}}` content token, which renders the
  school-group request form. Because the club, footer, and confirmation emails link
  to it, the page cannot be hidden or deleted, and its address stays
  `/school-bookings`.

  The email link a school contact receives to confirm their attendee list keeps
  its existing URL and stays out of search results. Existing sites gain the
  editable, listed page automatically on upgrade, and the form itself works exactly
  as it did.
