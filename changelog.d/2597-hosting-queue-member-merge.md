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
  approval, public-request, payment, and Xero admin actions. A post-capture create
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
  anything. Resetting either stale reservation to failed preserves its recovery
  state and merge blocker. A local link, terminal success, or explicit resolution
  removes the blocker; an ordinary terminal failure clears the ambiguous state.
