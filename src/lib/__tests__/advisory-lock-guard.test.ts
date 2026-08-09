import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// #182 guard (process follow-up to upstream PR #1911 review finding H1): a
// capacity ADMISSION path must use the per-lodge lock, while global-cohort
// booking lifecycle and settlement/money transitions use the canonical global
// pg_advisory_xact_lock(1). A writer that does both takes global first, then
// per-lodge (#1881). This scan makes a disjoint-key regression a CI failure
// instead of an upstream review comment:
//
// 1. The canonical global lock(1) is kept in a reviewed inventory. A new call
//    site must classify the writer using docs/CONCURRENCY_AND_LOCKING.md: use
//    lock(1) for booking-status/settlement money, the per-lodge helper for
//    capacity, and both in that order when the writer composes them. Update the
//    inventory only with that classification and PR lock-impact evidence.
//
// 2. The per-lodge key is minted ONLY by acquireLodgeCapacityLock:
//    hashtextextended must not appear outside src/lib/lodge-capacity-lock.ts,
//    so an
//    ad-hoc reconstruction can never drift from the canonical key.
//
// Domain-keyed advisory locks (hashtext of a namespaced string) are
// unrestricted — they are deliberately distinct keyspaces.

const SRC_DIR = path.join(process.cwd(), "src");

