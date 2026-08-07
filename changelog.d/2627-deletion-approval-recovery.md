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
  Officer who to ask.

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
