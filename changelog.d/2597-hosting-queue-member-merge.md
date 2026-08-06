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
  or saved-method race returns the privacy-safe
  `PAYMENT_RECEIVED_STATUS_UNCONFIRMED` 409 with only `paymentReceived` and
  `bookingStatusUnconfirmed`; the payment UI suppresses retry and focuses its
  permanent alert without exposing a provider id or claiming finalisation. A Xero
  contact whose local member and link were already created is reloaded and kept
  selected, duplicate creation is suppressed, and the officer is directed to
  Member Status Repair for the pending subscription refresh. Link recovery keeps
  its may-have-changed metadata, while collapsed Contact Sync and network errors
  remain visible without discarding drafts.

  Every host-standing fan-out now fences its subject member before reading
  attendance, including deactivation, archive, cancellation, subscription and
  account-deletion changes. Booking-request holds lock and freshly re-check their
  exact linked members after the lodge lock. A hold that wins makes the standing
  change retry and include it; a standing change that wins makes the hold refuse
  the inactive member before creating any booking or guest, even where hosting is
  disabled or review-only.