// Frozen per-file inventory of canonical global booking/money lock(1) call
// sites (executeRaw occurrences, not comments). Shrinking a count is always
// fine (delete the entry at zero); growing one needs a writer classification
// and explicit justification in the PR that edits this file.
const GLOBAL_BOOKING_MONEY_LOCK_INVENTORY: Record<string, number> = {
  // #2586: approving a flagged live booking can make it roster-eligible, while
  // rejecting one must remain ineligible until cancellation. Both review
  // decisions share one helper that takes global -> immutable lodge before the
  // authoritative re-read and guarded claim; provider work remains outside.
  "src/app/api/admin/bookings/[id]/review/route.ts": 1,
  // #1881 / #2593: the capacity-admission branches in confirm-pending-guests
  // deliberately compose global lifecycle lock(1) first with the canonical
  // per-lodge capacity lock. The global lock prevents cancellation/settlement
  // resurrection while the lodge lock serialises both the capacity claim and
  // the allocation reconciliation added by #2593.
  "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts": 3,
  // #2593: these booking-confirmation / party-change routes can create or prune
  // allocations as part of a booking lifecycle write. They therefore join the
  // existing global cohort first and the immutable booking-lodge capacity key
  // second, then re-read and reconcile through the lock-held lifecycle seam.
  "src/app/api/admin/bookings/[id]/exclusive-hold/route.ts": 1,
  "src/app/api/admin/bookings/[id]/force-confirm/route.ts": 1,
  // #2649: the admin repair for a stranded zero-dollar waitlist confirm is a
  // fourth PAYMENT_PENDING -> WAITLISTED writer. PAYMENT_PENDING is
  // BED-ALLOCATABLE and WAITLISTED is not, so the release prunes real
  // BedAllocation rows and genuinely needs the lodge tier — it is NOT
  // capacity-holding by status (booking-status.ts holds it only while
  // adminCapacityHoldAt is set, which this route releases with the transition).
  // It joins the global lifecycle cohort first (mutual exclusion with cancel and
  // settlement), then takes the immutable booking-lodge capacity key, re-reads
  // under both, and status-guards its claim on BOTH status and price. Same
  // topology as the two releases in waitlist-confirm/route.ts, which it exists
  // to finish.
  "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts": 1,
  "src/app/api/bookings/[id]/confirm-draft/route.ts": 1,
  "src/app/api/bookings/[id]/guests/route.ts": 1,
  // #2597: phase-two participant contention compensates the already-committed
  // zero-dollar offer claim under a fresh global -> lodge transaction.
  "src/app/api/bookings/[id]/waitlist-confirm/route.ts": 2,
  // #2586: departure cleanup shares the consent writer's global -> lodge ->
  // roster -> BookingGuest order so it cannot deadlock by locking the guest
  // tuple before consent decline/expiry reaches the same roster partition.
  "src/app/api/lodge/guests/[date]/depart/route.ts": 1,
  // #2265: the create-payment-intent pay transaction is a three-tier writer —
  // it flips a booking's status, claims capacity, and moves account credit. It
  // composes global lifecycle lock(1) FIRST, then the canonical per-lodge
  // capacity lock, then the per-member credit-ledger lock, matching
  // markBookingPaymentSucceeded. Before this it held no global lock at all, so
  // its status writes did not exclude a concurrent cancel.
  "src/app/api/payments/create-payment-intent/route.ts": 1,
  "src/app/api/payments/switch-to-internet-banking/route.ts": 1,
  // #2366 / #2593 / #2594: allocation moves, manual/range assignment,
  // approval, room/bed inventory changes, explicit auto-allocation and
  // reviewed removal all
  // compose with lifecycle reconciliation because cancellation can prune the
  // same rows. Every public wrapper takes global lock(1), then the immutable or
  // explicitly selected lodge capacity lock, and delegates to a narrow
  // lock-held implementation; auto-allocation also rebuilds its plan there.
  "src/lib/admin-bed-allocation.ts": 11,
  // #2595: reviewed night/person moves serialize with cancellation and every
  // allocation counterpart before taking the complete sorted lodge union,
  // member lifecycle/link families, and deterministic allocation row locks.
  "src/lib/bed-allocation-move.ts": 1,
  // #2594: removal applies a reviewed digest under global -> sorted immutable
  // lodge -> sorted allocation-row locks. Requested-room editing shares the
  // global cohort and locks/re-reads the booking before its guarded write so it
  // cannot cross approval or removal's final-approved consequence.
  "src/lib/bed-allocation-removal.ts": 1,
  "src/lib/requested-room-write.ts": 1,
  // #2593: the public reconciler owns global -> immutable booking lodge, while
  // callers already holding either tier use the matching lock-held seam. The
  // partner-shared cleanup site owns the same ordered topology for its sorted
  // lodge set.
  "src/lib/bed-allocation-lifecycle.ts": 2,
  "src/lib/booking-batch-modification-service.ts": 1,
  // #1881 residual: the fifth site protects the linked provisional-child
  // PENDING -> CANCELLED claim. That path also takes the child's per-lodge lock
  // so it excludes confirm-pending before deciding whether cancellation won.
  "src/lib/booking-cancel.ts": 5,
  "src/lib/booking-date-modification-service.ts": 2,
  // #2525: the atomic approve-and-execute AND the terminal-release (reject /
  // cancel / supersede) for booking-policy exception requests both mutate a
  // provisional capacity reservation and (for a modification approval) compose
  // the canonical modification's money/status transition, so they take the
  // canonical global lock(1) FIRST, then the per-lodge capacity lock keyed on the
  // frozen lodge, then let the tx-aware canonical service take the member-night /
  // member-credit keys after that. One shared `acquireGlobalBookingLock` helper,
  // so this file mints the global key exactly once. See
  // docs/CONCURRENCY_AND_LOCKING.md -> "Provisional reservations for held
  // policy-exception requests (#2365)".
  "src/lib/booking-exception-execution.ts": 1,
  // #2525 integration: the request-CREATION service now holds a provisional
  // capacity reservation for a HELD modification request (and releases it on
  // member cancel / supersede), so createModificationExceptionRequest and
  // cancelModificationExceptionRequest are capacity changes. They compose the
  // canonical global lock(1) FIRST, then the per-lodge capacity lock keyed on the
  // frozen lodge, matching booking-exception-execution.ts's approve/terminal
  // paths so the reservation write/delete serialises with every occupancy read.
  // One shared `acquireGlobalBookingLock` helper mints the global key exactly
  // once in this file. See docs/CONCURRENCY_AND_LOCKING.md -> "Provisional
  // reservations for held policy-exception requests (#2365)".
  "src/lib/booking-exception-request-service.ts": 1,
  "src/lib/booking-guest-removal-service.ts": 1,
  // #2593: creation/deletion/request-quote writers now reconcile allocation
  // state in the same transaction as their booking-status mutation. These are
  // lifecycle writers, not capacity-only admission checks, so they take the
  // global cohort before the affected lodge key and re-read under both.
  "src/lib/booking-create.ts": 2,
  "src/lib/booking-delete.ts": 2,
  "src/lib/booking-request-quotes.ts": 1,
  "src/lib/booking-request.ts": 1,
  // #2593: completion and pending/waitlist cron claims can prune or rebuild
  // allocation state. Candidate reads stay outside; each candidate transaction
  // takes global -> immutable lodge, re-reads, status-guards the claim, and only
  // then calls the lock-held reconciler.
  "src/lib/cron-complete-bookings.ts": 1,
  "src/lib/cron-confirm-pending.ts": 3,
  "src/lib/cron-group-settlement-reaper.ts": 2,
  "src/lib/cron-quote-expiry-reminders.ts": 2,
  "src/lib/cron-waitlist.ts": 1,
  // #2700: raising the OPEN ManualRefundTask for a modification payment
  // captured against an already-deleted booking. A SETTLEMENT-MONEY writer, so
  // it joins the global cohort — and specifically the same cohort
  // `booking-cancel.ts` is already in when IT creates a ManualRefundTask, which
  // is why this reuses lock(1) rather than minting a keyspace. The key is
  // needed because the write is a find-then-create (idempotent on the payment
  // INTENT, not the booking), which is not atomic on its own: two simultaneous
  // confirms of one capture would otherwise raise two OPEN tasks, and two
  // operators would refund one payment twice. It takes lock(1) and NOTHING
  // else, holds it across a duplicate-task check, a refund-fence read and the
  // create, touches no capacity or member-credit
  // tier, and every Stripe call is made by the caller outside this
  // transaction — so it composes with nothing and reverses no order.
  "src/lib/deleted-booking-modification-payment.ts": 1,
  "src/lib/group-cancel.ts": 3,
  "src/lib/group-settlement.ts": 6,
  "src/lib/internet-banking-payment-cron.ts": 1,
  // "+ Add Member Guest" (#2307, epic #2305). Two sites, both in the
  // global-cohort class and both genuinely needing BOTH locks: a consent decline
  // and a lapse each reprice the booking, can elect account credit to the owner
  // (owner decision D-15), AND release a bed. Global `lock(1)` is taken FIRST and
  // `acquireLodgeCapacityLock` second in both, matching the declared
  // global-before-per-lodge order, and each then re-reads under the locks and
  // makes a status-guarded claim before any side effect. See
  // docs/CONCURRENCY_AND_LOCKING.md, "Global-cohort money / status transition".
  "src/lib/member-guest-consent-service.ts": 2,
  // #2262: site 1 is the ONE settlement body, shared byte-for-byte by the
  // Stripe capture and the admin's manual cash settlement (the refactor that
  // generalised it over a settlement source added NO lock site — the manual
  // path composes global -> lodge -> MEMBER-CREDIT, and the third tier is a
  // call to lockMemberCreditLedger, not a raw lock site). Site 2 is the manual
  // mark-paid REVERSAL, a booking-status + money writer that also releases
  // capacity when it restores a PAYMENT_PENDING booking, so it composes the
  // same global-before-per-lodge pair in the same order.
  "src/lib/payment-reconciliation.ts": 2,
  // #2586: eligibility-validating roster generation/save/confirmation joins
  // the global -> lodge booking-writer order before its roster-date key. This
  // closes the initially-empty partition race without making every booking
  // writer enumerate all possible roster dates.
  "src/lib/roster-lock.ts": 1,
  // #2593: school conversion and waitlist offer/expiry paths are lifecycle
  // counterparts of allocation reconciliation. Single-lodge paths take global
  // before that lodge; cross-lodge paths acquire the sorted lodge union before
  // their fresh read and guarded transition, so no path reverses the topology.
  "src/lib/school-booking-request.ts": 2,
  "src/lib/waitlist-cross-lodge.ts": 6,
  "src/lib/waitlist.ts": 4,
  "src/lib/xero-group-settlement-invoices.ts": 3,
  "src/lib/xero-inbound/invoice-paid-effects.ts": 1,
};

