- **Adult-member hosting checks are preserved when duplicate member records are
  merged (#2597).** A booking or membership update that records a hosting check
  at the same time as a Full Admin merges the affected member now either saves
  with the correct surviving member or asks the operator to reload and retry.
  The database transaction containing the update and its hosting obligation rolls
  back on that retry. Any earlier phase that already committed remains intact and is
  identified by the response's recovery metadata instead of being reported as undone.

  Existing officer override reasons remain attached to their original work, and
  restoring active cover continues to clear the incident without changing the
  dependent booking's accepted status. Notification delivery and its existing
  at-least-once retry behavior are unchanged.

  The retry message now stays visible and is announced on the affected booking
  approval, public-request, member draft-confirm, admin waitlist force-confirm,
  payment, and Xero admin actions. Draft and waitlist confirmation controls always
  recover after a network or unreadable response; because that response may have
  been lost after the write, the message tells the operator to reload and verify
  status before trying again. A post-capture create
  or saved-method failure returns the privacy-safe
  `PAYMENT_RECEIVED_STATUS_UNCONFIRMED` 409 with only `paymentReceived` and
  `bookingStatusUnconfirmed`; the payment UI suppresses retry and focuses its
  permanent alert without exposing a provider id or claiming finalisation. If
  Stripe reports an existing successful transaction before its refund history can
  be verified, the UI instead reports the net status as unknown and blocks another
  payment; initialization also preserves cancelled/refunded recovery outcomes.

  Xero create, link, unlink, and import now report the exact irreversible phase
  that completed even when later local processing fails. The response exposes only
  proven facts (for example provider contact created, canonical link committed, or
  cleanup/refresh pending), never raw provider/database detail. Member detail,
  member list/editor, Contact Sync, and diagnostics reload or reflect canonical
  state, suppress duplicate/destructive retry, and keep a focused recovery warning
  visible through loading or refresh failure until the operator acts.

  Every host-standing fan-out now fences its subject member before reading
  attendance, including deactivation, archive, cancellation, subscription and
  account-deletion changes. Booking-request holds lock and freshly re-check their
  exact linked members after the lodge lock. A hold that wins makes the standing
  change retry and include it; a standing change that wins makes the hold refuse
  the inactive member before creating any booking or guest, even where hosting is
  disabled or review-only.

  Xero contact creation now commits a short member-row reservation before calling
  Xero, while the provider call remains outside every transaction. Member merge
  refuses while either participant has that exact active reservation or strict
  unresolved proof that Xero created a contact whose local link failed. Once Xero
  creates the contact, the durable pending-link marker is written before linking,
  so even a later failure-recorder outage cannot make the next member reload offer
  another Create action. If both local proof recorders fail, the exact operation
  remains an ambiguous create-in-progress fence without claiming that Xero created
  anything. That ambiguous state now hides every Xero write and leaves only
  **Try again**; the stronger provider-created/pending-link state still offers
  **Link to Xero** as its explicit repair. The server also serializes manual Link
  against create: create-first refuses Link with a safe 409, while link-first
  makes create re-read the committed link and stop before calling Xero. Resetting
  either stale reservation to failed preserves its recovery state and merge
  blocker. A local link, terminal success, or explicit resolution removes the
  blocker; an ordinary terminal failure clears the ambiguous state.

  Account deletion now participates in that same contact fence. A contact create
  or manual Link that wins first makes deletion stop with actionable recovery;
  deletion that wins first makes every waiting create, manual Link, or local-link
  phase refuse the anonymised member before another provider call or attribution.
  Manual Link also commits the member pointer and canonical CONTACT ledger row in
  one transaction, so member merge cannot leave a dangling Xero link. Deletion
  errors distinguish a proven pending cancellation, an already committed
  cancellation with later cleanup pending, and a status that could not be
  confirmed; already committed cleanup facts remain visible even if the final
  last-admin guard blocks anonymisation.

  Approving an account-deletion request now takes ownership of that decision
  before it cancels anything. An approval cancels the member's future bookings
  one at a time and only anonymises them at the end, so previously a second
  administrator could still reject the request in the middle — leaving it marked
  **Rejected** even though the member's stays had already been cancelled. The
  request now moves to **Approval in progress** before the first cancellation,
  and from there only the approval can complete; rejection is refused with the
  usual "already reviewed" conflict. An approval interrupted by a crash, a lost
  connection, or a blocked final step can be picked up and finished, because
  starting it again resumes the same claim instead of being turned away.

  A request in that state stays in the pending queue, the dashboard count and
  the admin badge, shows an **Approval in progress** label, and offers only
  **Resume approval** — there is no Reject button that could only fail. It also
  continues to block a member merge and to stop the member lodging a second
  deletion request, both of which previously treated a half-finished deletion as
  though it were settled.

  If a deletion review's result never comes back — the connection drops, or the
  server answers with something the page cannot read — the page no longer leaves
  **Approve** and **Reject** live on that row. Because the request may already
  have been recorded and may already have cancelled bookings, the page now says
  the outcome could not be confirmed, reloads the queue from the server, and
  asks the administrator to check the request's current status rather than
  offering a retry that could act twice. The same protection covers the
  admin-initiated permanent-delete queue on that page.
