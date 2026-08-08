- **AI Diagnostics can now investigate a payment, refund or Xero problem, and
  explain what is actually blocking it (#2377).** A Finance Officer can hand
  Diagnostics a payment id, a booking reference, a Stripe PaymentIntent, charge or
  refund id, an internet-banking reference, a Xero invoice number, or simply an
  exact amount and roughly when it was taken — and get back the payment's stored
  state, its charge attempts, its refund position, whether the webhook arrived and
  was processed, where the Xero invoice got to, and the platform's own finance
  audit trail for that record.

  It also answers the question none of the admin screens can. For one booking it
  reports the authoritative money — amount due, credit applied from the credit
  *ledger*, amount actually captured, refunded, outstanding, still refundable, the
  member's credit balance — and a short list of stable blocker codes in the order
  they should be acted on, so "a refund the club owes has exhausted its retries and
  will never send itself" is never buried under "the Xero invoice is missing". Two
  of the figures it reports are discrepancies no screen surfaces at all: when the
  stored amounts stop adding up to the booking's final price, and when the credit
  recorded on the payment disagrees with the credit ledger. Both are exact, to the
  cent.

  **It cannot change anything, and it never contacts a provider.** It cannot take a
  payment, allocate one, reconcile one, issue or retry a refund, touch a Xero
  invoice or contact, or replay a webhook — and it does not ask Stripe or Xero
  anything. Everything it reports is what this system last wrote down, and it says
  so every time, because "the stored state is succeeded" and "Stripe says this
  succeeded" are different facts. When a question really turns on what the provider
  believes right now, it says that too, and points at the provider's own console.

  **Who can use it.** Any administrator with Payments access (`finance:view`), and
  they do **not** also need Support & System access. Two of the tools need a second
  permission because they cross into another area: tying a member to their Xero
  contact also needs Membership access, and the whole-booking money answer also
  needs Bookings access. A Booking Officer without Payments access gets none of it.

  **What it will and will not tell you about a member.** For one record you have
  already identified, it returns the booking reference, the amounts, the payment
  method, the stored Stripe and Xero references and the bank reference the payer
  typed. It returns **no member name, email address or phone number** — deliberately
  — and it cannot read raw provider payloads, provider error messages, refund
  reasons, admin notes or any stored credential. Most of those it cannot even
  attempt: the database credential Diagnostics uses is refused them by PostgreSQL
  itself. There is no way to list or export payments; every tool needs an exact
  reference, and a search returns at most ten rows.

  **One operator step is required after this release ships:** re-run
  `npm run diagnostics:provision-role`. Until it is run, Diagnostics reports its
  database role as over-privileged and the new tools decline to run — deliberate
  friction, so the exact list of what Diagnostics may read is always something a
  person approved.
