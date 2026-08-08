# AI Diagnostics finance and Xero tool pack (AID-6C)

The second tool pack on the [SELECT-only substrate](tools.md): bounded record
selection, per-record payment, refund, webhook and Xero evidence, and the
application's own authoritative booking-finance calculation. Delivered under issue
#2377 of epic #2369.

Read [tools.md](tools.md) first, and [tool-pack-support.md](tool-pack-support.md)
for the substrate's first pack. This page covers only what this pack adds — its
permissions, its evidence sources, its projections, its bounds, the eleven
relations it argues for, and the questions it deliberately **cannot** answer.

## What an administrator can ask it

| Question | Tool | Needs |
| --- | --- | --- |
| Which payment is this? (a payment id, booking id, booking reference, Stripe PaymentIntent/charge/refund id, bank reference, or Xero invoice id/number) | `diagnostics.finance_payment_search` | `finance:view` |
| …and if all I have is an amount and roughly when? | `diagnostics.finance_payment_amount_search` | `finance:view` |
| What does the platform hold about this payment? | `diagnostics.payment_diagnostic_summary` | `finance:view` |
| What has it tried — attempts, duplicates, queued recovery work? | `diagnostics.payment_attempt_ledger` | `finance:view` |
| Where is the refund up to? | `diagnostics.payment_refund_state` | `finance:view` |
| Did the webhook arrive, and was it processed? | `diagnostics.finance_webhook_timeline` | `finance:view` |
| Why has the invoice not reached Xero? | `diagnostics.xero_invoice_linkage` | `finance:view` |
| What did the platform record happening to this record? | `diagnostics.finance_record_audit_history` | `finance:view` |
| Is this member linked to a Xero contact? | `diagnostics.xero_contact_linkage` | `finance:view` **and** `membership:view` |
| What is actually blocking this booking's money? | `diagnostics.booking_finance_state` | `finance:view` **and** `bookings:view` |

Everything here is **read-only**. Nothing in this pack can create, alter, allocate,
reconcile, refund, retry, capture, cancel, replay, void or configure anything, and
**no tool calls Stripe, Xero, a bank or any other provider**.

## Permissions, and why they are shaped this way

`finance:view` is the area that already governs Admin > Payments, Refund Appeals &
Credits, Internet Banking and Xero Sync. Eight of the ten entries require it and
**nothing else**.

That is deliberate and it is the point of #2377's owner decision: `support:view` is
required for **general system evidence only**, and a domain tool must not demand it
merely because the feature appears inside AI Diagnostics. A Finance Officer
investigating a payment is doing their own job. A contract test asserts that no
entry in this pack names `support`, so a later refactor cannot fold the packs into
one support-gated family.

Two entries need a second area, and both are the epic's own rule rather than a
judgement call:

- **`xero_contact_linkage` requires `finance:view` AND `membership:view`.** It is
  keyed on a member and ties that member to a Xero contact, which is a combination
  of finance and membership evidence.
- **`booking_finance_state` requires `finance:view` AND `bookings:view`.** It
  combines the booking's own status and price with the payment's money.

