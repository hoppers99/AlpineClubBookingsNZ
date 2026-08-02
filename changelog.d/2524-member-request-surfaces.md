- **Members can now ask a Booking Officer to allow an eligible booking-policy
  exception, instead of just being turned away (#2524).** When a booking or a
  booking change trips a *soft* policy — a minimum-stay rule or the adult-member
  hosting requirement — the member can submit a single, auditable request with a
  short message explaining why, and a Booking Officer sees it in one shared
  queue. Each request freezes the exact proposal and the policy evidence it is
  asking to override, so the officer reviews precisely what was submitted. A
  member can withdraw a request, or replace it with a new one, and the club is
  notified when a request comes in.

  Nothing about the live booking changes while a request is open — it is only a
  request. Building on the #2365 foundation, new-booking requests get their own
  store while modification requests extend the existing change-request queue, and
  a member can only ever have one open request for the same proposal at a time.
  The Booking Officer approval-and-execute action and the held-capacity handling
  arrive in the follow-up work (#2525). Hard limits — whole-lodge capacity,
  payment, membership, past dates — are never part of this and remain firm
  refusals. The legacy locked-period change-request queue stays scoped to
  locked-period rows, so these new policy-exception requests only ever appear in
  the shared exception queue, and withdrawing a request is scoped to the booking
  it belongs to so the audit trail always records the correct booking.
