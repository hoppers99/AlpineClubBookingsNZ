- **AI Diagnostics can now look things up: readiness, deployment, spend, background
  jobs, and a bounded audit trail (#2375).** The admin-only AI Diagnostics assistant
  had a database substrate but no tools to use it with. It now has nine, and each one
  is a fixed, server-written lookup with a fixed permission — the assistant chooses
  which to run and nothing else. Four report on the system itself: whether Diagnostics
  is set up and what is blocking it, which release is running and whether its deployed
  code knowledge verified, what Diagnostics has cost this month against its budget, and
  whether any scheduled background job is late or failing. Five correlate the audit
  trail around a problem — one for system and security events, and one each for
  bookings, membership, finance/Xero and lodge operations.

  **Who sees what follows the access role an administrator already has.** Any admin may
  open Diagnostics, but the server re-reads their areas on every single lookup. The
  system tools need Support & System at View. Correlating a business domain's events
  needs Support & System **and** that domain's own area, so a Booking Officer without
  Support & System gets no booking correlation, and a support admin without Finance
  gets no payment correlation. Where an area is missing, Diagnostics says so and names
  the permission required — it never fills the gap from somewhere else, and removing an
  area takes effect on the next lookup, mid-conversation.

  **"Nothing matched" now says what it searched.** The audit trail's own categories are
  older and coarser than the admin permission areas and do not line up with them — a
  member merge, a member import or a change to payment or booking settings is recorded
  as an administrator action rather than under its business domain, and induction is
  recorded under lodge operations. So each correlation lookup states which categories it
  covered, and the assistant is told that finding nothing means nothing matched *in
  those categories* rather than that the event never happened. Where a related event
  lives under another category, the lookup that would find it is named.

  **A partial answer is labelled as one.** A lookup's rows are shown to the assistant in
  a block with a fixed size limit, and a wide result can be too long for it — 22 audit
  events fit, and fewer do once the events carry long identifiers. When that happens the
  block now says so twice: in the wording the assistant reads, and in the status a screen
  or a later step can act on. Previously only the wording said it, so a listing that had
  quietly dropped its last few events still carried the status "evidence was retrieved".

  **What an empty correlation result does and does not prove.** Each of the five audit
  lookups now also says that an event recorded with no category at all is invisible to
  every one of them, and points to Admin > Audit Log, which does list those rows. The
  audit category is optional and a number of administrative operations — subscription
  billing, member credit adjustments, fee configuration, booking-policy changes, bulk
  communications, deletion-request decisions — record without one. Without that sentence,
  an assistant that found nothing could report that nothing had happened.

  **What it never returns.** No API key, credential value, database password,
  connection string, or credential identifier. No prompts, answers, provider payloads
  or provider error text — only stable failure codes. No job error text or job result
  payloads. No stack traces, IP addresses, user agents, event descriptions, stored
  metadata, or member, booking and payment identifiers. Readiness reports the state of
  the dedicated Anthropic key (`saved`, `needs_reentry`, `not_configured`) and never
  the key. Every lookup is capped, carries the instant it was read, is recorded in the
  audit trail by metadata only, and returns a stable state so "there is nothing to
  report" can never be confused with "you were not allowed to see it".

  **Operators: this release needs one step after deploying.** Run
  `npm run diagnostics:provision-role` again. The audit-correlation tools read eight
  named columns of the audit log, and the read-only Diagnostics database role has to be
  granted them — deliberately, visibly, by an operator, which is how every future
  Diagnostics data access will be added too. Until it is re-run, the AI Diagnostics
  readiness screen reports the role as over-privileged and the correlation tools are
  refused. The grant is by column, so as that role the database itself refuses to
  return the audit log's IP addresses, user agents, descriptions, stored metadata or
  member references — not merely the application.