**An argument can never decide which of those sets applies.** The substrate
authorizes *before* it parses arguments (see [tools.md](tools.md) → "The gates, in
order"), so `xero_invoice_linkage` has a closed `localModel` enum that
**deliberately omits `Member`** — the member case is a separate entry with a
separate, stricter permission set. Adding `Member` to that enum would silently move
member-linked evidence behind `finance:view` alone.

### What a missing permission looks like

A caller who lacks an area is not offered the tool, and an invocation naming it
anyway is denied server-side with `permission_denied` and the missing area named.
Nothing infers the answer from elsewhere: a Booking Officer without `finance:view`
gets no finance tool at all, and the only booking-level payment summary they may
receive is the one AID-6B (#2376) will provide under `bookings:view`. This pack
offers no reduced, permission-free variant of any entry.

## Record selection comes first, and it is the containment

Every per-record entry takes an **exact identifier**. There is no listing tool, no
"recent payments" window, and no entry that accepts `{}` — a contract test
invokes every one of the ten with empty arguments and requires a rejection.

The two search entries are therefore the only way in, and they are bounded five
ways:

| Control | Value |
| --- | --- |
| Match | **Exact equality only.** There is no `LIKE`, no `ILIKE`, no regex operator and no wildcard anywhere in the pack. |
| Minimum term | 6 characters; exactly 8 for a booking reference; a full cuid for a payment or booking id. |
| Blank / wildcard | Rejected by the argument schema. `%`, `*`, quotes and angle brackets are outside the character class. |
| Rows | 10 — #2377's recommended default, and half its absolute maximum of 20. |
| Date range | A closed enum: `7d`, `30d` (default), `90d`. There is no unrestricted range to ask for. |
| Ordering | `createdAt DESC, id ASC` — total, so identical evidence hashes identically for the audit trail. |

`_` **is** in the character class, and that is a fix rather than an oversight: every
Stripe identifier is `pi_…`, `ch_…`, `re_…`, `evt_…`, and an earlier revision of the
class refused all of them while the tool's own description advertised them. The
registry contract test caught it. It is safe because `_` is only a wildcard inside a
`LIKE` pattern and there is no `LIKE` in this pack.

**Ambiguity is reported, not resolved.** A booking reference is the uppercase first
eight characters of a cuid (`formatBookingReference`) and is **not unique**, so a
search on one can legitimately match several bookings. The tool returns them all up
to the cap and its description tells the model to ask the operator which one they
mean.

### The query plan, stated because it is a real trade

The reference search's predicate is a disjunction across differently-indexed
columns, so PostgreSQL will usually satisfy it with one sequential scan of
`Payment`. At this platform's scale — at most one `Payment` row per booking — that
is milliseconds, and the 5-second `statement_timeout` is the backstop, reported
honestly as `query_failed` rather than as an absence. The alternative, nine
registry entries with one indexed predicate each, was rejected as nine tools the
model must choose between for one question. `Payment."xeroInvoiceNumber"` is not
indexed anywhere in the schema either, so an invoice-number search is a scan by
construction.

## Evidence sources

Nine of the ten entries are `select_only_sql`. One is `server_owned`, and the
reason is #2375's rule rather than convenience.

**`booking_finance_state` reads the application's own authoritative answer.** #2375
forbids a second definition of a number an admin screen already owns, and #2377
repeats it for finance state specifically. Every figure and classification in that
entry comes from a function this codebase already has:

| What | Function | Module |
| --- | --- | --- |
| Account credit applied to a booking | `deriveBookingAppliedCreditCents` | `member-credit.ts` |
| The member's credit balance | `getMemberCreditBalance` | `member-credit.ts` |
| Whether money actually moved | `hasCapturedPayment` | `booking-payment-state.ts` |
| How much can still be refunded | `getRemainingRefundableCents` | `booking-payment-state.ts` |
| Whether an invoice is expected | `isSettledBookingStatus` | `booking-payment-state.ts` |
| The payment's display status | `getPaymentDisplayStatus` | `payment-status-display.ts` |
| How a cancellation was settled | `deriveSettlementKind` | `admin-operational-state.ts` |
| The Xero linkage classification | `deriveXeroState` | `admin-operational-state.ts` |

Re-deriving any of those in SQL would let a diagnostic answer drift from the screen
the operator opens next.

### The residual that source carries, stated plainly

It queries application tables on the application's own **full-privilege** Prisma
connection, so unlike the nine SQL entries there is no column grant behind it and
**the registry projection is the only boundary** — the same residual AID-6A records
for its four server-owned entries. Nothing leaks today: the raw row is built field
by field from named `select` clauses, and it reads no note, no reason, no payload
and no person. But two columns sit one `select` away and must never be added —
`MemberCredit.description` (which *is* read, to classify the settlement, and is
dropped inside the function) and `Payment."manualPaymentNote"` — so **every edit to
`finance-evidence.ts` or to that projection is a security-relevant change** and
needs the review a grant would get.

It bounds its own **work** as well as the executor's wait: a constant six point
reads and aggregates for one booking, under its own 10-second deadline that
**refuses** rather than returning a partial row. A finance state assembled from some
of its inputs would be a fabricated answer, not an absent one.

## The relation grants

This pack adds **eleven** relations to the `SELECT_GRANTS` allowlist and **one
column** to `AuditLog`. Every one is granted **by column**.

| Relation | Why | The tool that needs it |
| --- | --- | --- |
| `Payment` | The pack's spine: status, source, the five money columns, the stored Stripe/Xero references, the internet-banking hold state. | both searches, `payment_diagnostic_summary`, `payment_refund_state` |
| `PaymentTransaction` | Charge attempts, and the **indexed** internet-banking reference. | `finance_payment_search`, `payment_attempt_ledger` |
| `PaymentRefund` | Refunds Stripe actually made, with the only `currency` column in the pack. | `finance_payment_search`, `payment_refund_state` |
| `PaymentRecoveryOperation` | The platform's own queued refund/cancel debt and its attempt count. | `payment_attempt_ledger`, `payment_refund_state` |
| `ManualRefundTask` | Money a person must hand back — no card to refund. | `payment_refund_state` |
| `RefundRequest` | The member's own refund appeal and its decision. | `payment_refund_state` |
| `ProcessedWebhookEvent` | The idempotency lease: was the webhook claimed, and did the handler finish? | `finance_webhook_timeline` |
| `WebhookLog` | One row per delivery attempt — several for one event id is a redelivery. | `finance_webhook_timeline` |
| `XeroInboundEvent` | Xero's own inbound ledger, matched on resource id or correlation key. | `finance_webhook_timeline` |
| `XeroObjectLink` | What is linked in Xero, including links that were unlinked. | `xero_invoice_linkage`, `xero_contact_linkage` |
| `XeroSyncOperation` | What the platform tried, with a stable `lastErrorCode`. | `xero_invoice_linkage`, `xero_contact_linkage` |
| `Member` | **`id` and `xeroContactId` only.** The authoritative member↔Xero contact link. | `xero_contact_linkage` |

And on the existing entry: **`AuditLog."entityId"`**. AID-6A withheld it explicitly
and recorded that per-record evidence was AID-6B/6C work "under their own area
permission and their own privacy review". This is that review. `entityId` is used
as a **predicate** against an id the caller already supplied, is **never
projected** (the row's own `id` is the evidence reference), and the three
member-identifying columns beside it stay ungranted.

### Two grants to scrutinise hardest on any future edit

**`Member`, two columns.** Every other column of that relation — name, email,
phone, address, date of birth, membership state, credentials — stays refused by the
server. As the diagnostics role, `SELECT "email" FROM "Member"` fails with `42501`.
The alternative, granting `firstName`/`lastName` so a diagnostic could confirm the
person by name, **was rejected**: it widens a least-privilege credential's reach
into member PII to save one click, and #2377 *permits* identifying information
without requiring it. Identity is confirmed from the booking reference, the amount
and the dates instead.

**`PaymentRecoveryOperation."idempotencyKey"`, granted so it never has to be
projected.** It is the only thing that says **why** a refund was queued: the
operation `type` is `REFUND_BOOKING_MODIFICATION` for a booking cancellation, an
approved refund appeal, a capacity-race auto-refund and a duplicate-capture
auto-refund alike, so a tool reporting the type alone would mislabel every one of
them. The key's prefix is a server-written scenario marker, so the **statement**
classifies it with `pg_catalog.starts_with` against a closed list of prefixes from
`payment-recovery-keys.ts` and projects the resulting **code**. The key itself never
leaves the database, so a future projection bug cannot leak it either.

## What is never returned

Four classes, and they are not merely unprojected — with the two exceptions argued
above they are **outside the grant**, so PostgreSQL refuses them (`42501`) in a
`psql` session opened with this credential as readily as in a tool.

- **Raw provider payloads.** `XeroInboundEvent."payload"` is the only column in this
  schema that stores a raw provider webhook body, and it is the single most
  important omission in the pack. `XeroSyncOperation."requestPayload"` and
  `"responsePayload"` are the raw Xero request and response bodies.
- **Raw error text.** `PaymentRecoveryOperation."lastError"` (`@db.Text`, routinely
  a stack), `XeroSyncOperation."lastErrorMessage"`, `XeroInboundEvent."errorMessage"`,
  `WebhookLog."error"`. The pack reports `XeroSyncOperation."lastErrorCode"` — a
  stable code — and nothing else.
- **Operator and member free text.** `Payment."manualPaymentNote"`,
  `PaymentTransaction."reason"`, `PaymentRefund."reason"`,
  `ManualRefundTask."reason"`/`"note"`, `RefundRequest."reason"`/`"adminNotes"`,
  `XeroSyncOperation."manuallyResolvedReason"`, `XeroObjectLink."metadata"`,
  `MemberCredit."description"`.
- **People and payment instruments.** Every `*MemberId`/`*ById` column on these
  relations, `RefundRequest."memberId"`/`"reviewedBy"`, `Payment."stripeCustomerId"`,
  `"stripePaymentMethodId"`, `"stripeSetupIntentId"`,
  `PaymentTransaction."paymentMethodId"`, and every column of `Member` except the
  two named above.

No API key, OAuth access or refresh token, webhook signing secret, encrypted
credential value, card number or bank account number is readable by this credential
at all: `IntegrationCredential` and `XeroToken` are permanently out of scope
(ADR-007 §1), and a contract test asserts that no pack module so much as names
either one.

**One free-text value IS projected: the internet-banking payment reference.** It is
whatever the payer typed into their own bank, it is the only way to match a bank
line to a booking, and #2377 lists it as approved evidence. It is bounded to 64
characters (well below the substrate's own 200), stripped of control characters,
quotes and angle brackets, whitespace-collapsed, and marked when clipped. Because
payers routinely type their own name into it, **every entry that projects one
declares `surfacesPersonalData: true`**, which triggers ADR-004's per-invocation
operator opt-in.

## Stored evidence only, and saying so

For this first release the pack reads **only what the application already wrote
down**. Every provider value is the last state this platform recorded, not a live
answer.

That distinction is load-bearing, so it is carried in three places rather than
assumed: every entry's `evidenceScope` ends with the same disclosure sentence,
every entry's model-facing description repeats it, and a contract test pins both.
Without it a model narrates a stored `SUCCEEDED` as though it had just asked
Stripe, which is exactly the "presenting a likely cause as a confirmed provider
fact" failure #2377 forbids.

The shared evidence vocabulary gained a state for it:
**`provider_check_required`** (`src/lib/diagnostics/case/states.ts`) — "this is what
the platform last recorded, not a live answer from the provider; settling it needs a
check in Stripe's or Xero's own console." It is raised by the surface that assembles
a diagnostic case (AID-7, #2378) rather than by the executor, which cannot know
whether a given question turns on live provider truth.

Live provider reads stay out of scope until an owner-approved issue designs their
security, privacy, rate-limit, availability, credential and audit story.

## What this pack CANNOT answer, and why that matters

Three of #2377's requested capabilities have **no stored evidence in this schema**.
Saying so is the honest answer, and the alternative — a tool that returns an empty
result the model reads as "there is no problem" — is the failure mode the whole
`evidenceScope` mechanism exists to prevent.

- **There is no imported bank-transaction ledger.** "Internet banking" in this
  platform means the club invoices through Xero and the member pays by bank
  transfer; Xero's own reconciliation marks the invoice paid and a webhook syncs
  that back. So "unmatched bank payment", "partially allocated bank payment",
  "duplicate bank reference" and "wrong amount received" have **nothing to read**:
  the schema's `FinanceSnapshotType.BANK_TRANSACTIONS` is explicitly retired and
  never written. What the pack can show is the payment's own source, its bank
  reference, its bed-hold state, and the Xero inbound event that settled it.
- **No Stripe decline or failure code is stored anywhere.** There is no column for
  one. `payment_attempt_ledger` reports that an attempt failed and when; *why*
  Stripe declined it is a question for the Stripe dashboard, and the pack says so
  rather than inferring a cause.
- **There is no per-webhook attempt counter.** `ProcessedWebhookEvent` is a
  processing *lease*, not a counter. Redeliveries are counted by the number of
  `WebhookLog` rows for one event id, and `WebhookLog` is pruned after about 30
  days — so an old event legitimately has a lease and no delivery attempts, and the
  scope line says that too.

## Integer cents, everywhere

Every monetary value is an `Int` column or a sum of them. There is no division, no
`toFixed`, no floating-point parsing and no currency formatting anywhere in the
pack's data path — a contract test scans all five modules' source for each. The
model is handed the integer and told, in every description, to report the cents and
let the surface format them.

`centsOrNull` **refuses** a non-integer rather than rounding it, and refuses an
empty or blank value rather than reading it as zero. Both are deliberate: a rounded
cent presented as evidence is how a reconciliation answer becomes confidently wrong,
and "nothing is recorded" and "nothing is owed" are different findings.

**There is no `currency` column on `Payment`.** This platform is single-currency
NZD, so the payment tools report no currency at all rather than asserting one the
database does not record; `payment_refund_state` projects `PaymentRefund."currency"`,
which is the one place a currency really is stored.

### The two variances are the point of `booking_finance_state`

Both are **signed integer-cent differences that are zero on a healthy booking**, and
neither is visible on any screen:

- **`ledgerVarianceCents`** — the write-time identity
  `amountCents + creditAppliedCents + uncollectedAdditionalCents = finalPriceCents`
  (asserted by `prepareManualSettlement`) does not hold. One of the stored numbers
  is wrong.
- **`creditLedgerVarianceCents`** — the denormalised `Payment."creditAppliedCents"`
  disagrees with the `MemberCredit` ledger. `outstandingCents` is netted against the
  **ledger**, so a booking whose payment column overstates the credit is correctly
  reported as still owing.

## Blockers, in priority order

`booking_finance_state` returns a comma-joined, **priority-ordered** list of stable
codes from a closed catalogue (`FINANCE_BLOCKER_CODES`), plus a count. `none` means
nothing is blocking; there is no code for it, because a code meaning "no code" would
let a caller treat the healthy case as a finding.

The order is the point. Several can be true at once, and telling a Finance Officer
that the Xero invoice is missing when the real problem is that a refund the platform
owes has exhausted its retries sends them to the wrong screen.

1. `payment_record_missing`
2. `refund_execution_exhausted` — **a member is owed money and nothing automatic
   will move it.** Five attempts is the ceiling; a `FAILED` operation there is
   terminal.
3. `refund_execution_pending` · 4. `manual_refund_open` · 5. `refund_appeal_pending`
6. `xero_operation_failed` · 7. `xero_operation_partial` ·
   8. `xero_operation_pending` · 9. `xero_invoice_missing`
10. `additional_payment_outstanding`
11. `payment_failed` · 12. `payment_processing` · 13. `payment_pending`
14. `ledger_variance` · 15. `credit_ledger_variance`

Every code carries a server-owned operator sentence
(`FINANCE_BLOCKER_DESCRIPTIONS`), pinned by a test, because a code with no sentence
is a code the model will paraphrase — and a paraphrased blocker is how "a refund is
queued" becomes "a refund has been issued".

**Four refund records are kept apart and never merged**, because an operator will
call all four "the refund": `refund_appeal` (the member asked), `refund_execution`
(queued, money has *not* moved), `stripe_refund` (Stripe actually did it) and
`manual_refund_task` (a person must hand it back). `payment_refund_state` projects
the kind on every row and preserves each arm's own status vocabulary rather than
normalising them into one.

## Audit categories

`finance_record_audit_history` derives its category filter from
`auditCategoriesForCorrelationDomain("finance")` — the canonical #2581 taxonomy —
so it reads `payment` and `xero` and can never read a category the finance domain
does not own. If a category is reclassified, the tool follows without an edit.

It therefore inherits AID-6A's two disclosures, and repeats both in its scope line:
an administrator's change to payment or internet-banking **settings** is recorded
under `admin`, which this tool cannot read; and the audit category is optional, so a
row recorded with **no** category is matched by no diagnostics tool at all — **82**
production write paths still record that way, several of them money-adjacent
(subscription billing, member-credit adjustments, fee configuration). An empty
result is never evidence that nothing happened; the honest answer is that no
categorised finance audit event matched, and Admin > Audit Log lists the
uncategorised rows too.

The `entityType` argument is a **normalised domain word**, not a column value,
because this platform's audit writers use both `"Payment"` and `"PAYMENT"` and both
`"MemberSubscription"` and `"SUBSCRIPTION"`. `bind` closes over the server-owned
array of column values each word covers, so the model cannot name a column value at
all and a search cannot silently return half the history.

## Bounds

| Control | Value |
| --- | --- |
| Search rows | 10 (absolute maximum permitted: 20) |
| Search window | Closed enum: `7d`, `30d` (default), `90d` |
| Attempt / refund / webhook / Xero rows | 14 each, newest first, truncation reported |
| Audit-history rows | 18 |
| Single-row entries | `payment_diagnostic_summary`, `booking_finance_state` |
| Bytes, multi-row entries | 16 384 |
| Bytes, single-row entries | 4 096 |
| Free-text field cap | 64 characters, clipping marked |
| Server-owned read | 15 s deadline on the **wait**; the source carries its own 10 s deadline on the **work**, and refuses rather than returning a partial row |

Both byte ceilings are **measured, not estimated**: a registry contract test
serialises every entry's own projected shape at its own row limit, at the widest
values its projection can emit, and fails if the ceiling is unachievable — the
assertion AID-6A added after shipping an 8 192-byte ceiling that an ordinary
deployment exceeded. A second contract test renders every entry at its row limit and
fails if the evidence block would misreport what it listed.

## Prompt injection

Every projected value is treated as untrusted, prompt-injection-capable evidence
regardless of how server-owned it looks, and the pack defends in two layers:

1. **At the source.** A value that did not come from a closed server-side union is
   re-validated against a known shape on the way out and replaced by
   `(unparseable)` when it does not conform — provider references, stable codes,
   record identifiers, ISO instants, the display label and the blocker-code list all
   have their own validator. The sentinel deliberately contains characters every
   validator refuses, so no stored value can collide with it and no model can turn
   round and search on it. The one genuinely free-text value is stripped and
   bounded instead.
2. **In the renderer.** `render.ts` neutralises and **quotes** every value, so a
   stored value cannot forge the block delimiter, an attribute, a new row, or extra
   `field=value` pairs inside its own row.

Identifiers were passed through unvalidated in an earlier revision of this pack on
the argument that `@default(cuid())` generates them — and the pack's own hostile-row
test caught it. This codebase does hand-set ids in imports, fixtures and migrations,
and "the column is usually server-generated" is exactly the kind of reasoning a
later edit invalidates silently.

The pack's contract test drives a hostile row through **every** entry's projection
via a `Proxy` that answers every property with an injection payload, so a field
added to a projection later inherits the assertion without anyone remembering to
extend the test.

## Operator troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Every finance tool fails; readiness says `over_privileged` | This release added eleven relation grants and provisioning has not been re-run | `npm run diagnostics:provision-role`, then re-check readiness |
| A Finance Officer is told no diagnostics tool is available | Their access role has `finance` but the module or the diagnostics credential is not set up | `diagnostics.readiness` (needs `support:view`) reports the blocker |
| `booking_finance_state` is refused but the other finance tools work | The caller lacks `bookings:view` | The denial names the missing area; the per-payment tools still answer |
| `xero_contact_linkage` is refused | The caller lacks `membership:view` | Same — it is the only member-keyed entry |
| A search returns several rows for one booking reference | A booking reference is not unique | Pick the booking by its dates and amount, then use the exact booking id |
| A search finds nothing for an amount the member quotes | The stored amount differs by a change fee, an additional payment or applied credit | Search by booking reference instead, then read `booking_finance_state` |
| `booking_finance_state` reports a non-zero `ledgerVarianceCents` | The platform's own stored figures disagree | This is a real finding. Compare `payment_diagnostic_summary` and `payment_attempt_ledger` before changing anything |
| The webhook timeline is empty for an event Stripe shows as delivered | Webhook logs are pruned after ~30 days, or the event id is wrong | Check the processing lease row, which is not pruned on that schedule |

Incident response is unchanged from AID-6A: the audit trail for tool use is
`ai_diagnostics.tool_invocation` in `AuditLog`, retention class `sensitive_access`
(24 months), recording the acting administrator, the tool id, the areas checked, the
allow/deny outcome, the stable failure reason, non-reversible hashes of the accepted
arguments and of the result, row and byte counts, duration, round index and the
observed-at instant — and never the arguments, the results, the question or the
answer.

## Adding to this pack

Follow the checklist in [tools.md](tools.md) → "Adding a tool". Three extra rules
apply here:

1. **A new entry takes an exact identifier.** If it needs to list, it is a report
   and belongs in the admin UI where it is already governed.
2. **A money value is an integer, or it is `null`.** Never a rounded number, never a
   formatted string, and never a float on the way through.
3. **A new relation is granted by column, and every omitted column is a decision.**
   List the columns and the reason above, and say what the omissions are protecting.
   Re-provisioning is part of shipping it.

## Related

- [Tool substrate reference](tools.md) — the gates, bounds, audit, and the rules for
  adding a tool.
- [Support tool pack (AID-6A)](tool-pack-support.md) — readiness, deployment,
  budget/job health and audit correlation.
- [Deployment and operator guide](deployment.md) — provisioning the role and the
  full grant table.
- [Hub, ADRs, and threat model](README.md).
