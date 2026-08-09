# Additional Payment Chasing

> **Phase 2 transcription — issue #2691.** Until the index rewrite lands,
> [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) remains the authoritative
> copy of these rules and this file duplicates its
> "Chasing an outstanding additional payment (#2350)" subsection of "Booking
> Modifications".
> Do not edit either copy independently while both exist. The scheme this
> file follows is in [`_PHASE1_SCHEME.md`](_PHASE1_SCHEME.md).

Audience: Developer, Agent.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) · Scheme and
allocation rules: [`_PHASE1_SCHEME.md`](_PHASE1_SCHEME.md).

Prefix defined in this file: **`INV-ADDPAY`** — an outstanding additional
payment, who is owed one, who may pay one, and the quote/request holds and
refund-settlement rules that sit beside it.

Read this file when you are changing the additional-payment chase, the unpaid
finished-stay queues, a booking-request or quote capacity hold, or how a
reduction, refund or credit note settles.

Every `###` heading below is an invariant ID. IDs are permanent and are never
renumbered — see the allocation rules in the scheme. The text under each ID is
copied verbatim from `docs/DOMAIN_INVARIANTS.md`; only the ID heading lines and
the bracketed cross-file `[INV-*]` pointers registered in the PR were added.

## Chasing an outstanding additional payment (#2350)

### INV-ADDPAY-001

Until #2350 nothing chased the member for an uncollected upward change and no
admin surface showed one. These rules now hold:

- **Who is owed anything at all.** `isAdditionalPaymentOwed`
  (`src/lib/additional-payment-chase.ts`) is the in-memory twin of
  `buildAdditionalOwedWhere` and tests BOTH halves: booking status in
  {`CONFIRMED`, `PAID`, `COMPLETED`} (one shared list,
  `ADDITIONAL_OWED_BOOKING_STATUSES`), and `additionalAmountCents > 0` with
  `additionalPaymentStatus` other than `SUCCEEDED`. The status half is not
  decoration: booking cancellation marks the additional intent `FAILED` (or
  leaves it PENDING where no intent exists) WITHOUT zeroing the amount, so an
  amount-only test would show cancelled bookings as owing and would email their
  members a payment demand. It takes the status as a required argument so a
  caller cannot forget it.
