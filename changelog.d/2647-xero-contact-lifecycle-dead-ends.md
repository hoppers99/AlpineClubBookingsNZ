- **Three Xero contact dead ends fixed: a member recovered after a failed Xero
  contact create can be merged and deleted again, "Force sync → Contact" works
  for walk-in owners, and a half-finished unlink now says what is left to check
  (#2623).** Three defects found while triaging the review of the hosting-queue
  work. All are in the seam between a member's Xero contact link and the
  operations ledger that records Xero work.

  **A member who had been put right could still not be merged or deleted.** When
  Xero creates a contact but the club system fails to record the link — a
  timeout at the wrong moment — the member is left needing recovery, and an
  administrator fixes it by finding the contact in Xero and linking it on the
  member's page. That worked, and the member's page then showed a clean, linked
  Xero contact. But the failed operation stayed open behind the scenes, and both
  member merge and account deletion refuse while one is open. So the member
  looked completely fine and yet could not be merged with a duplicate record, or
  deleted on request, with nothing on screen explaining why. The remedy existed
  — marking the operation resolved on the Xero Operations screen — but nothing
  said so, and nothing said which operation was the problem.

  Linking the member now closes that operation, because linking is the very
  thing it was waiting for. It is deliberately careful about it: it only closes
  an operation when the contact Xero created is exactly the contact just linked.
  If Xero made a *different* contact, that is a genuine duplicate in the club's
  books and stays open for someone to look at, rather than being quietly
  ignored. Alongside that, the member's page now shows any open Xero operation
  blocking their merge or deletion, and the merge and deletion refusals name the
  operation and point at Admin → Xero → Operations. The page and the refusals
  now read the same thing, so a member who is being refused can no longer appear
  reconciled.

  **"Force sync → Contact" failed every time for walk-in owners.** A walk-in
  guest booked by the office has no real email address, so the system
  deliberately never searches Xero by email for them — a placeholder must never
  match a real person's contact. That meant a forced contact re-sync had nothing
  to match against and fell through to creating a contact, which was refused
  outright for any member who already had one. The result was a 409 refusal on
  every attempt with no way to clear it, and the same dead end blocked the
  automatic repair that runs when Xero rejects a stale contact reference — which
  could leave an invoice unable to be raised at all.

  A forced re-sync now asks Xero by exact name first. If a live contact with the
  member's name is there, that contact is re-linked — so a re-sync does not mint
  a second contact for someone who already has a good one. Archived contacts are
  excluded from that search, so a link to a contact that has genuinely been
  archived or removed in Xero still results in a fresh contact being created,
  which is what a repair is for. An ordinary contact create for an
  already-linked member is still refused exactly as before; only an explicit
  repair is allowed through.

  **A half-finished unlink now says what survived.** Unlinking a member from
  their Xero contact clears the link first and then tidies up: clearing cached
  subscription history, deactivating the member's Xero record links, and writing
  the audit entry. If one of those later steps failed, the system already told
  the administrator the unlink "completed only in part" and not to repeat it —
  but not *which* parts were unfinished. The message now names them: that the
  member's Xero record links may still be active and should be checked, and that
  the audit entry for the unlink may be missing so it may not appear in the
  member's history. Each is mentioned only when that step genuinely did not
  finish, so the message stays accurate rather than warning about everything
  every time.
