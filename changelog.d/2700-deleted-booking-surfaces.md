- **A deleted booking now behaves as deleted everywhere, and people who follow
  an old link are told what happened (#2700).** When the club deletes a
  cancelled booking it treats that booking as gone, and the booking page has
  always refused to show it. Three things underneath the page had not caught
  up, and this closes all three.

  A member guest could still answer a consent request — "yes, I'm coming" or
  "no, I'm not" — on a booking the club had deleted. Answering it went on to
  update the guest list, move beds around and **email the booking's owner**
  about a stay that no longer existed. That no longer happens for anyone: the
  answer is refused, nothing is recorded, and no email goes out.

  Two pages that read a deleted booking's own history — its change requests and
  its refund appeals — also still worked for the member who made the booking,
  which was inconsistent with the booking page they were sent from. Both now
  refuse as well.

  In all three places the person is not simply shown "not found". They are told
  the booking was **cancelled or removed**, and invited to contact the club, so
  somebody clicking a link in a weeks-old email gets an explanation rather than
  a dead end. The wording deliberately does not say who deleted the booking or
  name the member who made it. Anyone who was not entitled to that booking in
  the first place still gets the same "not allowed" answer as before and learns
  nothing new from it.

  Separately, there was a narrow window in which a member could still be
  charged for a change to a booking an administrator was deleting at that
  moment — the member being on the payment page when the deletion happened.
  Deleting a booking now cancels any payment still in progress against it, which
  closes most of that window. If a payment does still go through, the club does
  not quietly keep it and does not quietly refund it either: the payment is
  recorded so the money is accounted for, and a **manual refund task** is
  raised so a person decides what should happen. That is deliberate — an
  automatic refund would be the wrong answer if the deletion itself was the
  mistake.

  **What an administrator may notice:** an occasional new manual refund task
  with a reason explaining that a change payment arrived against a booking that
  had already been deleted. Treat it as a decision to make, not a job to rubber
  stamp — the right answer is sometimes to restore the situation rather than
  hand the money back. Where the club's card provider has already returned the
  money on its own, the task closes itself with a note saying so, so nobody
  refunds the same payment twice.
