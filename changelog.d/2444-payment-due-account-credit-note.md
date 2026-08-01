- **A booking confirmed with money still owing now tells the member to pay what
  the invoice asks for (#2444).** When a member's whole-lodge request is
  approved, the confirmation email states the booking's full price as "Total
  Due" and asks them to transfer it by internet banking. That figure is the
  booking's price, but the document the member actually pays against is the
  club's invoice — and an admin can change it, most often by putting account
  credit the member holds towards it. A member who followed the email rather
  than the invoice could send the club too much.

  The unpaid confirmation now closes with one extra sentence: "If the invoice
  asks for a different amount — for example because the club has put account
  credit you hold towards it — please transfer the amount the invoice shows." It
  is deliberately conditional, so it still reads correctly for the great
  majority of members, whose invoice matches the total exactly, and it names no
  second figure.

  It is worth knowing that nothing puts a member's account credit towards one of
  these invoices for you. If you want a member's credit applied, do it in Xero;
  the email has already told them to pay whatever the invoice ends up asking
  for.

  Nothing else about the email changed. Confirmations for bookings that are
  paid, partly paid, or covered entirely by credit are exactly as they were, and
  no new token was added: the sentence travels inside the same `{{paymentOutcome}}`
  block the shipped wording already carries, so a club whose customised wording
  still uses that block — or `{{paymentDueNote}}` on its own — gets the sentence
  without editing anything. A customised body that spells the money out by hand
  instead, from `{{totalDue}}` and friends, has never carried these payment
  instructions on an unpaid booking and still does not; such a club should add
  `{{paymentDueNote}}` to its wording. The editor now previews that token as the
  real paragraph, and warns if you type a label in front of it. Showing the
  actual amount the invoice asks for, rather than pointing at the invoice, is
  separate work still to come.