- **Who may PAY one.** The member-facing surfaces use a second, deliberately
  wider list, `ADDITIONAL_PAYABLE_BOOKING_STATUSES` — the owed list plus
  `PAYMENT_PENDING`, which the owed list drops only to keep the two admin queue
  counts summable. Both surfaces that can move money gate on it: the booking
  page's `AdditionalPaymentCard` and
  `GET /api/bookings/[id]/additional-payment-secret`. The member dashboard's
  owed total is scoped instead by its own query (`ACTIVE_BOOKING_STATUSES` +
  `COMPLETED`), wider again. **What every one of them excludes is CANCELLED and
  BUMPED**, and that is the invariant: a member is never shown, and can never
  complete, a card payment for a booking the club has stopped counting.
  Enforcement is not cosmetic — cancellation marks the additional intent
  `FAILED` without zeroing the amount, and the cancel path asks Stripe to cancel
  only an intent that was still *outstanding*, so an intent that had already
  failed (a declined card) stays confirmable at Stripe. Before this gate the
  owner of a cancelled booking could open the booking, be offered "pay this
  extra", fetch a live client secret and complete the charge; the late-capture
  backstop (#1350) auto-refunded and alerted, but the member had still been
  charged for a booking that no longer existed.
- **What the member is told.** While the stay is still ahead, the member is
  emailed at most twice per obligation: `ADDITIONAL_PAYMENT_REMINDER_DAYS`
  (3) days after the extra was raised, and
  `ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN` (2) days before
  check-in. The pre-arrival reminder also names the amount when one is owing.
  Nothing is ever auto-cancelled or auto-expired, and the chase stops the
  moment `checkOut <= today` - a finished stay belongs to the queue above [INV-LOCKOUT-043].
- **Nothing raised before the chase existed is chased, and the cutover is a
  fact rather than a plan.** An obligation whose episode started before the
  cutover is never emailed about by the cron: on first deploy every pre-existing
  delta is already past the day-3 threshold, so without this the first pass
  would mail the whole backlog at once, and legacy rows with no ADDITIONAL
  transaction would date the demand from the payment row's creation rather than
  the day the price changed. Those deltas stay on every admin surface and can
  still be chased by hand — and the exclusion is per EPISODE, so a later upward
  change (or a member retrying a failed charge) is chased normally.

  The cutover is **derived, not hand-written**: it is the `startedAt` of the
  FIRST `CronJobRun` row for `additional-payment-reminders`
  (`resolveAdditionalPaymentChaseStartedAt`). If there is no such row, this pass
  is the first, so it sends nothing and the row it writes becomes the cutover —
  whenever the deploy actually happens. A hand-edited constant pinned to a
  migration date was the previous design and it was enforced by nothing: had the
  deploy slipped past it, every obligation raised in the gap would have been
  backlog mailed on the first pass, which is the exact failure the guard exists
  to prevent. Run rows are pruned after 90 days, which can only move the cutover
  forward to the oldest surviving run — still months behind anything this job
  chases three days after it is raised. A read failure sends nothing that pass:
  not knowing where the cutover is must never mean "email everyone".
- **What makes it idempotent.** Two nullable stamps on `Payment`,
  `additionalReminderSentAt` and `additionalFinalReminderSentAt`, written by a
  guarded `updateMany` BEFORE each send, so a cron rerun (or two runners
  racing) claims nothing and sends nothing. The stamps are read RELATIVE to the
  current obligation - which starts at the latest ADDITIONAL
  `PaymentTransaction.createdAt`, falling back to the payment row's own
  creation for legacy rows - so a stamp left by an earlier, settled delta never
  suppresses the chase for a later one, and no writer has to reset them.

  Every claim also FENCES the obligation the read decided on: the full owed test
  (booking status included), the exact `additionalAmountCents`, and no ADDITIONAL
  transaction newer than the episode being chased. The episode fence is the
  load-bearing one - a member retrying a failed charge mints a new Stripe intent
  and therefore a new ADDITIONAL transaction row at the SAME amount, which an
  amount-only pin would not notice; the email would quote the old obligation
  while the stamp (written at `now`) counted as the new episode's, burning its
  first reminder for good. A lost claim is re-read and re-decided rather than
  treated as another runner's win.
- **One clock for automatic and manual, in both directions.** An admin can
  re-send the same email from the booking page (`POST
  /api/admin/bookings/[id]/additional-payment-reminder`, `bookings:edit`,
  audited). It writes the stamp for whichever reminder is currently due - and
  when that is the last-chance one it closes BOTH stamps, exactly as the cron's
  own final branch does. Writing only the day-N stamp made the cooldown
  one-directional: an admin re-send inside the pre-arrival window was followed
  by the cron's near-identical email at the next three-hourly tick.

  `ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES` (60) is honoured by BOTH senders,
  in both directions: an automatic nudge inside the window refuses a manual one
  with a 429, and a manual one inside the window makes the cron read "not due"
  (in its decision AND in its claim's WHERE). Stamps alone were not enough — a
  manual send late on the NZ day before the last-chance window opens writes only
  the day-N stamp, and the next tick after NZ midnight would have found the
  final reminder unstamped and sent it minutes later. The cost is that a due
  reminder can slip to the following tick, three hours, not a lost email. On a
  send failure the stamps are given back, so a failed re-send never silently
  disarms the automatic chase.
- **Only a transmitted message counts as sent, and a stamp is only ever spent on
  a message that went out or one that will be replayed.** `sendEmail` RETURNS
  rather than throws when it withholds a message (a suppressed address, a
  walk-in placeholder address, the "No emails" switch flipping on after the
  check), so both senders inspect the outcome. The manual re-send answers with
  what really happened instead of a success. Both then apply the SAME rule with
  the SAME single exception: the stamps go back, unless the withhold was an
  UNREADABLE "No emails" switch, which leaves a `FAILED` `EmailLog` row the
  retry cron replays (re-checking the switch first) — restoring there would risk
  the member getting two copies, so the 503 reply says the message is queued and
  tells the admin not to re-send rather than inviting a retry the cooldown would
  refuse.
- **Silence is refused, not swallowed — and unreachability is checked before
  anything is claimed.** A booking with the "No emails" switch on is skipped by
  the cron with no stamp burned (so the reminder is still due once the switch
  comes off) and refused outright by the manual re-send with an explanation - an
  admin standing at the screen must not read a silent withhold as a successful
  send. Both fail CLOSED if the switch cannot be read. The cron additionally
  checks the recipient BEFORE claiming - a walk-in placeholder `.invalid`
  address, or an active bounce/complaint suppression - so an unreachable member
  costs one skipped pass instead of a burned stamp and a manufactured bounce row
  every three hours, and the reminder stays cleanly due for whenever the address
  is fixed or the suppression cleared. That pre-check is what makes the shared
  stamp rule above affordable in a job that runs eight times a day.

### INV-ADDPAY-002

Three side doors into the finished-unpaid state are closed at the door
(owner decisions 2026-07-11, #1723):

- **Past-dated waitlist force-confirm** (path 1, decision B — allow, flag at
  creation): a force-confirm that lands `PAYMENT_PENDING` on a booking whose
  check-out has already passed is allowed but flagged at creation —
  `createdUnpaidFinishedStay` in the audit details/metadata, an
  `unpaidFinishedStay` field in the route response, and an amber "Unpaid
  finished stay created" card on the admin waitlist page. $0 force-confirms
  (land `PAID`) and parked-for-review outcomes carry no obligation and are
  not flagged.
- **Upward modification of a settled past stay** (path 2, decision B): kept
  on the card additional-payment flow rather than blocked; the uncollected
  delta counts on the second queue above [INV-LOCKOUT-043].
- **Stale group join** (path 3, decision A — exclude): a group whose
  organiser booking's last night is over (`checkOut ≤ NZ today`, the same
  cutoff as the queues — a stay checking out today accepts no new joiners;
  an action window on dates, named as such by the stay-boundary invariant in
  "Booking Dates And Capacity", not a presence rule) leaves
  the joinable set entirely: `hasGroupStayFullyEnded` gates the public
  summary's `isJoinable`, the member join (409), the non-member join request
  (409 `GROUP_STAY_ENDED`), and the emailed-token verify (`not_joinable`),
  sitting directly after the open/deadline check and ahead of the
  payment-mode/active-booking gates.

### INV-ADDPAY-003

A booking left with only non-adults (YOUTH/CHILD/INFANT) requires admin
approval regardless of how it got there or whether it was already paid: every
edit path — including single-guest self-removal, which is never blocked for a
written justification — flags the booking (`adminReviewStatus: PENDING`, with
an automatic note on the removal path) so it lands in the admin review queue.
Review parking moves a booking to AWAITING_REVIEW only from the pre-payment
statuses (DRAFT/PENDING/PAYMENT_PENDING — DRAFT parks in create parity, #2266,
with `draftExpiresAt` nulled so the 72-hour expiry cannot sweep a booking out
from under its reviewer); a paid or confirmed booking is flagged in place, and
approving it clears the review without re-opening the payment lifecycle.
Rejection cancels through the shared cancellation flow, which refunds captured
payments per the policy (a legacy DRAFT-status queue entry — pre-#2266 rows
only — is cancelled directly by the review route with a guarded
DRAFT → CANCELLED flip, since a draft holds no capacity and has no payment).
The invariant is also **enforced at the doors, not only at the writers**
(#2266): `confirm-draft` and `create-payment-intent`'s DRAFT arm both refuse
(409) any booking with `requiresAdminReview` and a non-APPROVED
`adminReviewStatus`, so even a writer bug that leaves a review-flagged DRAFT
behind cannot let a minors-only booking reach PAID with its review pending.

### INV-ADDPAY-004

Because a paid minors-only booking is deliberately **not** parked to
AWAITING_REVIEW (Option A / F27, issue #1372 — parking a paid booking would
collide with the captured-money invariant #1100), a second gate protects the
child-safety concern: while a paid/completed booking carries a PENDING admin
review it is **blocked from lodge check-in**. The block is reason-agnostic
(#1422) — ANY pending admin review gates check-in, not only the adult-supervision
reason (today the only such reason, but a future review type inherits the gate
automatically). Server enforcement lives in the shared
`checkinNotBlockedByPendingReviewFilter()` where-fragment, which **excludes** the
booking from the arrive/depart and roster generate/confirm queries
(`src/lib/lodge-date-scoping.ts`) so its guest resolves to null server-side
(arrive returns 404, roster-confirm 400); the check-in reminder cron skips it as
well. The lodge **guest list** (the roster staff read on the kiosk) is the one
surface that now **shows** the blocked booking rather than hiding it — flagged
"Blocked from Check-In — see Booking Officer" with its arrival toggle disabled,
so staff can see who is held while the booking stays un-arrivable server-side
(defense in depth). The booking keeps its PAID status throughout; clearing the
review to APPROVED makes it check-in-eligible again. When the flag newly trips on
a paid booking a best-effort admin email fires (template `admin-minors-review`,
gated by its own `adminBookingReviewRequired` notification preference #1422),
since nothing changes the booking's visible status to signal the block.

### INV-ADDPAY-005

The member **edit** panel collects this justification proactively (#2104): it
mirrors the `requiresAdultSupervisionReview` predicate client-side (the same
inlined check the create wizard uses) and renders a required reason field as soon
as an in-progress edit would leave the post-edit party minors-only — unless the
viewer is acting as an admin (admins auto-approve) or the booking is already
flagged/reviewed (the server only demands a reason on the FIRST trip). As a
belt-and-braces fallback for any client/server drift, the modify route returns
the machine-readable `REVIEW_JUSTIFICATION_REQUIRED` code, on which the panel
reveals the same field and re-surfaces the request. The server
(`resolveModifyReviewUpdate`) remains the sole enforcer; the client field only
saves the member a round-trip.

### INV-ADDPAY-006

A quote hold spans the whole quote lifecycle (issue #1254). Sending a quote
places the hold automatically: the held booking (AWAITING_REVIEW, a
capacity-holding status) reserves the beds/guest-nights before the send is
finalized, so a quote is never emailed for dates it cannot reserve — if the
lodge is full the send fails loudly (409). The hold survives acceptance: on
accept/approve the same held row becomes the request's converted booking and
moves AWAITING_REVIEW → PENDING, which keeps holding via rule (b) above [INV-CAP-004], so an
accepted-but-unpaid quote does not lose its bed before payment. Accept and the
no-payment cancel are serialized on the global booking advisory lock (#1311): the
cancel re-reads the held status under that lock and flips to CANCELLED only while
it is still AWAITING_REVIEW/WAITLISTED/WAITLIST_OFFERED, so a cancel racing an
accept can never clobber the just-converted PENDING booking back to CANCELLED —
the loser returns 409. The guest swap
at accept updates the held booking's existing guest rows in place (stable
`bookingGuest` ids) instead of delete-then-recreate, so an admin's pre-assigned
`BedAllocation` rows, #713 night sets, promo guest targets, and chore
assignments are preserved. The hold is released on cancel (requester declines
the quote), expiry, or a capacity-reduction bump: the quote-expiry cron
(`cron-quote-expiry-reminders.ts`) frees the bed behind any SENT quote whose
response link has lapsed, and the accepted-but-unpaid booking is released by
the same hold-deadline machinery as any other PENDING request booking
(`cron-confirm-pending.ts`). Every release path detaches
`BookingRequest.heldBookingId` so a later re-quote can never reuse a released
row.

### INV-ADDPAY-007

An accepted-but-unpaid quote hold is **not** protected against a later reduction
of lodge capacity for its nights (owner-ratified, #1317). At the hold deadline
`cron-confirm-pending.ts` re-checks capacity for those nights under the booking
advisory lock; if capacity has since been lowered below what is booked, the
still-unpaid hold is bumped/cancelled (no charge, bumped email sent) exactly as
any other over-capacity PENDING request booking would be. The capacity-priority
rule above [INV-CAP-004] ("a later *member* booking can no longer bump an accepted-but-unpaid
quote") is unchanged — only an admin lowering the nightly capacity can reclaim an
unpaid hold. Paying the hold moves it to a fully capacity-holding status and ends
this exposure.

### INV-ADDPAY-008

School approval re-checks per-night capacity for the FINAL guest list on both
branches before anything flips to a capacity-holding status (#1352, #1911,
#1881). Fresh-create is a capacity-only admission and takes the canonical
per-lodge capacity lock. Held-reuse excludes the held booking's own guests from
the capacity check and takes global `lock(1)` -> per-lodge because it must
exclude cancellation/release of the existing AWAITING_REVIEW booking. It
re-reads the request and hold under both locks and claims
`AWAITING_REVIEW -> CONFIRMED` with a status-guarded update; a lost claim rolls
back every guest/member/payment/audit side effect. A hold reserves only the
originally held
guest count, so an admin child-count override at approval can never confirm
more beds than actually remain on any night; the admin sees the same
capacityExceeded outcome as the fresh path.

### INV-ADDPAY-009

A booking converted from (or held for) a public/school booking request keeps
the held booking's immutable concrete lodge even when the request stored a null
default-lodge selector and the configured default later changes. Held generic
and school conversions lock that concrete lodge, fully re-read the request and
booking, and reject any explicit lodge mismatch before mutation. The booking
keeps its officer-negotiated price, flat-split across guest rows; the quote's
per-tier rates are not persisted on the booking. Before a school group
arrives, the school contact confirms who is attending (#1101): a tokenized
public page (hash-stored, rotated per reminder email) applies identity-only
name updates through the same price-preserving machinery as quoted-booking
edits, and the explicit confirmation is stored on the booking request.
The booking's owning contact is an admin decision taken where the owner is
first materialised — a capacity hold, or approval when no hold exists (#1255):
the admin either creates a new non-login `NON_MEMBER`/`SCHOOL` contact or maps
the request onto an existing non-login `NON_MEMBER`/`SCHOOL` contact, and
mapping reuses that contact's Xero contact instead of spawning a duplicate. A
booking request is never mapped onto a `canLogin:true` member, a held request's
owner stays fixed until the hold is released (an admin **Release hold** action
cancels the `AWAITING_REVIEW` held booking through the shared cancel path,
freeing the beds and re-enabling the contact choice). Because this is an admin
re-mapping rather than a requester cancellation, the release suppresses the
customer "booking cancelled" email (`cancelBooking`'s
`suppressCustomerNotification` option — the detach/reconcile/audit still run),
and it deliberately does **not** revoke the requester's quote response token:
the link stays active, so the admin is warned to re-send a fresh quote after
re-mapping. Releasing a hold (and declining a held request) refuses with HTTP
409 rather than cancelling if the requester accepted the quote concurrently —
i.e. the held booking has already left `AWAITING_REVIEW` (`cancelBooking`'s
`requireRequestHold` guard, #1406) — so a just-accepted booking is never
cancelled and its payment links never revoked out from under the requester.

### INV-ADDPAY-010

An admin decline releases the capacity hold from ANY held/editor state, not just
`VERIFIED`/`PRICED` (#1423): a decline is valid from all six states the admin
panel shows the Decline button for — `VERIFIED`, `PRICED`, `QUOTED`,
`QUOTE_SENT`, `QUERY_PENDING`, `MODIFICATION_REQUESTED`
(`DECLINABLE_BOOKING_REQUEST_STATUSES`) — and each can carry a live
`AWAITING_REVIEW` hold that the decline frees (claim-first: the `DECLINED` flip
lands before any hold release, so a wrong-state decline `409`s and never touches
the hold).

### INV-ADDPAY-011

A DECLINED request is untouchable by every other actor. In the SAME transaction
as the `DECLINED` claim, the decline retires any outstanding `SENT` quote
(`SENT` -> `SUPERSEDED`; `SUPERSEDED` = admin retired it, distinct from a
requester-cancel `CANCELLED`). Because `loadSentQuoteByToken` requires
`status === SENT`, that retirement alone `409`s all four requester quote actions
(accept / modify / query / cancel) on a still-live link, and the pre-expiry
reminder cron (which selects only `SENT` quotes) skips the declined request
instead of nudging it. As defence-in-depth against a request finalised between a
requester POST's token load and its write, the accept re-arm, the modify/query
re-status, and the losing-accept capacity revert are each status-guarded with
`status notIn [DECLINED, CANCELLED]`: a late accept or modify/query `409`s (no
new booking, Payment, or PaymentLink; no resurrection to
`MODIFICATION_REQUESTED`/`QUERY_PENDING`), and the revert simply does not
un-decline the request. The guards still permit a re-arm from
`CONVERTED`/`APPROVED`, preserving approve's `convertedBookingId` idempotency
(#1232 double-accept returns the one existing booking). Per-teacher hut-leader records are always created fresh. The held owner is re-validated at conversion:
if a previously mapped contact is no longer a valid non-login contact by the time
the requester accepts (login enabled, archived, deactivated, role changed), the
accept still succeeds — a fresh non-login contact is substituted and both a
durable admin-attention audit row (`booking_request.owner_substituted`) and an
active `admin-owner-substitution` admin email alert (gated by the
`adminXeroSyncError` preference, F20 residual #2 / #1377) are raised post-commit
so the substituted Xero contact can be reconciled. When the Xero module is off, the
manual-invoice admin notification names the resolved booking owner (the mapped
contact when mapped), not the raw request school/contact.
Headcount or tier changes still go through the admin re-quote flow, and
unconfirmed lists inside the prompt window surface on the stuck-state
dashboard. Standard edit paths (batch
modify, date change, guest add, single-guest removal, and the modify-quote
preview) refuse such bookings rather than silently repricing every guest at
season rates — the change is made by re-pricing or issuing a revised quote
from the booking request. The one exception (#1099) is identity-only edits:
guest name fixes never run the pricing engine — stored totals, per-guest
prices, and night rows are echoed back unchanged on every booking, quoted or
not — so they pass the block, and quoted bookings are additionally exempt
from the paid-name lock (renaming placeholder students after the school has
paid its invoice is the intended workflow).

### INV-ADDPAY-012

The paid-name lock on free-text (non-member) guest names blocks changing who a
booking is for after full payment — an unauthorised transfer/resale. It has one
narrow exemption (#1386): on an **identity-only** edit (no structural change) of
a fully-paid, non-quoted booking, an identity-preserving spelling **typo** may
be corrected. A change qualifies only when, on names normalised as trim +
lowercase + collapse-internal-whitespace: (a) neither new part is blank; (b) the
first name and last name each keep the same word/token count (a typo never adds
or removes a name part); (c) no positionally-aligned token is a whole-token
replacement — for each aligned first/last token pair, at least half of the
longer token must be preserved (edit distance × 2 &lt; max token length), which
refuses surname-family swaps like "David Ng" → "David Wu" and "Ann Ho" →
"Ann Lo" even though their overall distance is ≤ 2; and (d) the
Damerau-Levenshtein distance (adjacent transposition = 1 edit) between the
normalised full names is at most `min(2, floor(0.25 × lengthOfLongerFullName))`
— at most two edits and never more than a quarter of the longer name, distance 0
(pure case/whitespace) included. Anything else keeps the hard reject ("only
spelling corrections are allowed after payment; contact the office to change who
a booking is for"), so a same-surname given-name swap ("John Smith" →
"Jane Smith", distance 3) and a full swap ("John Smith" → "Aroha Ngata") are
refused. The rule is enforced server-side (`src/lib/guest-name-similarity.ts`,
mirrored in the modify-quote preview); it never reprices or rechecks capacity
(the identity-only price-preserving path still applies), and every allowed fix
writes a `BookingModification` audit row discriminated as `GUEST_TYPO_FIX` (with
a `paidNameTypoFix` snapshot flag) carrying old→new names, actor, and time.
Member-linked guest names remain unrenameable regardless.

### INV-ADDPAY-013

**Residual risk (accepted, audit-mitigated):** the per-token and distance bounds
above stop wider swaps, but a SINGLE-character change that keeps most of a
token is fundamentally indistinguishable from a spelling typo by string
comparison, so short one-edit substitutions such as "Kim" → "Tim", "Sam" →
"Pam", or "Rob" → "Bob" are STILL accepted after payment. This is
self-serviceable by the booking owner (`booking.memberId === actor`) on
PAID/CONFIRMED bookings and cannot be closed in code. Its only mitigation is the
`GUEST_TYPO_FIX` audit trail, which admins should periodically review for
suspicious post-payment renames.

### INV-ADDPAY-014

A price reduction against an issued-but-unpaid Xero invoice (pay-on-account,
no captured payment) is corrected for the full net delta — there is no captured
money and therefore no cancellation-policy tier to apply — via a modification
credit note against the primary invoice, which is never reissued. Consequently
the true outstanding balance on such an invoice is the current `finalPrice`
plus any billed change fee, i.e. the original total minus the modification
credit notes already issued. Cancellation must clear that true outstanding and
must not read the captured-amount mirror (`payment.amountCents`), which stays at
the original total until asynchronous Xero reconciliation folds the credit note
into `refundedAmountCents`.

### INV-ADDPAY-015

The paid-path twin of that rule: cancellation of a booking with a captured
payment computes its refundable base as
`min(amountCents − refundedAmountCents, finalPrice + changeFee) − changeFee`,
never from the raw Payment mirror alone. Prior reductions can leave the mirror
stale (an Internet Banking invoice paid at its reduced amount, or a
penalty-window retention), and an uncapped base pays out more than the booking
is worth. The cancel preview applies the same cap so the member is never
promised more than the cancel will pay.

### INV-ADDPAY-016

A credit-settled modification reduction allocates against the payment's
captured transactions (`applyLocalRefundAllocation`) in the same transaction
that writes the `MemberCredit`, exactly as a card-settled reduction does via
the refund ledger. `refundedAmountCents` therefore reflects every settlement
method, and no ordering of edit/cancel operations may produce a different
total payout (refunds plus credits) than another ordering reaching the same
final state.

### INV-ADDPAY-017

A net-positive booking edit that mixes a price reduction with a larger
late-change fee bills Xero the SIGNED components on one supplementary invoice
(#1356): a negative price-adjustment line beside the positive fee line, so the
invoice total and the payment recorded against the Stripe clearing account
both equal the net the member was actually charged — the same net the
additional Stripe PaymentIntent captured. The negative line posts to the
`hutFeeRefunds` account mapping, like every other give-back (a club that
prefers a single ledger line maps `hutFeeRefunds` to the same code as
`hutFeesIncome`); positive lines stay on `hutFeesIncome`. Clamping the negative component
would over-record income and Stripe-bank receipts by the dropped reduction
and break bank reconciliation. A supplementary invoice exists only for a
positive net; a mixed-sign edit whose net is zero or negative settles through
the modification credit-note paths, and both the outbox enqueue and the
executor refuse (skip, replay-safely) rather than gross-bill the fee. The
booking-vs-Xero repair pass applies the same rule: it verifies supplementary
invoices against the modification net and queues missing ones with the signed
components. On the credit-note side the repair pass sizes by STORED evidence
(#1427): abs(net) is only an upper bound, because the primary path caps the
credit at the policy-limited settlement the modification row cannot
reconstruct. Queue actions and the amount-evidence expectation prefer the
resolved note's own enqueue payload (then oldest-first — the first enqueue
is the primary-path settlement decision; CANCELLED attempts rank last), and
replaying that amount rebuilds the identical amount-embedding correlation
key, so the local outbox dedup holds and a recent attempt that already
reached Xero dedups within Xero's idempotency window — then link metadata,
then executed note totals, then (last resort) a bare legacy payload.
Operation evidence, object resolution, and blocking detection are all
discriminated by the operation's queue-type hint: the immutable `queueType`
COLUMN (#1347), then the payload's own name, then the correlation-key
segment — decisive for the pre-column executed ledger, whose payloads were
overwritten at dispatch before the column backfill copied them. An
account-credit-note op beside the invoice-applied note (same
entityType/operationType) therefore never sizes, resolves as, blocks, or
pollutes the mismatch evidence of the invoice-applied note — in the
worst case that confusion allocated the member's UNAPPLIED account-credit
note against the already-paid primary invoice (double-refund exposure). A
net-negative modification positively settled by an account credit note (link
role or executed op hint) is complete as-is: it has no invoice-applied note
to repair and produces no finding. A
stored amount outside (0, abs(net)] is ignored as inconsistent, so an
over-sized note still flags against abs(net); the deliberate limit of
evidence-first is that a wrongly-enqueued amount INSIDE the range reads as
the app's recorded decision and reports clean — the alternative (flagging
every non-abs(net) note) drowned real drift in a false positive on every
policy-tiered booking. When no stored evidence exists and the payment has
captured money (by aggregate status or a captured transaction row), BOTH the
missing-note queue and the missing-allocation queue become manual-review
findings instead of auto-applying abs(net); auto-queueing abs(net) remains
correct only for the no-captured-payment case, where the full delta is a
pure bookkeeping correction (#1015). A live-but-not-retryable credit-note or
allocation operation surfaces as blocked rather than silence (and a
FAILED-unretryable one says so, not "pending"). The manual retry stack replays the operation's STORED amounts
first (the #1354 queued-payload-first rule): the Xero idempotency key embeds
the amounts, so replaying the enqueued values keeps the retry deduplicable
against the original attempt, preserves a policy-limited credit-note
settlement the modification row does not record, and lets the enqueue-time
`queueType` distinguish an unapplied account-credit note from an
invoice-applied one. Only fully-legacy rows fall back to the signed
modification record — a rebuilt supplementary invoice keeps its reduction and
a rebuilt credit note refunds the absolute net, never the absolute price
component alone (which would over-credit by the fee).

### INV-ADDPAY-018

A cancellation's card-refund debt must be durable before any external call
(#1349): the claim transaction that flips the booking to `CANCELLED` also
writes the payment-recovery operation, carrying the per-transaction refund
allocation frozen from the under-lock read. No crash point between the claim
commit and the Stripe refund may leave the debt unrecorded, and no combination
of the inline refund and the recovery cron may pay it twice — both execute the
same frozen slices, so they mint identical Stripe idempotency keys and Stripe
replays rather than repeats. The mirror of this rule is the group-cancel
settlement, which persists its per-child `refundPlan` before its Stripe refund
for the same reason.

### INV-ADDPAY-019

Xero contact resolution (`findOrCreateXeroContact` /
`createXeroContactForMember`) performs every provider call — OAuth refresh,
searches, creates, and their retry sleeps — OUTSIDE any database transaction
(#1355): concurrent duplicate creation is bounded by the member-scoped Xero
idempotency key, and only the local link write takes a SHORT advisory-locked
transaction with a re-check (first-writer-wins against a concurrent
resolver). Operation-log success is recorded post-commit only; a local-link
failure after the Xero call marks the operation FAILED, never SUCCEEDED for
rolled-back state.

### INV-ADDPAY-020

Stepped Stripe refunds settle into Xero as per-delta credit notes whose cents
must sum exactly to the payment's refunded total (#1354). The amounts billed
to Xero are derived from EXECUTION-TIME state (`refundedAmountCents` minus the
sum of active covering notes), never trusted from an enqueue-time watermark —
so operations executing out of order, replays through the retry stack (which
re-enters delta mode via the queued payload or the enqueue-time `queueType`
column), and races between enqueue and execution all converge on the same
books. Inbound reconciliation MERGES link metadata over the outbound
per-delta keys instead of replacing them; the outbox processor fails errored
operations for every queue type (keeping them replayable rather than
RUNNING-stuck dead-ends); the daily credit-reconciliation cron re-enqueues
the uncovered delta for any flagged payment so historical gaps self-heal; and
a partial unique index allows at most one ACTIVE outbox operation per
correlation key (owner-approved defence in depth — terminal rows may repeat
the key across attempts).

### INV-ADDPAY-021

For `source: STRIPE` payments the local refund ledger is Stripe-truth and
inbound Xero reconciliation may only raise it, never lower it (#1353). The
inbound credit-note repair keeps the local `refundedAmountCents` when the
Xero-derived total is below it (logging and raising the deduped Xero sync
alert instead of rewriting), and never flips a REFUNDED/PARTIALLY_REFUNDED
Stripe payment back to SUCCEEDED from Xero-derived data — an operator voiding
a refund credit note in Xero cannot "un-refund" money Stripe has already paid
out, and a missing refund-delta credit note can no longer silently lower the
ledger the missing-credit-note detector compares against (which previously
self-masked the divergence). Internet Banking payments are the deliberate
exception: Xero is their payment rail, so the repair remains authoritative in
both directions for them.

### INV-ADDPAY-022

Cancelled-booking soft-delete may hide an operational duplicate only when it
preserves the booking row and no external money/Xero history needs to remain
operator-visible by default. Balanced internal modification deltas that net to
zero are not external financial history by themselves.
