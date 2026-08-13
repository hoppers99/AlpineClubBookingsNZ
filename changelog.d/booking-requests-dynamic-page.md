- **The public booking-request page is now a full, editable website page with a
  menu link.** `/booking-requests` used to be a fixed, code-only page that was
  deliberately hidden from the menu and from search. It is now a database-backed
  built-in page with the same makeup as the membership Apply page: it has a header
  band (so your site-style hero image applies), it appears in the site navigation,
  and you can edit its heading and surrounding copy under **Site Appearance &
  Content → Page Content**. Its body is the new `{{booking-requests}}` content
  token, which renders the request-to-book (or request-for-price) form. Because
  the club, footer, and confirmation emails link to it, the page cannot be hidden
  or deleted, and its address stays `/booking-requests`.

  The two email-confirmation links guests receive — the address-verification link
  and the quote-response link — keep their existing URLs and stay out of search
  results, exactly as before. Existing sites gain the editable, listed page
  automatically on upgrade, and the form itself works exactly as it did.