const SCOPED_ADVISORY_LOCK_INVENTORY: Record<string, number> = {
  // #1936: the join-request review and group-create approve transactions take
  // member-lifecycle:{memberId} for the pre-existing member being linked, so
  // FamilyGroupMember writes serialize with the application-approval mapping
  // transaction's in-any-family-group collision guard (a FamilyGroupMember
  // insert does not bump Member.updatedAt, so the preview token alone cannot
  // catch the race). Single-lock holders; composition and counterpart analysis
  // in docs/CONCURRENCY_AND_LOCKING.md.
  "src/lib/admin-family-group-requests-service.ts": 2,
  // #2586: every roster-date writer calls the shared helper; the key is minted
  // once here and writer participation is pinned by roster-lock-contract.test.
  "src/lib/roster-lock.ts": 1,
  // #2364/#2596: lockAdultMemberHostingPolicySet takes the single blocking global
  // adult-member-hosting-policy-set key before any read by an admin CRUD write
  // or a configuration import, and the migration's BEFORE STATEMENT trigger
  // takes the same key ahead of any tuple lock so operator DML joins the same
  // order. The drain's fail-fast `pg_try_advisory_xact_lock` helper lives in this
  // file too, but deliberately does not match the blocking-call inventory below.
  // Config import, member merge and drain compose the key only in the documented
  // forward order; no counterpart reverses it. Counterpart analysis in
  // docs/CONCURRENCY_AND_LOCKING.md.
  "src/lib/adult-member-hosting-policy-set.ts": 1,
  // #2596: after the hosting policy-set key, the drain takes sorted
  // member-lifecycle keys for claimed owner + actor before Member rows and the
  // exact payload refresh. Merge takes those keys before relation moves. No
  // lifecycle participant takes the policy key and the drain never locks the
  // queue row, so there is no reverse policy or queue -> Member edge.
  "src/lib/adult-member-hosting-coverage-drain.ts": 1,
  // Same-owner hosting coverage (#2576 §9). `lockHostingCoverageOwner` takes
  // `pg_advisory_xact_lock(hashtext('hosting-coverage-owner'), hashtext(<Booking.memberId>))`
  // — a NEW keyspace in its own namespace, keyed on the booking OWNER.
  //
  // WHY IT EXISTS. `SAME_BOOKING_OWNER` makes one booking's compliance a function of
  // ANOTHER booking's rows. When #2576 introduced this key, confirmed creation used
  // lodge while cancellation used global, leaving the named race open. #2593 later
  // made the allocation-participating confirmed-create and cancellation paths compose
  // global → lodge. The owner key remains required because participant/member/queue
  // producers do not all share those tiers and the invariant is cross-booking and
  // per-owner. Same reasoning that gave `lockBookingMemberNights` its own family: a
  // per-member invariant cannot be serialised by a per-lodge key alone.
  //
  // COMPOSITION AND ORDER. Taken LAST among the application locks a caller composes:
  // after `pg_advisory_xact_lock(1)`, `acquireLodgeCapacityLock`, roster-date locks,
  // `lockBookingMemberNights` and member-credit locks wherever those families apply.
  // The #2586-aware modification order is therefore global → lodge → roster-date →
  // applicable member keys → coverage-owner; paths that do not use roster or member
  // keys simply omit those tiers. Several owners are acquired in SORTED order, the
  // same discipline the member-night lock uses. Postgres advisory locks are re-entrant
  // per session, so the evaluator and the settle step taking the same owner key inside
  // one transaction costs nothing. Callers resolve the lodge policy first and skip the
  // lock entirely unless the lodge has the scope enabled, so no unrelated write is
  // serialised per member. ONE site: every acquisition in the tree goes through this
  // helper.
  // Counterpart analysis and compatibility evidence in
  // docs/CONCURRENCY_AND_LOCKING.md → "Same-owner coverage takes a per-owner key".
  "src/lib/adult-member-hosting-coverage-lock.ts": 1,
  // AI Diagnostics budget reserve (AID-2, #2371). Both writers take the SAME
  // per-month key `pg_advisory_xact_lock(hashtext('diagnostics-budget-reserve'),
  // hashtext(<month>))`: `reserveDiagnosticsBudget` (the guarded spend claim) and
  // `settleDiagnosticsRoundtrip` (books the actual cost), so reserve and settle
  // are mutually exclusive per month and every reserve sees a consistent
  // settled+reserved sum. It is a NEW, isolated keyspace: keyed by calendar month
  // only, taken by no other writer, and each site takes only this one key (never
  // a second lock), so it forms no lock-ordering cycle and has no interaction with
  // the global booking/money lock(1), the per-lodge capacity key, or any other
  // scoped key above — the keyspaces are disjoint. Provider calls run OUTSIDE the
  // locked transaction. Counterpart analysis and compatibility evidence in
  // docs/CONCURRENCY_AND_LOCKING.md → "Composition: diagnostics budget reserve
  // (AID-2, #2371)".
  "src/lib/ai-diagnostics-usage.ts": 2,
  "src/lib/authoritative-fees.ts": 1,
  // #2095: claimBackupRun takes the singleton backup:run-lock key for the
  // milliseconds of the reap/check/insert claim transaction only (the dump
  // itself runs outside any transaction), so cron and run-now backups
  // serialise across containers. Single-lock holder, no composition with any
  // booking/money/lifecycle key; counterpart analysis in
  // docs/CONCURRENCY_AND_LOCKING.md.
  "src/lib/backup-run.ts": 1,
  "src/lib/booking-member-night-conflicts.ts": 1,
  // #calendar-recurring: lockCalendarSeries takes calendar-series:{seriesId} for
  // the milliseconds of a whole-series regenerate/propagate/collapse/delete so
  // two concurrent editors can't interleave a delete-and-regenerate and
  // duplicate/drop occurrences. Single-lock holder; its own keyspace, composed
  // with no booking/money/capacity/lifecycle key (calendar rows only).
  "src/lib/calendar-service.ts": 1,
  "src/lib/config-transfer-lock.ts": 1,
  "src/lib/lodge-capacity-lock.ts": 1,
  "src/lib/member-credit.ts": 1,
  "src/lib/member-lifecycle-actions.ts": 2,
  // #2593: one canonical helper mints member-lifecycle:{memberId}; it
  // de-duplicates and sorts ids before acquisition. Deletion, bulk update,
  // member-detail and seasonal-assignment writers all call this helper instead
  // of reconstructing the scoped key at their individual call sites.
  "src/lib/member-lifecycle-lock.ts": 1,
  // #2363: every minimum-stay policy writer takes the one global policy-set
  // key before reading/planning. The migration's BEFORE STATEMENT trigger
  // takes the exact same key for draining old-colour INSERT/UPDATE/DELETE before
  // PostgreSQL reaches tuple locks. Config import orders its existing singleton
  // first, then this key; live CRUD takes only this key.
  "src/lib/minimum-stay-policy-set.ts": 1,
  // #1937/#2596: executeMemberMerge first calls the shared hosting policy-set
  // helper, then — since #2595 — the merge-only partner-share prefix helper
  // (`acquireMemberMergePartnerSharedLodgeLocks`: every affected lodge capacity
  // key, sorted, and NO global cohort key), then takes the two raw
  // member-lifecycle:{id} keys in sorted order, and finally the canonical
  // member-partner-link keys through `member-partner-lock.ts` — because merge
  // re-points partner links AND reads them to decide which future shared
  // doubles step 3b deletes. The count stays 2 because all three added tiers
  // come from helpers that own their own raw sites
  // (adult-member-hosting-policy-set.ts, bed-allocation-lifecycle.ts +
  // lodge-capacity-lock.ts, member-partner-lock.ts) — merge mints no new key of
  // its own. This order serialises policy enumeration before relation moves,
  // keeps the fixed lodge -> member order for the #2595 shared-double
  // reconciliation, matches the reviewed move's member-lifecycle ->
  // member-partner-link order so no new wait-graph edge appears, and
  // excludes every delete/archive/merge touching either member. Merge is
  // deliberately absent from GLOBAL_BOOKING_MONEY_LOCK_INVENTORY above:
  // `member-merge-execute.test.ts` pins that it takes no `lock(1)` at all.
  "src/lib/member-merge.ts": 2,
  // #2595: the partner-link service and reviewed move service share this one
  // canonical sorted member-partner-link lock mint.
  "src/lib/member-partner-lock.ts": 1,
  // #2148: reconcileSubscriptionBillingExceptions takes the SAME
  // membership-subscription-billing:{seasonYear} key as
  // confirmSubscriptionBillingPreview (no new key), so refresh-reconciliation
  // and confirm serialise; counterpart analysis in
  // docs/CONCURRENCY_AND_LOCKING.md, compatibility evidence in PR #2158.
  "src/lib/membership-subscription-billing.ts": 2,
  // #1936: 2 pre-existing membership-application locks (application id +
  // applicant email) plus the approval-mapping transaction's sorted
  // member-lifecycle:{targetId} loop — the approval composes
  // member-application THEN member-lifecycle; ordering and counterpart
  // analysis in docs/CONCURRENCY_AND_LOCKING.md.
  "src/lib/nomination.ts": 3,
  "src/lib/xero-contacts.ts": 2,
};

