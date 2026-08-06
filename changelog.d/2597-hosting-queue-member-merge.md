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
  approval, public-request, payment, and Xero admin actions. Multi-phase recovery
  is reported truthfully: a captured card payment remains pending finalisation,
  while a Xero contact whose local member and link were already created is kept
  selected and directed to subscription-history repair rather than imported twice.

  Account deletion also fences the member row before it freezes hosting fan-out.
  An officer capacity hold that is adding the same member now either commits first
  and is included in deletion's recheck, or waits and re-evaluates the inactive
  member instead of leaving an active held booking recorded as covered.
