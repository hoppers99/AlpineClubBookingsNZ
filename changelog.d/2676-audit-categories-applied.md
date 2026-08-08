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

  **A few of them also stop appearing where they used to**, so that list is not
  purely arrivals. An entry with no category is placed by guesswork on its name,
  and that guess can file one entry under several Category filters at once; an
  entry that carries a category answers to that filter and to "All", and to
  nothing else. So card payment results on a booking move out of **Bookings**
  into **Payments**; password resets, setup invites and bulk role changes move
  out of **Account** into **Security**; clearing a delivery suppression moves out
  of **Account** into **Communication**; credit adjustments, dependant links and
  unlinks, and deletion requests and the decisions on them stop doubling up under
  **Account**; and a login-holder swap stops doubling up under **Security**.
  Nothing became unreadable — every one is still returned by "All" and by its own
  category — but the practical effect is worth knowing: on one member's own
  activity list the Bookings filter will show their older payment results and not
  their newer ones, which is the same kind of event filed correctly rather than
  an entry going missing.

  **How long these entries are kept has changed, deliberately.** An entry recorded
  with no category also got no retention class and no expiry, so all eighty-two
  kinds were kept indefinitely. New entries of those kinds are now classified
  `critical` and expire seven years after the event — the longest class the
  platform has, and the same one a booking or payment entry already gets. Nothing
  is removed sooner than seven years from now because of this, and entries already
  in the database are untouched.

  **What that means for a deletion decision, stated exactly rather than
  dramatically.** Expiry here is deletion, not filing, so at seven years the
  activity entry recording an approved erasure is gone. The deletion request
  itself is not: approving one anonymises the member's own record in place rather
  than deleting it, so the request stays on file — which member asked, that the
  club approved it, and when — with no expiry of its own. What only the activity
  entry holds is the administrator's IP address, how many future bookings the
  erasure cancelled, and which family links it detached; and, where the approval
  had no bookings to cancel, who approved it, because that case records the
  outcome on the request without stamping the reviewer on it. If the club wants
  that entry kept permanently it is a deliberate one-line change, and it has been
  left for the club to make.

  **Twenty-six of those kinds now also appear on a member's own activity list**,
  because that list is chosen by category too. Almost all of them are club-wide
  rules recorded against the administrator who made the change, so the only list
  they reach is that administrator's own. Two reach an ordinary member and both
  are about that member: an issue report appears for whoever filed it, and a
  change to a member's billing family appears for the member it was made for.
  Neither of those two normally shows the stored details: both record their
  payload as structured data rather than as a sentence, and a member's view drops
  structured data entirely. The one exception is size — an issue report records
  the page address and title the member was on, and a page address long enough to
  push that past the platform's 1000-character clip stops reading as structured,
  so the clipped text is shown. What it shows the member is their own page
  address and title, so nothing travels that should not, and the billing-family
  entry is nowhere near the limit. A member's view never shows the request ID,
  the IP address or any drill-down link for any entry. It does name who acted,
  unless that person is a Full Admin, who is shown as "Club admin". Nothing
  stopped being visible to anybody, though some entries now answer to a different
  Category filter, as described above.

  **Two entries were being recorded in a way that skipped the platform's own
  safeguards** — linking and unlinking a dependant wrote to the activity table
  directly, so those entries got no redaction of sensitive values and no retention
  handling at all. They now go through the same path as every other entry, still
  inside the same database transaction as the change they describe.

  **Entries recorded before this release still have no category** and are still
  invisible to AI Diagnostics. Filling those in is a separate change, reviewed on
  its own, and it has not happened yet. Until it does, an empty AI Diagnostics
  result means "look in Admin → Audit Log", never "it did not happen".
