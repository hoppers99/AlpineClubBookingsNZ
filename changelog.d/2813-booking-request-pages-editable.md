- **The booking-request and school-booking pages are now editable website
  pages, and you can choose whether to advertise them (#2818).**
  `/booking-requests` and `/school-bookings` used to be fixed pages built into
  the code, with wording nobody at the club could change. They are now ordinary
  pages under **Site Appearance & Content → Page Content**, so you can edit the
  heading, the introduction and the copy around each form. The forms themselves
  are content tokens — `{{booking-requests}}` and `{{school-bookings}}` — so you
  can also drop either form onto a page of your own. A form you embed elsewhere
  follows that page's privacy behaviour (its analytics and its security token),
  while the dedicated `/booking-requests` and `/school-bookings` pages remain the
  analytics-free, fresh-per-visit entry points.

  **Nothing about who can see them changes when you upgrade.** Both pages arrive
  with an empty menu title, which is what keeps a page out of your site menu and
  tells search engines not to list it — so every existing site keeps the current
  behaviour exactly: the forms stay unlisted, and the club hands the link to a
  guest it has agreed to host. If you would rather advertise a form, give its
  page a menu title. It joins your site menu and becomes searchable at the same
  moment, because both follow that one field, so the menu and the search-engine
  instruction can never disagree with each other. Clearing the menu title
  reverses both.

  The web addresses do not change, so links you have already shared keep
  working, and the confirmation emails guests receive — the address-verification
  link, the quote-response link, and the school attendee list link — keep their
  existing addresses and stay out of search results exactly as before. Google
  Analytics does not load on either form page: they are where a visitor types
  the most personal information, so no page view or address from them is sent
  on.

  One thing to know if your site is not set up yet: while the "Site setup in
  progress" holding screen is showing, those emailed confirmation links answer
  with the holding screen rather than the confirmation page, the same as the
  group-booking verification link has always done. A club that has not finished
  setting up has not sent those emails.

  Existing sites gain the editable pages automatically on upgrade, and both
  forms work exactly as they did.

  Because the club owns the one-time links directly under those two addresses,
  `booking-requests` and `school-bookings` are now reserved words: a content page
  you name with either word in any part of its address (for example
  `trips/booking-requests`) is refused, and if you had one from an earlier
  release it is no longer advertised in your menu or by a Book Now button until
  you rename it. See CONFIGURATION.md → "Website Page Content" for a query that
  finds one.
