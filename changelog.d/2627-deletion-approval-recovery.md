- **A started account-deletion approval can be handed back, and a member who has
  already been deleted can now be permanently removed (#2627).** Two problems in
  the new deletion-approval handling are fixed.

  Approving a member's deletion request moves it to **Approval in progress**
  before it cancels any of their future bookings, so a second administrator
  cannot reject a request whose stays have already been cancelled. That was
  right, but it had no way back: once a request was in that state the only exit
  was a successful deletion. If something was permanently in the way, the request
  stayed stuck there forever — and while it is stuck the member cannot ask for
  deletion again and their duplicate record cannot be merged. A Full Admin can
  now **Release approval** on such a row, which hands it back to the pending
  queue with a reason recorded on the request, so it can be approved or rejected
  properly. Releasing anonymises nobody and emails the member nothing; any
  bookings the started approval already cancelled stay cancelled, and the dialog
  says so. Only a Full Admin sees the control, and the screen tells a Membership
  Officer who to ask. Every release is recorded in the audit log — who released
  it, who had held the approval, and the reason — filed under Privacy alongside
  the approve and reject entries beside it, so it is visible to exactly the same
  administrators as those and to nobody new. (The audit-writer census #2581 added
  moves 418 recording points to 419 for it.)

  A released request goes back into the pending queue **carrying that history**,
  because rejecting it is the one rejection that can be final over stays that were
  already cancelled. The row says "approval started and released back to pending",
  with the date and the reason, instead of looking like an ordinary new request;
  the reject dialog repeats it; only a Full Admin can reject it; and the rejection
  has to be confirmed, so an administrator working from a page that was open
  before the release is told what happened rather than declining the request
  unaware.

  **And the member is told too.** Rejecting a released request now requires a
  reason and always emails it to them. Everything else about this protection is
  something only administrators see, and the rejection note is the only thing the
  member ever receives about stays that are already gone — so on this one path it
  is mandatory and the "reject without emailing" option is not offered. Every
  ordinary rejection keeps its optional note and its free choice about emailing,
  because nothing has been cancelled there.

  Approving a released request is unchanged — it simply completes the deletion the
  member asked for. If an approval or a rejection is running at the very moment
  somebody releases the request, that administrator is now told exactly that,
  along with any booking cancellations that did complete, instead of being warned
  that the outcome could not be determined; and a rejection that was decided
  before the release happened can no longer land after it, so nobody is declined
  over cancelled bookings without having been shown the warning. If a release
  arrives while a decision on the same request is still being written, it now says
  "try again shortly" instead of reporting an unexplained failure.

  The claim is also no longer taken when there is nothing to protect. Approving a
  member who has no future bookings never cancelled anything, so that approval
  now stays pending until the moment it completes — which means an administrator
  who realises mid-review that they should not have approved can still reject it,
  and nothing can get stuck.

  Separately, an administrator could not permanently delete a member who had
  already been through an approved deletion request. The Xero safety check on the
  permanent-delete path treated the erased account as "not available for Xero
  changes" and stopped, and because nothing recognised that particular refusal
  the operator saw only a bare failure with no explanation and no way to clear
  it. Erasing the account already removes its Xero contact link, so the check no
  longer applies it to an already-erased member. The rest of the check is
  unchanged: a genuine Xero contact operation still stops the delete and still
  explains what to resolve first.