// Every entry here is now a LOCK-ONLY statement (#2289): it selects a constant,
// runs through `$executeRaw`, and its result is never read. The data each one
// protects is read back through the Prisma model under that same lock, so no row
// lock in this repository doubles as an unchecked-cast read. The one raw
// statement whose result IS read (`rate-limit.ts`) takes no lock and goes
// through `decodeRawRows`. `raw-sql-shape-guard.test.ts` holds that line.
const ROW_LOCK_SITE_INVENTORY: Record<string, number> = {
  // The room bunk-group writer and #2594 allocation approval each use one
  // lock-only row statement. Reviewed removal locks its selected/causal rows,
  // and requested-room editing locks the booking before its authoritative
  // approval check and guarded update.
  "src/lib/admin-bed-allocation.ts": 2,
  // #2595 reviewed moves lock every selected/destination/old-bed counterpart
  // tuple after the advisory tiers and before their authoritative re-read.
  "src/lib/bed-allocation-move.ts": 1,
  "src/lib/bed-allocation-removal.ts": 1,
  "src/lib/requested-room-write.ts": 1,
  "src/lib/booking-create-promo.ts": 1,
  // Promo usage caps (#2299): `lockPromoCodeRowsForUpdate` takes a
  // `SELECT 1 … FOR UPDATE` on the promo row for the modification paths,
  // which can now RELEASE a cap slot as well as take one. One raw statement
  // serves all four of them — the batch-modification path calls it directly
  // (it may lock two codes for a swap), and adding guests / changing dates /
  // removing guests reach it through `lockAndRefreshPromoCodeUsage`, which also
  // re-reads `currentRedemptions` under the lock. That wrapper has four call
  // sites, not three: the batch path also calls it on its no-swap reprice
  // branch, where the lock is already held and the refreshed counter is the
  // point. Booking creation takes its own lock in booking-create-promo.ts
  // above, which since #2289 also selects a constant and reads the promo back
  // through `tx.promoCode.findUnique` — it used to `SELECT *` and read the raw
  // row, and that unchecked cast is what silently disabled a redemption cap and
  // a FREE_NIGHTS discount. Ids are sorted and locked one
  // statement at a time so a promo swap (outgoing + incoming code in one
  // transaction) can never build a lock cycle with another swap; callers hold
  // the per-lodge capacity lock first, so the order stays lodge -> promo row.
  // A CONSTANT is selected and the result discarded — a lock, never a read. See
  // docs/CONCURRENCY_AND_LOCKING.md -> "Narrow row- and table-lock protocols".
  "src/lib/promo.ts": 1,
  // Site-style save (#2322) locks the ClubTheme singleton
  // (`SELECT 1 … FOR UPDATE`) so concurrent saves serialise and never
  // both delete the same replaced LOGO blob. Order: ClubTheme row -> MediaImage.
  // Singleton-keyed; no advisory lock; disjoint from booking/money writers. See
  // docs/CONCURRENCY_AND_LOCKING.md -> "Club-theme logo writer".
  "src/lib/club-theme.ts": 1,
  // Member-photo upload (POST) and remove (DELETE) each lock the member row
  // (`SELECT 1 … FOR UPDATE`) so concurrent replace/remove
  // serialise and never orphan a MEMBER_PHOTO blob. Member-id keyed; no
  // advisory lock; disjoint from booking/money writers. See
  // docs/CONCURRENCY_AND_LOCKING.md → "Member photo writer".
  "src/app/api/members/[id]/photo/route.ts": 2,
  // Adult-member-hosting queue participants (#2597): the shared helper mints
  // one reviewed `FOR UPDATE` protocol for member merge over master, loser and
  // every planned ancillary owner, plus the shared standing-subject barrier
  // that excludes a late BookingGuest FK `KEY SHARE` for every member-standing
  // fan-out. Ordinary seams use the separate sorted `FOR KEY SHARE NOWAIT`
  // protocol in this helper. It issues the runtime exact-participant proofs
  // consumed by queue writes.
  // FOUR since #2623 T9(d) counted every strength, not two: the two `FOR UPDATE`
  // statements above plus the two `FOR KEY SHARE` ones that were inventoried
  // nowhere — the ordinary seams' sorted NOWAIT acquisition, and the
  // booking-request hold's blocking lock over its exact linked-member snapshot.
  // The merge `FOR UPDATE` now runs under a 10s `lock_timeout` and restores it,
  // so a wait-while-holding-the-policy-key is bounded and lands on the same
  // stable retry (#2623 T6).
  // See docs/CONCURRENCY_AND_LOCKING.md → "Adult-member-hosting queue
  // participant fencing" and "Member merge".
  "src/lib/adult-member-hosting-queue-participants.ts": 4,
  // The hosting coverage drain locks the claimed owner and FK-less actor
  // `FOR KEY SHARE` after their sorted member-lifecycle keys and before the exact
  // typed queue refresh, so merge cannot re-point an identity between the claim
  // snapshot and the work. One statement, executed once per claimed id.
  // See docs/CONCURRENCY_AND_LOCKING.md → "Adult-member-hosting queue
  // participant fencing".
  "src/lib/adult-member-hosting-coverage-drain.ts": 1,
  // Incident promotion locks the reconciliation's actor `FOR KEY SHARE` so a
  // present actor cannot be hard-deleted between the existence check and the
  // incident FK write; a zero-match degrades to anonymous officer attribution
  // rather than failing a poison item. Order: policy-set → this row.
  "src/lib/adult-member-hosting-review.ts": 1,
  // The Xero member-scoped CREATE and UPDATE reservations each take the target
  // `Member FOR KEY SHARE` in a short transaction, read the payload back through
  // Prisma under it, and commit the `RUNNING` operation before any provider call.
  // Merge and account deletion take the conflicting `FOR UPDATE` on the same row
  // and re-check the reservation, so one side always loses cleanly and Xero never
  // sits inside a long transaction.
  // See docs/CONCURRENCY_AND_LOCKING.md -> "Xero contact writers".
  "src/lib/xero-contacts.ts": 2,
  // Member-scoped Xero contact writes (#2597) share one `FOR UPDATE` protocol
  // for canonical CONTACT-link completion. Account deletion and member merge
  // take the same Member row before teardown, while CREATE/UPDATE reservations
  // use the separate `FOR KEY SHARE` protocol inventoried by their source tests.
  // See docs/CONCURRENCY_AND_LOCKING.md -> "Xero contact writers".
  "src/lib/xero-contact-create-recovery.ts": 1,
  // Releasing a started deletion approval (#2627) locks the exact
  // `DeletionRequest` row (`SELECT 1 … FOR UPDATE`) and reads the claim's
  // previous holder and note back through the Prisma model under it, because
  // the transition destroys that attribution and its audit entry — written in
  // the same transaction, awaited — is the only surviving record of it. Reading
  // the holder outside the lock would be an ABA guess. The guarded
  // `APPROVAL_IN_PROGRESS -> PENDING` `updateMany` is retained under the lock,
  // so the winner protocol every transition on this row shares is unchanged.
  // Request-id keyed on an immutable cuid; no advisory lock. Counterparts are
  // the other two transitions on the same row — an approval finalising inside
  // the anonymisation transaction (which also holds the target `Member FOR
  // UPDATE` via the Xero fence; the release takes only this row, so no cycle)
  // and an ordinary rejection. See docs/CONCURRENCY_AND_LOCKING.md ->
  // "Approve, reject and release of one `DeletionRequest`".
  "src/lib/deletion-request-decision.ts": 1,
};

