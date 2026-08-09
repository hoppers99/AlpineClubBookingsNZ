# Booking Requests

Audience: Developer, Agent.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) · Scheme and
allocation rules: [`_PHASE1_SCHEME.md`](_PHASE1_SCHEME.md).

Prefix defined in this file: **`INV-REQ`** (which of a Booking Officer's two
notes a member reads, and what the member's own request area is allowed to say
about a request's state).

Read this file when you are changing booking-request notes and the member's own
request area.

Every `###` heading below is an invariant ID. IDs are permanent and are never
renumbered — see the allocation rules in the scheme. The text under each ID is
copied verbatim from `docs/DOMAIN_INVARIANTS.md`; only the ID heading lines were
added.

## The officer-note split on booking requests (#2562)

### INV-REQ-001

A Booking Officer's decision carries **two** notes, and which audience reads which
is an invariant, not a convention. It is **table-wide**, which means all three
officer surfaces that decide a request on these tables and not just the
policy-exception one: `BookingChangeRequest` holds both kinds of row, and its
LOCKED_PERIOD half is decided from a different panel
(`booking-change-requests-panel.tsx` → `PATCH
/api/admin/booking-change-requests/[id]`) that writes the same column.

### INV-REQ-002

- `adminNotes` is **member-visible**, on both request tables and for both kinds of
  `BookingChangeRequest` row. It is the decision explanation, written for the
  member: rendered on their own request list, on their booking page under "Change
  Requests", and interpolated into the approval and refusal emails. Every officer
  screen labels it as member-visible *before* the decision is submitted, so nobody
  discovers the audience afterwards. A box headed only "Admin notes" over this
  column is a defect — it is what let an officer type a judgement about a member
  into the sentence that member then read verbatim.

### INV-REQ-003

- `internalNotes` is **never member-visible**, on either table or either kind. It is
  the officer's private commentary — a judgement about the member, a reference to
  somebody else's booking, a note for the next officer — and is read only by
  admin-guarded surfaces (the two officer queues and the per-request detail
  endpoint, all behind `requireAdmin`). Every officer surface that offers the
  member-facing field offers this one beside it, because an officer with no private
  field writes private things in the public one.

### INV-REQ-004

Four structural properties hold that boundary, so it does not depend on any single
call site remembering it:

1. **The member DTO has no slot for it.** `toMemberExceptionRequestItem`
   (`src/lib/member-exception-requests.ts`) is a strict allowlist that never spreads
   a row, and its INPUT type does not accept `internalNotes` — handing the private
   note to the member projection is a typecheck failure, not a privacy incident.
2. **Every member-reachable read names its columns and omits the column.**
   `readMemberExceptionRequests` does, and so does every handler on
   `/api/bookings/[id]/change-requests` — GET **and** POST — through the shared
   manifest in `booking-change-request-member-view.ts`, whose census test proves the
   two halves of the manifest cover the whole scalar enum. So a column added to the
   model fails that test until somebody decides in writing whether a member may read
   it, and on the member path there is nothing in memory for a later mapper edit to
   leak. The member's booking page selects `adminNotes` and not `internalNotes`.
3. **No email, notification or member-facing template names it.** The approval and
   refusal emails compose their optional line from `adminNotes` alone.
4. **The audit log records its EXISTENCE, never its text**
   (`internalNoteRecorded: boolean`). The audit trail is read by more surfaces than
   the officer queue, and copying the text there would make it private in one place
   and not the other.

### INV-REQ-005

**A private note is never a substitute for the member-facing one.** Refusing a
policy-exception request still requires `adminNotes`, and so does approving an
adult-member hosting exception (D-R4's reason-for-the-record): a refusal the member
cannot read is a refusal they cannot act on. The exception decision route says so
in its own 400 message rather than silently accepting an internal note in its
place, and the locked-period panel keeps BOTH decision buttons disabled until that
request's own member-facing field is filled in. "That request's own" is part of the
rule, and it is held STRUCTURALLY rather than by a marker: the panel draws every
open request's form at once and keeps **one draft per request id**
(`decisionDrafts[request.id]`), which each field reads, writes and submits from, so
a note begun against one request is neither submitted with another nor able to
unlock another's buttons — whichever field is typed in, in whatever order. Two
earlier shapes both failed that: the original guard read
`reviewingId === request.id && !adminNotes.trim()`, which left every untouched row
decidable with no explanation at all; the shared-slot repair that followed still let
the internal-note and modification-id handlers move the ownership marker while the
previous row's sentence sat in the shared slot, so a keystroke on one card put
another member's explanation into this card's field, unlocked its buttons and posted
it under that member's request. The sibling policy-exception queue is an accordion
(one `openId`, one mounted form, draft reset on open) and its decision path refuses
to act for any card that is not the open one.

### INV-REQ-006

The column is an expand-only addition
(`20260803040000_add_policy_exception_internal_notes`), nullable with no backfill on
both tables, so a decision written by an older deployment carries `internalNotes`
NULL — which reads correctly as "the officer left no private note", because that
deployment had no field to write one in.

## The member's own request area (#2562)

### INV-REQ-007

The member-facing projection of an exception request states only facts, never
intentions:

- **Capacity comes from the reservation ledger, never from the policy's capacity
  mode.** `capacityHeld` is true only where live `PolicyExceptionReservationNight`
  rows exist. It is therefore false for **every** new-booking request whatever its
  mode says (the ledger keys to an existing `BookingChangeRequest`, and there is no
  booking yet), and false for a modification whose incremental footprint came out
  empty — a pure shrink. The generic sentence "your beds are held while we review"
  is false for the whole new-booking population and appears nowhere.
- **A recorded conflict is reported, not hidden.** A `REQUESTED` row with
  `lastConflictAt` set reads as "an officer tried and the lodge was full", never as
  "nobody has looked". Those are different facts and the second is one the member
  would act on.
- **Approval is never described as the moment beds are secured**, on either the
  pending or the approved sentence. An approval creates the booking the member's own
  wizard would have created (PENDING or PAYMENT_PENDING), which holds nothing until
  it is paid, so a pending new-booking row says availability is rechecked at review
  *and* that an approved new booking still holds no beds until it is paid.
- **The created booking is described from TWO facts about its own row**, both
  established by the caller and neither derived from the other:
  `createdBookingHoldsCapacity` (`bookingHoldsCapacity`) and
  `createdBookingAwaitsPayment` (still inside `ACTIVE_BOOKING_STATUSES`). "Holds no
  beds" is equally true of an unpaid booking and of a cancelled or reaped one, so the
  instruction to open it and pay it is conditional on the second fact; a closed
  booking gets a sentence that says it is no longer live, and an unreadable one gets
  the rule with no instruction at all.
- **Withdraw and replace are offered only where the API would accept them**,
  derived from the same `status = REQUESTED` condition the cancel and supersede
  services' guarded claims name.
- **The request action is offered only where the SERVER classified the refusal as
  reviewable.** One shared rule (`readExceptionOffer`,
  `src/lib/booking-exception-offer.ts`) decides it for both wizards, and it fails
  closed: an allowlist of reviewable refusal codes that can never contain a
  hard-stop code, a required non-empty `exceptionReview`, the server's own
  `exceptionEligible: true` on every violation, and a known capacity mode. One
  unrecognised violation disqualifies the whole refusal, because a request can only
  override the rules it froze.
