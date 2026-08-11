- **The AI Diagnostics assistant now has to be given permission before it can read
  anybody's personal details (#2785).** Until now the diagnostics tools that return
  a person's information were only *marked* as doing so — the mark was recorded and
  documented, but nothing actually stopped one being read. It is a gate now.

  When an administrator asks Diagnostics a question, they choose which records the
  question is about and tick a box to allow the assistant to read the personal
  details of those records. Both are per question: nothing is remembered, and the
  next question starts with the box unticked again. The assistant may also follow a
  record directly linked to one that was chosen — the member who owns a booking you
  picked, for instance, or the payment behind it — because that is usually the
  answer to "why will this booking not confirm". It cannot keep walking outwards
  from there.

  There is a second, separate tick: whether the assistant may **search** for people
  and records itself. Left off — which is the default — the administrator chooses
  every record, and the assistant can only read the ones they chose. Ticked, the
  assistant may also run searches that return lists of members, bookings and
  payments. The two ticks are independent, and neither implies the other.

  When a read is refused for either reason, the answer says so plainly and points at
  the control that would allow it, instead of naming a permission the administrator
  already holds or quietly leaving a gap. The audit trail now records, for every
  diagnostics tool an administrator or the assistant runs, whether the personal
  detail was allowed or refused and whether searching was permitted — without ever
  recording which person or booking it was about.

  Nothing an administrator could already see has changed, and no permission has been
  widened: every existing check still runs first, and this sits on top of them.
