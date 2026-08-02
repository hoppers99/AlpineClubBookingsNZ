- **A booking officer can now link an unnamed placeholder guest on a member's
  whole-lodge booking directly to a member, re-rating that guest at the member
  rate in one step, with the price change shown before it is committed
  (#2337).** When a member's whole-lodge request is approved, the party is created
  as unnamed placeholder guests priced at the (higher) non-member rate. Some of
  those people are members who should pay the member rate. Until now the only way
  to give one of them the member rate was to remove the placeholder and add the
  member back as a new guest — two steps and a separate settlement each time.

  There is now a first-class "Link to member" action on each placeholder row of a
  member whole-lodge booking. The officer picks the member, and the panel shows a
  quote first: the guest's old price, the new member price, the difference, and
  how it settles (a refund or account credit for a reduction, an extra charge for
  an increase) — nothing settles unseen. Saving applies the link, re-prices that
  guest at the member rate, and settles the difference exactly the way every other
  booking change does.

  The action is deliberately narrow. It is available only to booking officers and
  administrators, only on genuine **member** whole-lodge bookings (never on a
  school whole-lodge booking, whose negotiated price must not be disturbed), and
  only on a placeholder that is not already linked to a member — a guest already
  attached to a member cannot be quietly re-pointed to a different one, and an
  ordinary rename still cannot change who a booking is for. A member who is
  already on the booking cannot be linked to a second placeholder, so the same
  person can never be billed the member rate twice. Linking a member from
  outside the booker's family still asks that member's consent and holds their
  place exactly as adding them as a guest would. Every link is recorded on the
  booking's history so the change is never silent.

  The one-step link is offered only before a stay begins. Once a booking is
  in-progress (the guests have checked in), the "Link to member" control is not
  shown at all, and the save path refuses the link even if one is attempted —
  the officer removes the placeholder and adds the member back instead, which
  settles the change correctly mid-stay, whereas the in-place re-rate cannot.
  Removing the placeholder and adding the member back also still works before
  check-in and settles identically; the link is simply the one-click
  equivalent.
