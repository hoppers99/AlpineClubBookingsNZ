# Concurrency and advisory locking

How the app serialises the operations that would otherwise race — overbooking a
lodge, double-restoring a member's credit, two people holding the same night,
two runners generating one roster, a settle racing a reap. The primary
cross-row mechanisms here are **PostgreSQL transaction-scoped advisory locks**
(`pg_advisory_xact_lock(...)`): they are held for the life of the enclosing
transaction and released automatically on commit or rollback. Narrow
`SELECT ... FOR UPDATE` protocols and one maintenance-only table-lock protocol
also exist and are inventoried below. All writers additionally follow the
status-guarded-claim rule described below.

This doc maps **which locks exist, what each one protects, how they interact,
and the ordering every writer must follow**. Read it before changing any lock
key, adding a capacity/credit/settlement write path, or converting a global lock
to a scoped one (or the reverse).

> Why advisory locks and not unique constraints? Several of these invariants are
> cross-row or cross-table (e.g. "a member can't hold two bookings covering the
> same night" spans `BookingGuest` → `Booking`), or need a **partial** unique
> index Prisma cannot express and `db:check-drift` would then reject. Where a
> DB constraint *can* carry the invariant it is preferred (and, since #1636, the
> credit-restore exactly-once guarantee IS a unique constraint — see below);
> where it can't, an advisory lock serialises the check-then-write instead.

## The two-tier protocol (#1881)

The multi-lodge migration split what used to be one club-wide lock into two
tiers. **Getting the tier — and the acquisition order — wrong re-opens the exact
money/capacity races the locks exist to prevent.**

### Tier 1 — per-lodge capacity claims

`acquireLodgeCapacityLock(tx, lodgeId)` (`capacity.ts`) serialises **bed/capacity
claims for ONE lodge**. Bookings at different lodges never contend, so two
members booking different lodges proceed in parallel. Every path that reads
occupancy and then claims a bed (create, confirm-from-draft, settle-to-CONFIRMED,
date/guest modification, waitlist confirm, the Internet-Banking capacity gate)
takes this lock keyed on the booking's own lodge.

### Tier 2 — global booking-status / money serialisation

`pg_advisory_xact_lock(1)` (the literal global lock) serialises **status
transitions and money side effects that must be mutually exclusive across the
whole booking regardless of lodge**: cancel, capture/settle, hold-release, the
group-settlement reaper, refunds, and credit restoration. These are not
per-lodge concerns — a cancel and a capture of the *same booking* must exclude
each other whatever lodge it is at — so they share the single global key.

### A writer that does BOTH takes BOTH — global first

Many writers do both tiers at once: a Stripe capture claims capacity **and**
moves money; a date modification reprices/refunds **and** re-checks capacity; a
quote-accept flips booking status **and** holds a bed. Every such writer:

1. takes the **global `lock(1)` FIRST**, then
2. takes the **per-lodge lock**.

The global-before-per-lodge order is fixed everywhere so composing the two can
never deadlock. Writers that compose several *same-family* locks (multiple
per-lodge locks, or multiple per-member locks) acquire them in **sorted key
order** for the same reason.

### Status-guarded claims (defense in depth)

Every status-transition write in the cluster is a **status-guarded
`updateMany`**, not a bare `update` by id:

```ts
const claimed = await tx.booking.updateMany({
  where: { id, status: <expected status(es)> },
  data: { status: <new status>, ... },
});
if (claimed.count === 0) { /* lost the claim — bail, no side effects */ }
```

Under the correct lock this is belt-and-braces (the under-lock re-read already
established the status), but it makes the "no clobber" guarantee **structural**
rather than purely lock-dependent: a writer that somehow slipped the lock still
cannot flip a booking a concurrent writer already moved.

### Email retry authority uses a guarded row claim, not an advisory lock (#2362)

`cron-email-retry.ts` composes no booking, capacity, membership-lifecycle, or
money mutation. It reads the booking and recipient only to decide whether a
retained authenticated detail URL may still be disclosed to the current
direct/inherited mailbox, re-finalizes the local delivery copy, then keeps the
existing `EmailLog` `FAILED -> QUEUED` guarded `updateMany` claim before SMTP.
Both that claim and a fail-closed retirement match the selected row's status,
attempt count, legacy body, and rollback-isolated booking body, so only one
concurrent runner can move the snapshot; losing either guard sends nothing.
The additive `EmailLog` authority columns introduce no advisory-lock key or
transaction participant; provider delivery remains outside a database
transaction. New booking rows keep `htmlBody` null and retain retry HTML only in
`bookingRetryHtmlBody`, which the old worker cannot select after rollback.

## The lock families

All keys below are the argument(s) to `pg_advisory_xact_lock`. Two-argument keys
use `(namespace, subject)`; single-argument keys hash a descriptive string or
are the literal `1`.

| Lock | Key | Helper / where | Tier | Serialises |
| --- | --- | --- | --- | --- |
| **Global booking / money** | `1` (literal) | inline `tx.$executeRaw` | 2 | Booking-status + money side effects that must exclude across the whole booking regardless of lodge: cancel, capture/settle, hold-release, group-settlement reaper/settle/refund/organiser-cancel, refunds, credit restore. |
| **Per-lodge capacity** | `hashtextextended(<lodgeId>, 0)` | `acquireLodgeCapacityLock(tx, lodgeId)` (`capacity.ts`) | 1 | Capacity claims/checks for one lodge. |
| **Per-member night footprint** | `hashtext("booking-member-night"), hashtext(<memberId>)` | `lockBookingMemberNights(tx, guests)` (`booking-member-night-conflicts.ts`) | cross-lodge | Serialises the person-night guard ACROSS lodges (see below). |
| **Per-member credit ledger** | `hashtext("member-credit-ledger"), hashtext(<memberId>)` | `lockMemberCreditLedger(memberId, tx)` (`member-credit.ts`) | — | A member's credit-ledger balance operations (spend, negative-adjustment validation, orphan-restore repair, the Xero inbound applied-credit repair, and the F20 pre-payment-reduction applied-credit clamp `clampAppliedCreditToBookingPrice`, taken inside the modification transaction only when the booking carries applied credit, and the #2265 stored-election consumption `consumeStoredCreditElection`, taken inside the `create-payment-intent` pay transaction and the Internet Banking switch transaction only when the booking carries an outstanding election). |
| **Member lifecycle** | `hashtext("member-lifecycle:<memberId>")` | inline (`member-lifecycle-actions.ts`, `nomination.ts` approval mapping, `admin-family-group-requests-service.ts`, `member-merge.ts`) | — | Archive/delete of one member; overwrite of one member by application-approval mapping (E10, #1936); linking/removing one member into/from a family group on admin request review; and **member merge** (dual-lock on master + loser, E11 #1937, see below). |
| **Membership application** | `hashtext(<application key>)` | `membershipApplicationLockKey` (`nomination.ts`) | — | State transitions of one membership application. |
| **Membership applicant** | `hashtext(<applicant-email key>)` | `membershipApplicationApplicantLockKey` (`nomination.ts`) | — | Per-email applicant dedup at submit time. |
| **Roster generation** | `hashtext("roster:<date>")` | inline (`admin-roster-service.ts`) | — | Roster generation for one calendar date. |
| **Config-transfer import** | `hashtext("config-transfer-import")` | `acquireConfigImportLock(tx)` (`config-transfer/apply.ts`) | — | Single-flights configuration-bundle apply. |
| **Minimum-stay policy set** | `hashtext("minimum-stay-policy-set")` | `lockMinimumStayPolicySet(tx)` (`minimum-stay-policy-set.ts`) plus the migration's `MinimumStayPolicy_lock_set` statement trigger | policy config | Serialises every live CRUD and config-transfer replacement across the small club/lodge policy set. The database trigger puts draining old-colour DML behind the exact same key before any tuple lock. |
| **Membership subscription billing** | `hashtext("membership-subscription-billing:<seasonYear>")` | `confirmSubscriptionBillingPreview`, `reconcileSubscriptionBillingExceptions` (`membership-subscription-billing.ts`) | — | Annual/approval charge snapshot creation for one membership year; the #2148 refresh-reconciliation holds the same key so exception auto-resolution serialises with confirm and never resolves rows a concurrent confirm is regenerating. The #2161 operator family-marker writers (MARK/UNMARK on the subscription-billing route) deliberately take **no** advisory lock: they only insert/release a `FamilyGroupSeasonInvoiceMarker` row (single-active enforced by a partial unique index, so a concurrent double-mark is a benign no-op), and confirm re-derives suppression from the live marker rows under this same lock inside its transaction, so a mark landing mid-confirm either is seen by the in-tx re-preview or shifts the confirmation token — never a torn snapshot. |
| **Authoritative fee schedule** | `hashtext("fee-schedule:<domain>:<key>")` | `lockFeeSchedule` (`authoritative-fees.ts`) | — | Serialises effective-dated membership or entrance-fee schedule changes for one configured key. |
| **Member partner link** | sorted `hashtext("member-partner-link:<memberId>")` keys | `lockPartnerMembers` (`member-partner-link.ts`) | — | Serialises partner-link invariants across every member touched by a link; same-family keys are sorted. |
| **Xero member contact link (legacy key)** | `hashtext(<memberId>)` | short local-link transactions (`xero-contacts.ts`) | — | First-writer-wins local `Member.xeroContactId` linking after provider work. This legacy unnamespaced key is shared by both Xero contact-link writers; do not copy it for new domains. |
| **Backup run claim** | `hashtext("backup:run-lock")` | `claimBackupRun` (`backup-run.ts`, #2095) | — | Single-flights managed database backups across containers (nightly cron vs admin run-now). Held only for the milliseconds of the reap-stale → active-check → insert-RUNNING claim transaction; the `pg_dump`/upload pipeline runs entirely outside any transaction, so a crashed run can never wedge the lock (a dead RUNNING row is reaped by heartbeat age on the next claim). Single-lock holder; composes with no other family. The config-transfer pre-apply safety backup deliberately bypasses this claim (it must run inline; concurrent dumps are independent snapshots writing uniquely-named files). |

### Composition: minimum-stay policy set (#2363)

`POST /api/admin/booking-policies/minimum-stay` and the row-level `PUT` and
`DELETE` routes call `lockMinimumStayPolicySet(tx)` before their first policy or
lodge read, then re-read/validate and write inside the same transaction. The
policy set is club-sized, so one global configuration key is intentionally
preferred to per-scope concurrency: it gives every writer one unambiguous lock
order across a blue/green drain.

The additive migration also installs `MinimumStayPolicy_lock_set`, a `BEFORE
STATEMENT` trigger for INSERT, UPDATE and DELETE. A draining old colour cannot
call the TypeScript helper, but PostgreSQL takes the same
`hashtext("minimum-stay-policy-set")` transaction lock before that statement
reaches any row. New-runtime DML merely re-enters the lock it already holds.
This keeps both colours in **advisory → tuple row** order; do not move this lock
into a row trigger, which would invert old-colour order against the new routes.
A separate `BEFORE ROW` trigger manages only the integer revision after the
statement lock is held: material old-colour updates advance an unchanged token,
new `OLD + 1` CAS writes are not double-incremented, and non-material writes keep
the old token.

Configuration transfer composes two global configuration keys in one fixed
order: `config-transfer-import` **first**, then `minimum-stay-policy-set`, before
the booking-policy category re-fingerprints or replaces any rows. Live CRUD
takes only the second key, and no policy writer takes them in reverse, so this
composition cannot form a cycle. The database statement trigger re-enters the
second key during import DML.

#### Which client reads the policy set

`validateMinimumStay` (`booking-policies.ts`) takes an optional trailing `db`
that defaults to the module-level Prisma client. The rule is one line: **a
caller already inside `prisma.$transaction` MUST pass its own `tx`.** Two
callers are in that position — `modifyBookingBatch`
(`booking-batch-modification-service.ts`) and `modifyBookingDates`
(`booking-date-modification-service.ts`) — and both run the check while holding
`pg_advisory_xact_lock(1)` **and** the per-lodge capacity lock. Reading through
the module client there checks out a **second pool connection underneath both
locks**, which is the pool-starvation shape the ordering rule at the top of
`member-guest-add-policy.ts` exists to forbid: under load every connection can
end up held by a transaction waiting for a connection. Passing `tx` also gives
the check the transaction's own snapshot instead of a second, later one.

Every other caller is deliberately OUTSIDE a transaction and keeps the default:
booking create, both public group-join stages, the member group join, the two
waitlist-offer confirm paths, the advisory modify quote, and the policy-check
route. Those are pre-write checks with no lock held, so the module client is
correct and cheapest there. The residual window between such a read and the
claim that follows it is milliseconds and is the same footing every other
pre-write policy check on those paths sits on.

This is a **pool** argument, not a lock-order one: no minimum-stay policy writer
ever takes a per-lodge capacity lock, and no booking path takes the policy-set
key, so the two keyspaces are disjoint and cannot deadlock in either order.
`booking-batch-modification-minimum-stay.test.ts` and
`booking-date-modification-minimum-stay.test.ts` each pin their call site to the
transaction client so a future edit cannot silently reintroduce the second
connection.

### Composition: application-approval mapping (E10, #1936)

The membership-application approval transaction is the one writer that composes
the application and member-lifecycle families. Its fixed acquisition order is:

1. `member-application:<applicationId>` (the existing approval lock), THEN
2. every mapped target's `member-lifecycle:<memberId>`, in **sorted key order**.

Counterpart analysis — no cycles are possible:

- Every other `member-lifecycle` holder is single-lock in that family:
  member archive/delete approval (`member-lifecycle-actions.ts`) locks exactly
  one member and takes no application lock; the admin family-group request
  review transactions (`admin-family-group-requests-service.ts`) lock exactly
  the one pre-existing member being linked into (or removed from) a group
  before writing `FamilyGroupMember` — required because a `FamilyGroupMember`
  insert does not bump `Member.updatedAt`, so only the lock (not the mapping
  preview token) can serialise it against the mapping approval's
  in-any-family-group collision guard. (The group-create *reject* transaction
  takes no member lock: it links nobody into a group.)
- No `member-lifecycle` holder ever acquires a `member-application` lock, so
  the application → member-lifecycle direction is one-way.
- Within the member-lifecycle family the approval acquires multiple keys in
  sorted order, matching the same-family rule above.

The F20 clamp inserts any required Xero deallocation outbox row before releasing
the member-credit lock. Provider GET/delete/recreate calls run later, outside the
transaction; ambiguous provider state fails to durable retry/manual review.
Allocation and deallocation handlers detect another RUNNING operation for the
same Payment. Separate runners can claim both rows before either check, so this
contention uses a dedicated transient result: each loser returns to PENDING
(never FAILED), and a later scan runs them without overlap. A post-recreate
verification (or next-run top-of-loop guard) mismatch that is explained purely by
Xero eventual consistency relative to the durable checkpoints — a just-deleted
allocation still listed, or a just-created recreate not yet listed — reuses that
same transient PENDING requeue (bounded, so persistent non-convergence still
lands FAILED) instead of failing terminal; only a mismatch no eventual-consistency
projection explains stays terminal. Provider-verified
local slice/link reconciliation retakes the member ledger lock.
The deallocation worker's first member-locked transaction records one durable
snapshot of desired applied cents plus all precise slices. Clamp, inbound repair,
and allocation planning query the deallocation fence under that same lock.
A fresh PENDING row fences inbound/clamp writers so stale provider truth cannot
undo the committed local target. Allocation/deallocation workers may pass it to
preserve queue order only while it has no snapshot/checkpoint; a manually
requeued checkpointed PENDING row remains fenced, as do RUNNING and any
provider-ambiguous failure states. Manual retry only CAS-requeues to PENDING;
the outbox claim is the sole authority that may execute provider calls.

The `create-payment-intent` pay transaction (#2265) does all three tiers of
work — it flips a booking's status, it claims capacity, and it moves credit —
so it takes all three locks, in the house order: the global booking lock(1)
first, then the booking's per-lodge capacity lock, then (inside
`consumeStoredCreditElection`) the per-member credit-ledger lock. lock(1) is
what makes it mutually exclusive with cancel, capture and the settlement paths;
without it the status writes could resurrect a just-cancelled booking. Every
status, capacity and money decision consumes a post-lock re-read, never the
pre-transaction snapshot.

Both arms of that transaction take both booking-tier locks. The DRAFT arm
capacity-checks (DRAFT-scoped exemption: a DRAFT can never carry a persisted
override) and claims `DRAFT -> PAYMENT_PENDING` with a status-guarded
`updateMany`. The already-`PAYMENT_PENDING` arm — an admin-released
`AWAITING_REVIEW` booking — re-checks capacity too and honours a persisted
override (#1771), which that arm CAN carry: it may settle the booking at $0
below, and a settle without a capacity claim is exactly what the other settle
paths refuse to do. On a capacity refusal it 409s; nothing was charged, so
nothing is cancelled or refunded.

The election itself is taken with a guarded claim: `updateMany` matching the
booking id, `PAYMENT_PENDING`, and the exact amount that was read under the
ledger lock, in the same transaction as the ledger write. Two racing consumers
therefore cannot both apply the credit — the loser matches zero rows and
returns "nothing to do" rather than a phantom outcome its caller would act on
(a second confirmation email, a second Xero invoice, a second `MEMBER_PAID`
event). The $0 settlement's `PAID` write is status-guarded the same way and
throws on count 0, rolling the credit application back with it.

The Internet Banking switch consumes the election under the same three locks it
already held, after its capacity decision, so a refused switch leaves the
election intact. Every provider call (the Stripe intent, the confirmation
email, the Xero invoice queue, the superseded-intent drain) stays outside the
transaction.

The settlements CLEAR the election with the same guarded-claim discipline
(#2319). `clearStaleCreditElection` moves the column from the exact amount read
to NULL and reports whether the claim landed, so a settle running alongside a
consumer never clobbers it: either the consumer already applied the credit (the
claim matches nothing and the settle reports "nothing stale", which matters
because a phantom clear would tell the member their credit went unapplied when it
had just been applied) or the consumer has yet to run and is untouched. The three
clearing writers all hold lock(1), which both consumers also take, so the guard
is belt and braces rather than the primary defence — but the property no longer
depends on that lock still being there. The writers are
`markBookingPaymentSucceeded`'s `PAID` claim, the Internet Banking inbound
reconcile's `PAID` and late-capacity-failure `CANCELLED` flips, and the
repriced-to-$0 auto-pay in both modification services. Each clear's reporting —
the audit row and the operator alert — runs POST-commit, outside the transaction,
because it sends email; the public payment link's refusal for an election-bearing
booking is signalled out of its transaction by a private error for exactly the
same reason.

Never-captured cancellation and Internet-Banking hold expiry acquire global
booking lock(1) first and the per-member credit-ledger lock second. While
holding both, they query for any non-complete applied-credit deallocation
before their first write. If one exists they defer the whole transition; a
later retry computes the clearing amount from provider-converged slices. The
paid/captured cancel (refund) path does not take the credit-ledger lock or this
fence: it restores credit from the payment mirror (mirror-based and capped) and
never sizes clearing from slices. Legacy inbound rows missing
those slices are repaired under the member-credit lock only when a unique
positive funding lot proves provenance. Slice reduction/deletion is therefore
working state, while the operation checkpoint/history and inactive/active
object-link history preserve the durable audit trail.

The first four are the **booking / capacity / credit cluster** — they interact,
and are where the ordering discipline matters. The remaining rows are
independent single-domain locks. Their namespaced keys do not intentionally
contend with the cluster or each other. The legacy Xero member-contact key is an
explicit exception: retain it only for its two current counterpart writers and
do not use unnamespaced `hashtext(<id>)` for new lock families.

### Narrow row- and table-lock protocols

- **Trusted legacy induction baseline** —
  `src/lib/induction-baseline.ts` (`runInductionBaseline`, #2361): apply takes
  `LOCK TABLE "MemberInduction" IN SHARE ROW EXCLUSIVE MODE` as the **first
  database statement** in its Serializable transaction. The mode conflicts
  with the `ROW EXCLUSIVE` lock PostgreSQL takes for every insert, update, or
  delete on `MemberInduction`, including cascade deletes, so the command first
  waits for existing direct induction DML and then makes later direct DML wait
  until apply commits. It re-reads the complete active `USER`/`ADMIN`
  real-member population and all of their induction rows only after that lock,
  rebuilds a versioned SHA-256 digest over every safe plan input, and compares
  it exactly with the reviewed dry-run digest before the blocker, no-op, or
  write branches. A concurrent writer that changes the plan therefore makes
  the waiting apply fail with a refreshed report rather than silently taking
  the blocker or no-op path. With a matching digest, apply refuses the entire
  run if any eligible member has a `DRAFT` or `IN_PROGRESS` row visible in that
  locked read, and performs its `createMany` plus digest-bearing audit write in
  the same transaction. Dry run never takes the lock and never writes.

  This is deliberately a table lock rather than a new advisory-lock family:
  PostgreSQL makes ordinary `MemberInduction` DML in
  `src/lib/induction.ts`, application approval, member lifecycle/merge cascade
  paths, and admin induction routes contend **when that DML reaches this
  table**. This does not serialize those workflows' earlier reads, member
  creation/import, other lifecycle writes, configuration changes, or any side
  effect outside this table. From the final dry run through the post-apply
  verification dry run, operators must therefore pause all of the following;
  the runbook makes this freeze mandatory:

  - individual and bulk member updates to `role`, `active`, date of birth, or
    `ageTier`;
  - membership-application approvals, admin and family-request member creation,
    group-booking join acceptance/token claims that can create an active
    `USER`, CSV/member imports, and Xero member imports;
  - membership-assignment saves and roll-forward jobs that can update
    `ageTier`;
  - changes to the chosen actor's `canLogin`, access-role assignments,
    active/archive/cancel state, account deletion, or merge;
  - archive, cancel, reactivate, delete, merge, and other member lifecycle
    operations;
  - induction create, signer assignment/reassignment, sign-off, admin
    completion/override, void, and delete operations; and
  - changes to club identity, age-tier settings, nomination settings, or
    induction-template content and activation.

  None of those actor, `Member`, group-booking join, or configuration writers
  is covered by the `MemberInduction` table lock merely because the baseline
  later reads its result. Their pause is an operational freeze, not a database
  lock.

  The baseline transaction takes no application advisory lock and mutates no
  `Member` or template row, so it cannot invert the global -> lodge -> member
  advisory order. Foreign-key checks can still wait on a concurrent member
  lifecycle transaction; if PostgreSQL detects a deadlock or the transaction
  times out, the whole apply rolls back and the operator starts again from a
  fresh dry run. Do not move validation reads before the table lock or weaken
  the lock mode: either change would reopen the locked
  classification/direct-DML race. Do not claim this table lock freezes the
  wider population or composes with writers before they touch
  `MemberInduction`.

- `booking-create-promo.ts` locks the selected `PromoCode` row with `FOR UPDATE`
  before validating and consuming its use count. Booking creation has already
  taken the per-lodge capacity lock, so the current order is lodge -> promo row;
  no counterpart writer may take the promo row and then a lodge lock.
- **Every booking-modification path that may write `currentRedemptions`** takes
  the same protocol via `lockPromoCodeRowsForUpdate` / the reprice wrapper
  `lockAndRefreshPromoCodeUsage` (both `src/lib/promo.ts`), *before* its first
  cap read and its first `currentRedemptions` write. All four are covered:
  `booking-modify-plan.ts` (`applyPromoCodeChanges`, the batch-modification
  path — the only one that can touch **two** codes, so it uses the multi-id
  form), `/api/bookings/[id]/guests` (adding guests),
  `booking-date-modification-service.ts` (changing dates) and
  `booking-guest-removal-service.ts` (removing guests). Each of the four has
  already taken the per-lodge capacity lock, so the order is again
  lodge -> promo row. The reprice wrapper also **re-reads
  `currentRedemptions` under the lock**, because a reprice carries a
  `PromoCode` snapshot loaded with the booking before the locks were taken;
  locking and then deciding against a number read outside the lock would leave
  the race open. It has **four** call sites, not three: the batch-modification
  path calls it too, on the branch that re-prices a booking whose promo code is
  not changing (there the multi-id lock is already held, so the call is for the
  refreshed counter and its re-lock is a no-op; the swap branch instead re-reads
  the whole promo row under that same lock). Every caller must then validate
  against the object the wrapper **returns** — validating the snapshot that went
  in would serialise correctly and still decide on a stale number, so the source
  contract in `src/lib/__tests__/promo-reprice-cap-exclusion.test.ts` pins that
  threading at all four sites. A promo **swap** touches two promo rows in one
  transaction (the outgoing code's counter is refunded, the incoming code's is
  charged), so the helper sorts the ids and locks them one statement at a time:
  every caller therefore takes promo row locks in the same global order and two
  opposite swaps cannot build a cycle. The sort is done in the application
  rather than by `ORDER BY ... FOR UPDATE`, so the ordering does not depend on
  the query plan. The lock became load-bearing with #2299: a reprice can now
  *release* a usage slot as well as take one, so check-then-consume must be
  serialised. The helper selects only `"id"` and discards the result — it exists
  purely for its lock and never reads a value out of a raw row, which is the
  trap #2289 documents.
  #2390 added one more read under the same lock and changed what the decision
  produces. The reprice paths pass `capOverflow: "coverExisting"`, which makes
  `validateAndCalculatePromoDiscount` read — still under the lock, and still
  before any write — which members already hold a **beneficial** allocation on
  the booking being repriced, and then divide the remaining allowance among the
  rest instead of refusing. No new lock, no new key, no change of order: the
  same row lock now protects a "who is covered" decision rather than a yes/no
  one. That read must stay ahead of the redemption write for the trigger reason
  documented in `docs/DOMAIN_INVARIANTS.md` — and ahead of the beneficiary list
  itself, because `maxGuestsPerBooking` is spent while that list is built and a
  protected member cut there would be invisible to every later check. The edit
  preview (`/api/bookings/[id]/modify-quote`) runs the same rule off `prisma`
  with no lock — it writes nothing, and a preview that disagreed with the save
  would be worse than one that is momentarily stale. Where they do disagree the
  edit panel shows the SAVE's sentence before it closes, so the member reads the
  outcome that was actually applied rather than the one that was previewed.
- `admin-bed-allocation.ts` locks the owning `LodgeRoom` row with `FOR UPDATE`
  before checking and changing one room's bunk-group membership. This protocol
  is independent of the booking/capacity/credit lock cluster.
- **Club-theme logo writer** — `src/lib/club-theme.ts` (`saveClubTheme`, #2322):
  the site-style save transaction locks the `ClubTheme` singleton
  (`SELECT "logoUrl" FROM "ClubTheme" WHERE "id" = 'default' FOR UPDATE`) and
  reads the currently-stored logo under that lock, so two concurrent saves
  serialise and can never both delete the same replaced `LOGO` blob (or orphan
  each other's new one). Because `FOR UPDATE` locks nothing when the row is
  absent, the transaction first materialises the singleton with a
  `createMany … skipDuplicates` so a **first-ever** save is serialised too.
  Singleton-keyed; no advisory lock; disjoint from the booking/capacity/credit
  and money lock clusters. The acquisition order is **`ClubTheme` row first,
  then `MediaImage`** — the lock is taken before the blob presence check, the
  row write, and the scoped `deleteMany`. The delete is scoped to
  `kind: "LOGO"`, so a `CONTENT` picker image referenced by page HTML can never
  be collected by a theme save. Under the same lock the incoming `logoUrl` is
  checked to still exist before it is written, which refuses a stale tab's save
  (409) rather than dangling the theme or deleting a blob that is still
  referenced.

  Counterpart writers, and why there is no cycle:
  - **Config-transfer apply** (`src/lib/config-transfer/apply.ts`) takes
    `pg_advisory_xact_lock(hashtext('config-transfer-import'))` and then writes the
    `ClubTheme` row inside its bundle transaction, so the order is advisory ->
    `ClubTheme` row. `saveClubTheme` takes no advisory lock at all, so the two
    orders cannot invert. `recreateBundleMedia` only ever **creates**
    `MediaImage` rows (and reads candidates for byte-identical reuse) — it locks
    no existing `MediaImage` row — so an import never holds a `MediaImage` lock
    while waiting for the theme row. Because an import can hold the theme row for
    the length of a whole bundle, `saveClubTheme` runs with an explicit
    `maxWait` 10s / `timeout` 15s and the site-style route maps an exhausted wait
    to a 503 retry-later rather than a 500.
  - **Image-library delete** (`src/app/api/admin/image-library/[id]/route.ts`) is
    a bare `MediaImage` delete with no surrounding row lock, and is itself scoped
    to `kind: "CONTENT"`, so it can never touch a `LOGO` blob this protocol owns
    — disjoint in both direction and row set.
  - **Member photo writer** (below) locks the `Member` row and touches only
    `MEMBER_PHOTO` blobs. The two protocols share the `MediaImage` table but
    never the same rows, and neither takes the other's parent row, so they are
    table-disjoint for locking purposes.

- **Member photo writer** — `src/app/api/members/[id]/photo/route.ts` (epic #171):
  the upload (POST) and remove (DELETE) transactions each `SELECT "photoImageId"
  FROM "Member" WHERE "id" = $1 FOR UPDATE` before creating/repointing the blob,
  so two concurrent replace/remove requests for the same member serialise on the
  member row and can never leave a `MEMBER_PHOTO` blob orphaned. Member-id keyed;
  no advisory lock; disjoint from the booking/capacity/credit and money lock
  clusters. The counterpart cleanup writer `deleteOwnedMemberPhotoBlobs` runs
  inside the member-merge and account-deletion transactions and touches the same
  `MEMBER_PHOTO` rows. A photo upload is **not** serialised by the
  member-lifecycle advisory lock, so a live upload for a member *can* be
  in-flight when a merge/account-deletion of that member begins — the member
  stays an uploadable subject (self or admin-on-behalf) until the lifecycle
  transaction commits. What makes that safe and **deadlock-free** is a single
  shared acquisition order that every writer honours: **lock the `Member` row
  first, then the `MediaImage` rows.** The upload takes `Member … FOR UPDATE`
  then `MediaImage` create/deleteMany; the cleanup writers take the `Member` row
  via `member.update` (lifecycle `xeroContactId` null at
  `member-lifecycle-actions.ts`; merge field-merge/`teardownLoserXero` in
  `member-merge.ts`) *before* calling `deleteOwnedMemberPhotoBlobs`. Because no
  writer ever takes a `MediaImage` lock before the owning `Member` row, the two
  cannot deadlock. Do not reorder a `deleteOwnedMemberPhotoBlobs` call ahead of
  its transaction's `Member`-row write. Both cleanup writers also read the
  leaving member's `photoImageId` **fresh under that already-held row lock** —
  the deletion path from its own `member.update … select photoImageId`, the
  merge from a `member.findUnique` after `teardownLoserXero`'s `member.update` —
  never from an earlier in-memory snapshot. That closes an under-deletion race:
  an admin-on-behalf upload landing after the snapshot but before the lock is
  held repoints the member to a NEW blob carrying the *admin's*
  `uploadedByMemberId`; keying the sweep off the stale snapshot would match
  neither that blob's id nor its uploader and orphan it once the member is
  hard-deleted. The fresh locked read supplies the member's current pointer so
  the blob is swept.

  The merge's fresh read is a **whole-row** read of both members, not just
  `photoImageId`, because the same staleness sinks its field-merge WRITE (#2243).
  `Member.photoImageId` is a real FK, so a patch derived from the transaction's
  opening snapshot writes the blob id the racing upload just deleted, and
  Postgres 23503 / Prisma P2003 rolls the ENTIRE merge back as a bare 500 — with
  the preview token none the wiser, because it verifies against that same stale
  snapshot. Both the write patch and the sweep pointer now come from that one
  fresh read. `familyGroupId` is the patch's other real FK and the same story:
  a club admin can delete the `FamilyGroup` (`DELETE
  /api/admin/family-groups/[id]`, behind `requireAdmin`) without taking any
  member-lifecycle lock.

  **The merge REFUSES mid-transaction drift rather than applying it.** The patch
  is derived twice — once from the transaction-opening snapshot (the derivation
  the preview token is verified against) and once from the fresh read — and if
  the two disagree on any field the merge throws a 409
  (`merge_drift_in_transaction`) naming those fields, before anything is written.
  Nothing is saved and the operator re-runs the preview. That keeps the promise
  the rest of the repo's preview/confirm flows make (config transfer's ADR-002:
  *what was previewed is exactly what is applied*) and matches this merge's own
  pre-transaction token check, which already 409s on drift. The original bug
  stays fixed either way: the stale FK value is detected from the fresh read and
  never handed to Postgres, so the failure mode is a plain 409, not a bare 500.

  **The same refusal covers the family links (#2437).** The four Member
  self-relation columns (`parentMemberId`, `secondaryParentId`,
  `inheritEmailFromId`, `detailsConfirmedByMemberId`) are written by admin
  paths outside the `member-lifecycle` lock (`admin-members-service.ts`, the
  dependents link route). #2445's exclusion of the master's own row from the
  self-relation moves stopped a mid-merge link write corrupting the graph (the
  master as its own parent), but left the SILENT-LOSS arm: a link pointing at
  the loser that lands after the opening snapshot survives the moves
  un-repointed and is quietly nulled by the loser's hard-delete
  (`onDelete: SetNull`) — no error, no audit. Three mechanisms compose to
  close every interleaving. **Step 1 is value-conditional**: the master's
  pointer at the loser is nulled with a `WHERE column = loserId` predicate
  (re-evaluated after blocking under READ COMMITTED), so a pointer that moved
  since the opening snapshot refuses at step 1 instead of being overwritten —
  and a successful null holds the master's row lock to commit, which is what
  makes the step-5 expectation for that column enforceable rather than a
  check of step 1's own write. **The step-3 self-relation sweeps are
  id-bounded** to the rows captured by the in-transaction token re-derivation
  (counts and captured ids come from the same read), so a link that lands
  after the capture is never absorbed onto the master unvetted — it stays
  pointing at the loser. **The step-5 under-lock re-read** then checks all
  three arms: any change to the four columns on either member row beyond the
  merge's own step-1 nulling and step-3 re-pointing
  (`diffSelfRelationLinkState`), and any OTHER row still referencing the
  loser after the moves, 409s with the same `merge_drift_in_transaction`
  refusal naming the changed links in club-admin vocabulary (owner decision
  on #2437, 1 Aug 2026: detect and refuse — deliberately NOT a new
  advisory-lock participant for the link writers, and NOT a DB CHECK
  constraint). Interleavings after the re-check cannot reopen the hole: both
  member rows are FOR UPDATE-locked, and an inbound FK write referencing the
  loser from another row blocks on its KEY SHARE lock against that FOR UPDATE
  and then fails loudly on the FK once the hard-delete commits. The refusal
  itself writes **no audit row** — the 409 rolls the transaction back whole,
  exactly like the #2243/#2445 field-drift refusal and the other merge
  refusals (`merge_blocked`, `preview_drift`); recording refused merge
  attempts (outside the transaction) would be a deliberate new convention
  across all of those arms, and is an owner decision not taken on #2437.

  **One new row lock, no new lock family.** Immediately before that fresh read
  the merge takes `SELECT 1 FROM "Member" WHERE "id" IN (…) ORDER BY "id" FOR
  UPDATE` over the master and the loser. The loser was already row-locked by
  `teardownLoserXero`'s unconditional `member.update`; the master was not, and
  that open window could strand an orphaned `MEMBER_PHOTO` blob (a concurrent
  on-behalf upload for the MASTER commits blob M2, the merge overwrites the
  pointer with the loser's absorbed value, and the loser-only sweep never touches
  M2) as well as producing avoidable drift 409s. Both ids are locked in **one
  id-ordered statement**, the same ordering rule as the two advisory locks at the
  top of the transaction, so it cannot deadlock against the mirror merge. Order
  against `MediaImage` is unchanged: this is a `Member` lock, still taken before
  any `MediaImage` write.

  What that row lock does **not** close: it protects the two `Member` rows, not
  the rows their foreign keys point AT. A concurrent `FamilyGroup` delete can
  still abort the merge — now by deadlocking against this lock (Postgres 40P01)
  rather than by writing a stale value (23503). Closing that would need the
  family-group writers to join the member-lifecycle lock family and is out of
  scope. Locking the master earlier (before the guards and the self-relation
  pass) rather than only before the field write was considered on #2437 and
  deliberately **not** taken — the master stays unlocked until step 5, and the
  family-link drift re-check above is what closes that window.

Do not add or compose a row lock without updating this inventory and documenting
its order against every advisory- and row-lock counterpart.

### Member merge — dual member-lifecycle lock (E11 #1937)

`executeMemberMerge` (`member-merge.ts`) is the only writer that holds **two**
`member-lifecycle:<memberId>` advisory locks at once — one for the master, one
for the loser. Both are acquired at the very top of the single merge transaction
in **sorted id order** (`[masterId, loserId].sort()`, smaller id first) so a
merge and its mirror (a merge started from the other direction, or a concurrent
archive/delete of either member) can never deadlock. Because the keys share the
`member-lifecycle:` namespace with `member-lifecycle-actions.ts`, a merge also
mutually excludes any archive or delete of either the master or the loser.

Inside the locks the merge re-reads both members, re-runs the full guard matrix,
and re-verifies the HMAC preview token (which bakes in both `updatedAt` values)
before any write, so a stale preview or a concurrent edit fails with a 409
instead of merging against changed state. A concurrent edit that lands *after*
that check, from a writer outside the lock family, is caught by the second
derivation described under "Member photo writer" above and 409s the same way
(#2243) — so the sentence holds end to end, not just at the transaction's
opening. There are **no Xero API calls** in or
after the transaction — the loser's Xero teardown is DB-only (deactivate
contact-identity `XeroObjectLink` rows and re-point the active
`ENTRANCE_FEE_INVOICE` link to the master); the loser's Xero contact is left for
manual clean-up.

The merge transaction runs with an extended interactive-transaction window
(`timeout: 120s`, `maxWait: 10s`): re-pointing 70+ relations takes hundreds of
sequential round-trips on a heavy member, and the dual advisory lock already
serialises every competing lifecycle writer, so the long window cannot admit a
concurrent conflicting write.

## The disciplines, by writer class

### Capacity claim → per-lodge lock, read-key → lock → re-read

The per-lodge lock key needs the booking's `lodgeId`, which you only know after
reading the row — so these paths cannot lock before their first read. The safe
pattern is:

1. Read only `{ lodgeId }` (plus any cheap early-bail fields). `lodgeId` is
   immutable, so keying the lock from this read is always safe.
2. `acquireLodgeCapacityLock(tx, lodgeId)` (after `lock(1)` if the writer also
   moves money — see below).
3. **Re-read the full row under the lock** and consume only that post-lock
   snapshot for the capacity check, pricing and claim.

`cron-confirm-pending.ts` is the reference implementation; the same shape is in
`booking-create.ts`, `payment-reconciliation.ts`, `group-settlement.ts`
(`commitChildrenToConfirmed`, keyed on each child's own lodge in sorted order),
the confirm-pending-guests / waitlist-confirm / switch-to-internet-banking
routes, the booking modify/cancel/settlement services, and
`xero-inbound/invoice-paid-effects.ts`. Skipping step 3 (acting on the pre-lock
snapshot) is a TOCTOU.

The admin exclusive whole-lodge hold route follows the same rule even though
the hold flag itself is row-scoped: it reads only immutable `lodgeId`, takes the
per-lodge lock, then re-reads status, hold state and dates. Both set-time
conflict queries and their audit metadata consume that post-lock snapshot, so a
concurrent date move cannot make the hold apply to one range while reporting
conflicts for an older range. Its status-guarded SET remains necessary because
cancel writers use the disjoint global lock and may still race the row update.

Existing bed-allocation moves (`moveBedAllocationsSameDate`, #2366) compose the
global and per-lodge tiers. They do not change booking status or money, but
cancellation prunes a cancelled booking's allocation rows under global
`lock(1)`: a lodge-only move could otherwise read a row, let cancellation
delete it, and then re-upsert it onto the cancelled booking. The
pre-transaction read resolves only the destination bed's immutable lodge key.
The transaction takes **global `lock(1)` first, then that lodge lock**, and
re-reads the source allocation rows and their persisted lodge nights under
both before funnelling every selected row through `manuallyAllocateBed`. If
cancellation won, the post-lock source read returns no row and the move writes
nothing. The row changes, shared-double partner promotions (with each causal
moved-allocation id) and audit rows all remain in that transaction; one
conflict rolls the group back. This writer takes no member lock because it
preserves every member-night footprint. Its custodian-hold counterpart takes
the same lodge key, cancellation takes the same global key, and the fixed
global -> lodge order introduces no inverse.

### Global-cohort money / status transition → global `lock(1)`

Cancel (`booking-cancel.ts`), Stripe capture, the manual cash / off-Xero
mark-paid and its reversal, and the capacity-failed void
(`payment-reconciliation.ts`), the Internet-Banking hold-expiry release
(`internet-banking-payment-cron.ts`), the quote hold-release crons
(`cron-quote-expiry-reminders.ts`), the member-guest consent transitions
(`member-guest-consent-service.ts` — both the member/delegate approve-decline
path and the nightly expiry sweep `cron-member-guest-consent-expiry.ts`, because
a decline or a lapse reprices the booking, can elect account credit, AND releases
a bed, putting it in both cohorts), and the whole group-settlement lifecycle —
settle (`group-settlement.ts` `settleConfirmedChildrenAndNotify`), the reaper
(`cron-group-settlement-reaper.ts`), `markGroupSettlementIntentFailed` /
`markGroupSettlementIntentRefunded`, and the organiser-cancel FAILED claim
(`group-cancel.ts`) — **all take `lock(1)`**, so any two operations on the same
booking or settlement mutually exclude. The group-settlement paths in particular
MUST share `lock(1)`: before #1881 the settle path took a per-lodge (default
lodge) key while the reaper took `lock(1)`, so a settle could race a reap into an
inconsistent settlement/child state. `markGroupSettlementIntentFailed` also
initially skipped the lock; #1881 wrapped it in `lock(1)` to match this claim, so
it can no longer execute between a multi-statement settle transaction's own
statements. Note the FAILED mark and the settle path both leave `FAILED` OUT of
their status-guard `notIn` set BY DESIGN: a settlement marked `FAILED` by a
`payment_failed`/`payment_intent.canceled` webhook whose money is then genuinely
captured (`payment_intent.succeeded` → settle) must still become `SUCCEEDED`, so
settle legitimately overwrites `FAILED` → `SUCCEEDED`. `lock(1)` guarantees the
two run whole-before-whole; it is not a veto on that transition.

#### Three-tier composition: global → lodge → member-credit (#2262)

The manual mark-paid path in `payment-reconciliation.ts` is the settlement body's
second entry point, and it derives its own settlement amount from the member's
credit ledger rather than accepting one from a client. Credit writers serialise
on the per-member `member-credit` key, **not** on `lock(1)`, so the path composes
a third tier — `lock(1)` → `acquireLodgeCapacityLock(lodgeId)` →
`lockMemberCreditLedger(memberId)` — taking them in exactly that order and
deriving `effectiveAmountCents = finalPriceCents - appliedCredit` only once all
three are held. This is the same composition (and the same order)
`switch-to-internet-banking` uses, which likewise refuses to rely on other
writers happening to hold `lock(1)`. The reversal takes the first two tiers only:
it writes no amount and reads no credit ledger, but it does restore booking
status and can release capacity.

`lock(1)` also serialises the duplicate-capture adjudication (#1992). When a
Stripe success arrives for an already-PAID booking, `markBookingPaymentSucceeded`
refunds the arriving capture only if it is a DIFFERENT intent from a captured
PRIMARY transaction still holding net cash, AND no duplicate-capture refund
operation (`duplicate_capture_<bookingId>_<pi>`) already exists for the booking
against another intent. That check-then-enqueue is race-free only because every
caller runs it under `lock(1)`: interleaved webhook replays of BOTH captures
would otherwise refund both sides and settle the booking at zero net cash. The
refund itself follows the #1349 enqueue-then-execute shape — the durable
operation (with the slice pinned to the duplicate's own transaction) commits
with the detection, and the Stripe refund executes after commit under the
shared `duplicate_capture_refund_<bookingId>_<pi>` key prefix the recovery cron
replays. Relatedly, the auto-charge cron's pre-charge sweep that cancels
superseded /pay link intents (#1992 Option 1) is a plain Stripe call strictly
OUTSIDE any transaction, after the claim commit: the claim's link revocation
under the lodge lock freezes the set of link intents, and the sweep excludes the
cron's own `pending_hold_auto_charge` transactions because Stripe's shared
`pending_charge_<bookingId>` idempotency key re-returns a prior run's intent.

Organiser cancellation adds a durable veto before it releases the lock:
`group-cancel.ts` writes `GroupBooking.status = CANCELLED` under `lock(1)`
before voiding/refunding Stripe or cancelling children. Settlement apply
re-reads that group status under the same lock and returns `cancelled` without
writing Payments or promoting children. Therefore either settlement wins first
and cancellation observes `SUCCEEDED`/`PAID` and refunds it, or cancellation
wins first and every later capture is refused; a late Stripe capture follows
the deterministic superseded-intent refund path, while a paid Xero invoice is
left unapplied and raises an operator refund alert. Provider calls remain
outside the transaction. Per-child cancellation is also a status-guarded claim,
so a stale child snapshot can never overwrite a terminal transition.

### Writer doing both → `lock(1)` first, then per-lodge

The Stripe capture (`markBookingPaymentSucceeded`), the confirm-pending-guests
zero-dollar and charge branches, the waitlist-confirm $0 PAID claim, the
switch-to-internet-banking hold, the quote-accept conversion
(`approveBookingRequest`), and every booking modification service
(batch/date/guest-removal) take **`lock(1)` first, then the per-lodge lock**.
`xero-inbound/invoice-paid-effects.ts` is the in-tree precedent for this
composition.

Generic quote acceptance pre-reads only the held booking's immutable concrete
`lodgeId`, then takes global -> that lodge and fully re-reads both request and
hold. It rejects an explicit request/hold lodge mismatch and carries the same
concrete lodge into policy and email context. A null request lodge is never
re-resolved through a default that may have changed after hold creation.

Both held-conversion claims fence optimistically on the request's integer
`BookingRequest.version` (`version: request.version` in the claim `updateMany`
WHERE, mirrored by a JS re-read comparison), not on `updatedAt` (#1923). Every
mutating write of a `BookingRequest` bumps `version: { increment: 1 }`, so a
writer that lands after the converter's locked re-read invalidates the stale
claim. `updatedAt` is `TIMESTAMP(3)` (millisecond precision): two writes in the
same millisecond share a timestamp and would silently defeat a `updatedAt` CAS,
which the integer counter cannot.

School approval has two deliberately different branches. Fresh-create is a
capacity-only admission and takes only the per-lodge lock. Held-reuse converts
an existing AWAITING_REVIEW booking that cancellation/release may claim, so it
takes **global first, then per-lodge**, re-reads the request and hold under both,
and uses a status-guarded `AWAITING_REVIEW -> CONFIRMED` claim before side
effects. A lost claim aborts the transaction.

The linked provisional-child sweep after a parent cancellation follows the
same order. It uses the child's immutable `lodgeId` only to select the lock,
then re-reads the child and conditionally claims `PENDING -> CANCELLED` under
both locks. `cron-confirm-pending` shares the per-lodge lock, so either the
cancel wins and alone runs cancellation side effects, or the cron's confirmed /
charged state survives and the stale sweep runs no side effect.

`switch-to-internet-banking` also recomputes both the locked booking price and
the authoritative `BOOKING_APPLIED` credit aggregate after acquiring global,
lodge, then `lockMemberCreditLedger(memberId)` locks in that order;
the IB payment mirror must never mix a pre-lock price with post-lock credit (or
vice versa). Waitlist offer confirmation resolves only the immutable lodge key
before locking, then re-reads status and expiry under the lodge lock and fuses
those checks with its update. The expiry reaper returns side effects only for
rows whose guarded revert/cancel actually claimed one row.

Group-settlement initiation selects/rejects `GroupBooking.CANCELLED` at entry
and re-checks the durable fence under global `lock(1)` before taking child-lodge
locks or proceeding to either the Stripe or Internet Banking provider path. A
cancelled group cannot mint a fresh PaymentIntent or enqueue a new combined
invoice.

Combined Xero invoice cancellation is a durable compensating workflow. Once an
invoice id is persisted, the same global cancellation fence atomically enqueues
a `GROUP_SETTLEMENT_INVOICE_VOID` outbox UPDATE with an invoice-specific
correlation/idempotency key; this remains replayable even when the original
invoice CREATE operation already succeeded. The create worker does the same if
cancellation wins while `createInvoices` is in flight. To close the otherwise
unavoidable last-check-to-email gap, only the single bounded Xero `emailInvoice`
call spans `lock(1)`: cancellation either commits first (email suppressed, VOID
queued) or waits until the email call finishes and then commits its VOID debt.
No invoice construction, contact lookup, create, or VOID provider call is held
inside that transaction.

The opt-in PostgreSQL race harness is wired into the migration-drift job against
its own `postgres:16-alpine` service on loopback port `55442`, database
`concurrency_race_1881`. Its dedicated-URL, loopback, high-port, and name-marker
guards remain mandatory; ordinary application databases are never valid targets.
Alongside scratch-table lock/CAS probes, the harness seeds the migrated
application schema and races the real group-settlement failure writer against a
locked PaymentIntent re-point, proving a stale webhook cannot fail the new
settlement attempt. It also exercises trusted induction baselining through
separate PostgreSQL connections: the baseline's `SHARE ROW EXCLUSIVE` table lock
holds an ordinary `MemberInduction` insert until commit, and an already-open
ordinary writer makes the baseline wait and then re-read the committed workflow
before refusing to apply. Further probes prove a real database failure during
the post-create audit rolls back both baseline rows and audit, while concurrent
baseline applies serialize into one inserted set and one no-op. These probes are
still opt-in; without the explicit flag the suite runs only its URL safety
guards and never imports or connects Prisma.

### Member-night guard → per-member lock, ACROSS lodges

"A member cannot hold two bookings covering the same night" is enforced by
`assertNoBookingMemberNightConflicts` (`booking-member-night-conflicts.ts`). This
invariant **spans lodges** — the guard query deliberately ignores `lodgeId` — but
capacity claims serialise only per lodge, so two concurrent writers for the same
member at *different* lodges hold different capacity locks and would both pass
the guard. The authoritative assert therefore takes a **per-member advisory lock
for every member-linked guest, in sorted `memberId` order, BEFORE reading**
(`lockBookingMemberNights`). Callers take it after their per-lodge lock, giving a
consistent lodge → member-night order. The advisory (non-authoritative)
`findBookingMemberNightConflicts` pre-check (used by the request-linking UI)
deliberately does NOT lock. `review-findings-contracts.test.ts` freezes that
every same-transaction member-linked guest writer takes the per-lodge lock before
the guard, and that the guard self-takes the per-member lock.

## Capacity: who claims, who releases, under which lock

Capacity is **per lodge** ("beds available on date D at lodge L"; no path sums
across lodges). Claims take the per-lodge lock keyed on the booking's own lodge.
Releases (freeing beds) can never overbook — the worst case of a release not
serialising against a claim is a momentarily conservative capacity view that
self-corrects — but a release that also flips booking status or moves money
(cancel, hold-expiry) takes `lock(1)` for the status/money reason, not the
capacity reason.

## Credit restoration: exactly-once is now STRUCTURAL (#1636)

`restoreCreditFromBooking` (`member-credit.ts`) restores a cancelled booking's
applied credit by inserting one `CANCELLATION_REFUND` row. As of **#1636 (landed)**
that row carries a **nullable-unique `restoredFromBookingId`**, and the insert
goes through `createMany({ skipDuplicates: true })` (`INSERT ... ON CONFLICT DO
NOTHING`). So **at most one restore row per booking can exist REGARDLESS of the
caller's lock granularity** — a duplicate inserts nothing and returns 0, never a
second credit, and never aborts the caller's transaction. This removed the old
cross-path dependence on all restore callers sharing `lock(1)`: moving a
credit-restoring path to a different lock can no longer double a restore.

Each restore caller still runs under `lock(1)` and its status-guarded claim
remains the *primary* single-flight (the claim, not a description string,
guarantees the surrounding side effects run once); the unique key is the
structural backstop underneath it. The Xero inbound applied-credit repair
(`xero-inbound/credit-note-repairs.ts`) takes the **per-member credit ledger
lock** (not `lock(1)`) so its `BOOKING_APPLIED` writes mutually exclude the
credit spend engine, which takes the same key. The orphan-heal repair
(`orphaned-applied-credit-backfill.ts`) also takes the per-member credit ledger
lock and re-derives an "already restored?" predicate.

### Send-bookkeeping on `Payment` → deliberately NO lock (#2350)

`Payment.additionalReminderSentAt` and `Payment.additionalFinalReminderSentAt`
are the only `Payment` columns written outside `lock(1)`. The two writers are
the additional-payment chase cron
(`src/lib/cron-additional-payment-reminders.ts`) and the admin re-send
(`src/lib/additional-payment-resend-service.ts`), and both write **only** those
two columns: no money, no status, no lifecycle. They record "this member has
been emailed about this obligation", so they join no lock cohort — taking
`lock(1)` would serialise a three-hourly mailer behind every cancel, capture and
settlement in the system for no invariant.

Single-flight comes from the guarded `updateMany` instead: the claim re-states
the full owed test (booking status included), pins the exact
`additionalAmountCents`, requires no ADDITIONAL `PaymentTransaction` newer than
the episode being chased, and requires the stamp to be unset for that episode.
Two runners racing therefore leave one winner, and a money writer landing in the
read→claim window makes the claim match nothing rather than producing an email
about a stale obligation. Nothing else reads these columns for a money decision,
so a stamp written concurrently with a locked money write cannot corrupt one.

## Membership cancellation credit notes: one per INVOICE, structurally (#2400)

`createXeroMembershipCancellationCreditNote`
(`membership-cancellation-xero.ts`) credits a subscription invoice's **whole**
remaining balance, and since #2400 it does so only when the leaving member is
the last member that invoice still covers. A family invoice covers several
members, so several different cancellations can each reach that state — and the
outbox's claim is **per operation**, not per invoice. Two overlapping drains
(the approval kick is unawaited, and the reviewer is told to approve a whole
family in a burst) could therefore run two siblings' credit notes at once, both
read an empty covered set, both read the same `amountDue`, and both create a
full-balance credit note. Xero cannot dedupe them: the idempotency key is built
from the *subscription*, so the two keys differ. One allocation lands and the
other is rejected as an over-allocation, leaving unallocated credit on the
family's contact.

The single-flight is a **unique-key claim, not a lock**, following the #1636
credit-restore precedent above: before any Xero call the writer inserts one
`XeroObjectLink` row keyed on the invoice —
`(localModel "MembershipCancellationSubscriptionInvoice", localId <invoiceId>,
xeroObjectType "INVOICE", xeroObjectId <invoiceId>, role
"MEMBERSHIP_CANCELLATION_CREDIT_INVOICE_CLAIM")` — through
`createMany({ skipDuplicates: true })`, i.e. `INSERT ... ON CONFLICT DO
NOTHING`, so the second inserter matches zero rows. The row's metadata records
which subscription holds the claim, so a **retry of the same subscription**
proceeds (and Xero's own idempotency key, identical across that subscription's
retries, dedupes the credit note); a **different** subscription runs no side
effect at all and completes SUCCEEDED with
`skipped: invoice_credit_claimed_by_other_cancellation`.

An advisory lock was rejected deliberately, and this is the reasoning to keep:
the side effect being serialised is a sequence of Xero API calls, and
`pg_advisory_xact_lock` is transaction-scoped, so covering them would mean
holding a transaction open across provider calls — the shape AGENTS.md's
concurrency checklist forbids. No new advisory-lock family is introduced, no
existing key changes, and the claim commits before the first provider call, so
nothing here composes with the booking/capacity/credit cluster.

The claim is taken **only** on the branch that is about to credit (nobody else
covered). A cancellation that skips because other covered members are staying
must NOT claim, or it would fence the sibling who will legitimately credit the
invoice later.

Losing the claim is conservative in the right direction: if the winner
ultimately fails, the invoice simply keeps its balance, and the #2392
archive re-check then refuses to archive the contact over it — that re-check
reads the credit operation's **recorded outcome**, not a recomputed "would this
credit?", precisely so a one-shot operation that already skipped can never
excuse the invoice again.

## Rules of thumb when working here

- **Adding a capacity claim?** Take `acquireLodgeCapacityLock(tx, lodgeId)` on
  the booking's own lodge and follow read-key → lock → re-read. If the same
  transaction also performs a global-cohort lifecycle or settlement-money
  transition, take `lock(1)` FIRST.
- **Adding a global-cohort transition (cancel/capture/settle/refund/hold-release)?**
  Take `lock(1)` and status-guard the write
  (`updateMany({ where: { id, status } })`, bail on count 0). A capacity-only
  admission/status claim follows the per-lodge writer matrix instead; do not
  infer its tier from the fact that it changes a status column.
- **Adding a member-night writer?** It runs the guard, which self-takes the
  per-member lock; just make sure it calls `assertNoBookingMemberNightConflicts`
  inside the transaction after any per-lodge lock
  (`review-findings-contracts.test.ts` holds you to it).
- **Touching credit restoration?** The exactly-once guarantee is structural
  (`restoredFromBookingId` unique, #1636); keep the status-guarded claim as the
  primary single-flight and do not remove the unique key.
- **Touching group settlement?** Every settlement-status transition
  (settle/reap/fail/refund/organiser-cancel) must stay on `lock(1)` so they all
  serialise; only the per-child capacity *claim* (`commitChildrenToConfirmed`)
  uses per-lodge locks.
- **Serialising a sequence of PROVIDER calls?** Do not reach for an advisory
  lock — it is transaction-scoped, and holding a transaction open across a
  provider call is forbidden. Take a durable claim that commits first: a unique
  key where one exists (credit restore #1636, the membership-cancellation
  invoice credit #2400) or a status-guarded `updateMany`. A lost claim runs no
  side effect.
- **Composing two locks in one transaction?** Global `lock(1)` before any
  per-lodge lock; multiple same-family locks in sorted key order.
