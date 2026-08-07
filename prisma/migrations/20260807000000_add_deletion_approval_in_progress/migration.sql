-- A deletion approval cancels future bookings in separately committed booking
-- transactions before the final anonymisation transaction. Persist ownership of
-- the approval decision first so a concurrent reject can never become final
-- after an approval-triggered cancellation has committed.
ALTER TYPE "DeletionRequestStatus"
  ADD VALUE IF NOT EXISTS 'APPROVAL_IN_PROGRESS' AFTER 'PENDING';