const CAPACITY_LOCK_MINT = "src/lib/lodge-capacity-lock.ts";

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes(".integration.")
  );
}

/**
 * Count occurrences of `needle` in `source`, ignoring whole-line comments and
 * the contents of double-quoted string literals.
 *
 * DOUBLE-QUOTED LITERALS ARE NOT CODE for this purpose, and #2623 T9(d) is where
 * that started to matter: `adult-member-hosting-queue-participants.ts` names its
 * own protocol inside an error message ("… must never be issued without its FOR
 * KEY SHARE NOWAIT lock"), which is prose about a statement, not a statement. A
 * counter that scored it would put a number in the inventory below that no reader
 * could reconcile against the file, and would fail the census when somebody
 * reworded a sentence. Every raw statement in this repository is written as a
 * BACKTICK template, so backticks are deliberately left alone.
 *
 * BUT ONLY PROSE, NOT SQL (#2623 F7). Blanking every double-quoted literal opened
 * the same hole T9(d) exists to close, one level down: `$executeRawUnsafe` takes a
 * plain string, so `const SQL = "SELECT … FOR UPDATE"; await tx.$executeRawUnsafe(SQL)`
 * would score ZERO and drop out of the census silently. A literal containing
 * `SELECT` is therefore left intact and counted — prose about the protocol does not
 * contain it (the one live case, quoted above, does not), and a raw statement always
 * does. The narrower rule keeps the false positive suppressed while refusing to
 * suppress a real statement.
 */
