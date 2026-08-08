- **A club that does not use the adult-member hosting rule no longer pays for it on
  every booking write (#2623).** The reconciler that every booking mutation goes
  through took a `Member` row lock over the booking's owner *before* it checked
  whether the lodge had hosting switched on. At a lodge with the rule `DISABLED`
  that lock did nothing useful, but it could still collide with an officer
  deactivating or archiving that member at the same moment — and when it did, the
  member's ordinary booking change was refused with "the database update could not
  be completed because this booking or member changed… if a payment was involved,
  check its status before retrying". A payment-flavoured refusal, produced entirely
  by a feature the club had turned off. The lodge's setting is now read first and the
  lock is only taken when there is hosting work that could need protecting. A booking
  at a lodge that has since switched the rule off still has its stale review cleared,
  exactly as before.

- **Merging two member records can no longer make everyone else wait for two
  minutes (#2623).** After moving the duplicate's records across, a merge locks the
  member rows of every booking owner its change could affect — up to fifty accounts
  that have nothing to do with either of the two members being merged. It waits for
  those rows rather than giving up instantly, which is right: a merge is
  irreversible and should not fail because someone else was mid-save. But the wait
  had no ceiling other than the merge's own two-minute limit, and while it waited it
  also held the club's hosting-policy lock — so an unrelated booking or guest being
  added could sit behind it for the whole two minutes. The wait is now capped at ten
  seconds; past that, the merge stops with the same "the records changed while the
  merge was running — nothing was saved, re-run the preview" message it already used,
  and everything queued behind it is released. A brief overlap still succeeds.

- **Two internal safety censuses now count things they were silently missing
  (#2623).** The repository keeps executable inventories of every place it locks a
  database row, so a new one has to be classified and reviewed rather than merely
  written. One of them only recognised the strongest kind of lock, leaving six real
  ones — the hosting queue fence, the booking-request member hold, the coverage
  drain, the incident actor lock and both Xero contact reservations — in no inventory
  at all. The other, which checks that every path recording hosting work also
  processes it afterwards, did not know about the merge's own path. Neither gap let
  anything wrong ship; both are now closed, with a test that proves each census
  catches a newly-added site.
