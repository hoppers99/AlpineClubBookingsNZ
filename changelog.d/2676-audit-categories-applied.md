- **Every activity record the platform writes now says which part of the club it
  belongs to (#2581).** Eighty-two kinds of entry — booking policies, seasons and
  promotional codes, subscription billing, member credit, fee configuration, Xero
  settings and retries, lodge displays and kiosk accounts, family groups and
  dependant links, membership applications, password resets and setup invites,
  bulk member changes, bulk email, deletion requests and issue reports — used to
  be recorded with no category at all. AI Diagnostics can only search by
  category, so those entries were invisible to it: an administrator asking "what
  did the platform record around this subscription reconcile?" got nothing back
  and no hint that anything was missing.

  From this release every one of them records a category, so new entries turn up
  in the AI Diagnostics tool that matches the work. The Admin → Audit Log screen
  is unchanged and still shows everything to anyone with Support access.

  **Where each kind now sits**, so any of these can be moved back if the club
  disagrees with a call:

  - **Bookings** — booking policies, booking periods, age tiers, seasons and
    promotional codes. A season and a promotional code are booking-eligibility
    rules, so they follow bookings rather than finance. The trade-off accepted: a
    promotional code carries a discount, so that price-affecting history sits
    behind Bookings access rather than Finance access.
  - **Finance** — subscription-billing settings, retries and reconciliation,
    member credit adjustments, fee configuration, saved-card charge results and
    the five Stripe payment outcomes; Xero settings, mappings, replays and
    retries.
  - **Lodge** — display layouts, templates and devices, and lodge kiosk accounts.
  - **Membership** — family groups, login-holder swaps, dependant links and
    unlinks; membership applications and nominations; bulk email and
    delivery-suppression clearances; deletion requests and the decisions on them;
    issue reports.
  - **Support** — sending a member a password reset, sending a setup invite, and
    a bulk role change. These three are about a credential or a permission rather
    than about a mailing, which is why they are filed under security. They are the
    only additions to the Support-only categories, and AI Diagnostics never
    returns the stored details of an entry, so the recipients' addresses those
    entries carry do not travel with them.
  - **Not moved**: an issue report stays under privacy even though Issue Reports
    sits on a Support screen. Matching the screen would have made a member's own
    report readable with Support access alone, which is wider, and it was refused.

  **How long these entries are kept has changed, deliberately.** An entry recorded
  with no category also got no retention class and no expiry, so all eighty-two
  kinds were kept indefinitely. New entries of those kinds are now classified
  `critical` and expire seven years after the event — the longest class the
  platform has, and the same one a booking or payment entry already gets. Nothing
  is removed sooner than seven years from now because of this, and entries already
  in the database are untouched.

  **Twenty-six of those kinds now also appear on a member's own activity list**,
  because that list is chosen by category too. Almost all of them are club-wide
  rules recorded against the administrator who made the change, so the only list
  they reach is that administrator's own. Two reach an ordinary member and both
  are about that member: an issue report appears for whoever filed it, and a
  change to a member's billing family appears for the member it was made for.
  A member's view never shows the stored details, the request ID, the IP address
  or any drill-down link; it does name who acted, unless that person is a Full
  Admin, who is shown as "Club admin". Nothing stopped being visible.

  **Two entries were being recorded in a way that skipped the platform's own
  safeguards** — linking and unlinking a dependant wrote to the activity table
  directly, so those entries got no redaction of sensitive values and no retention
  handling at all. They now go through the same path as every other entry, still
  inside the same database transaction as the change they describe.

  **Entries recorded before this release still have no category** and are still
  invisible to AI Diagnostics. Filling those in is a separate change, reviewed on
  its own, and it has not happened yet. Until it does, an empty AI Diagnostics
  result means "look in Admin → Audit Log", never "it did not happen".