function countCodeOccurrences(source: string, needle: string | RegExp): number {
  let count = 0;
  for (const rawLine of source.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    const line = rawLine.replace(/"(?:[^"\\]|\\.)*"/g, (literal) =>
      /SELECT/i.test(literal) ? literal : '""',
    );
    if (typeof needle !== "string") {
      count += (line.match(needle) ?? []).length;
      continue;
    }
    let idx = line.indexOf(needle);
    while (idx !== -1) {
      count += 1;
      idx = line.indexOf(needle, idx + needle.length);
    }
  }
  return count;
}

/**
 * Every row-lock strength PostgreSQL offers, not just `FOR UPDATE` (#2623 T9(d)).
 *
 * The inventory used to match the literal `FOR UPDATE`, so the six non-test
 * `FOR KEY SHARE` statements this repository ships — the hosting queue
 * participant fence, the booking-request linked-member hold, the coverage drain's
 * claimed-identity lock, the hosting actor lock and the two Xero contact
 * reservations — appeared in NO counted inventory at all. They were exempt from
 * the "lock raw, read typed" rule in `raw-sql-shape-guard.test.ts` for the same
 * reason until that rule was widened. Nothing escaped: all six select a constant
 * through `$executeRaw`. But a seventh written as `$queryRaw` projecting columns
 * would have passed every gate — the exact #2289 failure mode.
 *
 * The two weaker modes are listed even though nothing uses them today, because
 * the point of a census is that a NEW site has to be classified rather than
 * merely written.
 */
