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

  **It agrees with the screen the operator opens next, and that is now proved
  rather than promised.** The whole-booking answer reuses the application's own
  finance functions, and a test drives the real Admin > Payments service and the
  diagnostic over the same booking and requires them to return the same Xero state
  and the same settlement kind. Three places where they had drifted are fixed:
  a booking whose Xero invoice is recorded as a link rather than as an id is no
  longer reported as having no invoice (which could have led to a second invoice
  being raised for one stay); a booking repriced downward after it was paid — a
  guest removed, say — is no longer reported as overpaid with "one of the stored
  numbers is wrong", because refunds are now netted out of what is outstanding;
  and a cancelled booking is no longer reported as still owing money that the
  cancellation left frozen in its columns. A cancelled or bumped booking now says
  plainly that it has reached the end of its life, reports nothing outstanding, and
  raises no "waiting for payment" finding — while still reporting a refund it owes
  or a Xero problem it has.

  **The words behind each blocker code now travel with the answer**, so the plain
  English an operator reads and the plain English the assistant reads come from the
  same place — "money has to be handed back by a person" cannot become "a refund is
  on its way".

  **Two search and evidence limits were tightened.** Searching for an amount of zero
  used to match almost every payment in the club, because a column that is zero by
  default was being compared against it; it now matches only payments whose own
  amount is zero, which is the fully-credit-covered booking an operator asking that
  question is actually looking for. And three "audit history" options that pointed
  at Xero records were removed: they could never have matched anything, and an empty
  answer from them read as evidence that nothing had happened. Xero history is in
  the Xero linkage tools, where it always was.

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
