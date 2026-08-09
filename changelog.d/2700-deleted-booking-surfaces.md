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
  the booking was **cancelled or removed**, and invited to contact the club. In
  practice that explanation reaches somebody who had the booking open when the
  club deleted it and pressed the button a moment later — which is exactly the
  situation this is for. Somebody arriving fresh from an old email still meets
  the booking page's existing "no such page", because that page has always
  refused a deleted booking; making the explanation reach them too is a separate
  question the club has not decided yet. The wording deliberately does not say
  who deleted the booking or name the member who made it. Anyone who was not
  entitled to that booking in the first place still gets the same "not allowed"
  answer as before and learns nothing new from it.

  Separately, there was a narrow window in which a member could still be
  charged for a change to a booking an administrator was deleting at that
  moment — the member being on the payment page when the deletion happened.
  Deleting a booking now cancels any payment still in progress against it, which
  closes most of that window. If a payment does still go through, the club does
  not quietly keep it: the payment is recorded so the money is accounted for,
  and a **manual refund task** is raised so a person knows about it. If the
  cancellation itself fails, that now shows up in the audit log rather than only
  in the server's own diary.

  **What an administrator may notice:** an occasional new manual refund task
  with a reason explaining that a change payment arrived against a booking that
  had already been deleted. Be aware of what usually happens before you see it.
  The club's card provider tells TAC Bookings about the payment separately, and
  a rule that has been in place since long before this change automatically
  refunds a payment that lands on a cancelled booking — and a deleted booking is
  always a cancelled one. So on the ordinary day the member has already been
  refunded within seconds, an alert email has gone to the office saying so, and
  the task closes itself with a note; nobody refunds the same payment twice.
  The task is a decision to make, rather than a record of one already taken,
  when that automatic refund does not happen — the provider's message never
  arrives, or fails. In that case treat it as a real decision and not a job to
  rubber stamp: the right answer is sometimes to restore the situation rather
  than hand the money back.