const ROW_LOCK_STRENGTHS = /FOR (?:UPDATE|KEY SHARE|NO KEY UPDATE|SHARE)/g;

describe("advisory lock guard (#182 / H1 regression class)", () => {
  const sources = walk(SRC_DIR)
    .map((file) => ({
      rel: path.relative(process.cwd(), file).split(path.sep).join("/"),
      text: fs.readFileSync(file, "utf8"),
    }))
    .filter(({ rel }) => !isTestFile(rel));

  it("keeps canonical global pg_advisory_xact_lock(1) sites inside the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of sources) {
      const count = countCodeOccurrences(text, "pg_advisory_xact_lock(1)");
      if (count > 0) found[rel] = count;
    }

    expect(
      found,
        "New pg_advisory_xact_lock(1) call sites detected. Classify the writer " +
        "using docs/CONCURRENCY_AND_LOCKING.md: global-cohort lifecycle and " +
        "settlement money uses this canonical global key; capacity uses " +
        "acquireLodgeCapacityLock(tx, lodgeId); a writer doing both takes global " +
        "first, then per-lodge. Update this inventory only with PR lock-impact " +
        "evidence."
    ).toEqual(GLOBAL_BOOKING_MONEY_LOCK_INVENTORY);
  });

  it("keeps every scoped advisory-lock family inside the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of sources) {
      const allLocks = countCodeOccurrences(text, "pg_advisory_xact_lock(");
      const globalLocks = countCodeOccurrences(text, "pg_advisory_xact_lock(1)");
      const scopedLocks = allLocks - globalLocks;
      if (scopedLocks > 0) found[rel] = scopedLocks;
    }

    expect(
      found,
      "Scoped advisory-lock sites changed. Reconcile the key, counterpart " +
        "writers, and acquisition order in docs/CONCURRENCY_AND_LOCKING.md, " +
        "then update this inventory with PR compatibility evidence.",
    ).toEqual(SCOPED_ADVISORY_LOCK_INVENTORY);
  });

  it("keeps every SELECT row-lock protocol inside the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of sources) {
      const count = countCodeOccurrences(text, ROW_LOCK_STRENGTHS);
      if (count > 0) found[rel] = count;
    }

    expect(
      found,
      "Row-lock sites changed. Every strength counts (#2623 T9(d)): FOR " +
        "UPDATE, FOR NO KEY UPDATE, FOR SHARE and FOR KEY SHARE. Inventory " +
        "their counterpart writers and order against advisory and row locks " +
        "in docs/CONCURRENCY_AND_LOCKING.md.",
    ).toEqual(ROW_LOCK_SITE_INVENTORY);
  });

  it("keeps school held-reuse on global -> lodge -> re-read -> guarded claim", () => {
    const school = sources.find(
      ({ rel }) => rel === "src/lib/school-booking-request.ts",
    )?.text;
    expect(school).toBeDefined();

    const approvalStart =
      school?.indexOf("export async function approveSchoolBookingRequest") ?? -1;
    const approvalEnd =
      school?.indexOf("export type MemberWholeLodgeApprovalOverride") ?? -1;
    const approval = school?.slice(approvalStart, approvalEnd) ?? "";
    const locator = approval.indexOf("const heldLodgeLocator = expectedHeldBookingId");
    const transaction = approval.indexOf("conversion = await prisma.$transaction");
    const globalLock = approval.indexOf("pg_advisory_xact_lock(1)");
    const heldKey = approval.indexOf("expectedHeldLodgeId!", globalLock);
    const lodgeLock = approval.indexOf("acquireLodgeCapacityLock(tx, bookingLodgeId)");
    const requestReread = approval.indexOf(
      "const lockedRequest = await tx.bookingRequest.findUnique",
    );
    const heldReread = approval.indexOf("held = await tx.booking.findUnique");
    const heldClaim = approval.indexOf("const heldClaim = await tx.booking.updateMany");
    const firstSideEffect = approval.indexOf(
      "const guestCreates = await buildApprovalGuestCreates",
    );

    for (const marker of [
      locator,
      transaction,
      globalLock,
      heldKey,
      lodgeLock,
      requestReread,
      heldReread,
      heldClaim,
      firstSideEffect,
    ]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(approval.match(/pg_advisory_xact_lock\(1\)/g) ?? []).toHaveLength(1);
    expect(locator).toBeLessThan(transaction);
    expect(transaction).toBeLessThan(globalLock);
    expect(globalLock).toBeLessThan(heldKey);
    expect(heldKey).toBeLessThan(lodgeLock);
    expect(globalLock).toBeLessThan(lodgeLock);
    expect(lodgeLock).toBeLessThan(requestReread);
    expect(requestReread).toBeLessThan(heldReread);
    expect(heldReread).toBeLessThan(heldClaim);
    expect(heldClaim).toBeLessThan(firstSideEffect);
    expect(approval).toContain("if (heldClaim.count === 0)");
    expect(approval).toContain("request.lodgeId !== held.lodgeId");
    expect(approval).toContain("lodgeId: conversion.lodgeId");
  });

  it("binds generic held conversion to the immutable held-booking lodge", () => {
    const generic = sources.find(
      ({ rel }) => rel === "src/lib/booking-request.ts",
    )?.text;
    expect(generic).toBeDefined();

    const approval =
      generic?.slice(
        generic.indexOf("export async function approveBookingRequest"),
      ) ?? "";
    const locator = approval.indexOf("const heldLodgeLocator = expectedHeldBookingId");
    const transaction = approval.indexOf("conversion = await prisma.$transaction");
    const globalLock = approval.indexOf("pg_advisory_xact_lock(1)", transaction);
    const heldKey = approval.indexOf("expectedHeldLodgeId!", globalLock);
    const lodgeLock = approval.indexOf("acquireLodgeCapacityLock(tx, requestLodgeId)");
    const requestReread = approval.indexOf(
      "const lockedRequest = await tx.bookingRequest.findUnique",
    );
    const heldReread = approval.indexOf("held = await tx.booking.findUnique");
    const guardedConversion = approval.indexOf("const converted = await tx.booking.updateMany");

    for (const marker of [
      locator,
      transaction,
      globalLock,
      heldKey,
      lodgeLock,
      requestReread,
      heldReread,
      guardedConversion,
    ]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(locator).toBeLessThan(transaction);
    expect(globalLock).toBeLessThan(heldKey);
    expect(heldKey).toBeLessThan(lodgeLock);
    expect(lodgeLock).toBeLessThan(requestReread);
    expect(requestReread).toBeLessThan(heldReread);
    expect(heldReread).toBeLessThan(guardedConversion);
    expect(approval).toContain("request.lodgeId !== held.lodgeId");
    expect(approval).toContain("lodgeId: conversion.lodgeId");
  });

  it("mints the per-lodge capacity key only in lodge-capacity-lock.ts", () => {
    const offenders = sources
      .filter(({ rel }) => rel !== CAPACITY_LOCK_MINT)
      .filter(({ text }) => countCodeOccurrences(text, "hashtextextended") > 0)
      .map(({ rel }) => rel);

    expect(
      offenders,
      "hashtextextended found outside src/lib/lodge-capacity-lock.ts. The per-lodge " +
        "capacity key must only be constructed by acquireLodgeCapacityLock so " +
        "every participant provably shares one key — call the helper instead " +
        "of rebuilding the expression."
    ).toEqual([]);
  });
});
