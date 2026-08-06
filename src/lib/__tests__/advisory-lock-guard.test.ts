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
//    hashtextextended must not appear outside src/lib/capacity.ts, so an
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
  // #1881: the two capacity-admission branches in confirm-pending-guests
  // deliberately compose global lifecycle lock(1) first with the canonical
  // per-lodge capacity lock. The global lock prevents cancellation/settlement
  // resurrection while the lodge lock serialises the capacity claim.
  "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts": 2,
  "src/app/api/bookings/[id]/waitlist-confirm/route.ts": 1,
  // #2265: the create-payment-intent pay transaction is a three-tier writer —
  // it flips a booking's status, claims capacity, and moves account credit. It
  // composes global lifecycle lock(1) FIRST, then the canonical per-lodge
  // capacity lock, then the per-member credit-ledger lock, matching
  // markBookingPaymentSucceeded. Before this it held no global lock at all, so
  // its status writes did not exclude a concurrent cancel.
  "src/app/api/payments/create-payment-intent/route.ts": 1,
  "src/app/api/payments/switch-to-internet-banking/route.ts": 1,
  // #2366: an existing-allocation move does not change booking status, but it
  // composes with cancellation because cancellation prunes those rows. It
  // therefore takes global lock(1) before the destination-lodge capacity lock,
  // re-reads the source rows under both, and cannot resurrect a cancelled
  // booking's allocation after the prune commits.
  "src/lib/admin-bed-allocation.ts": 1,
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
  "src/lib/booking-request.ts": 1,
  "src/lib/cron-group-settlement-reaper.ts": 2,
  "src/lib/cron-quote-expiry-reminders.ts": 2,
  "src/lib/group-cancel.ts": 2,
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
  "src/lib/school-booking-request.ts": 1,
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
  // #2364: lockAdultMemberHostingPolicySet takes the single global
  // adult-member-hosting-policy-set key before any read by an admin CRUD write
  // or a configuration import, and the migration's BEFORE STATEMENT trigger
  // takes the same key ahead of any tuple lock so operator DML joins the same
  // order. It composes with exactly one other key, in one fixed direction —
  // config-transfer-import, then minimum-stay-policy-set, then this — and no
  // booking or capacity path ever takes it, so the keyspaces are disjoint.
  // Counterpart analysis in docs/CONCURRENCY_AND_LOCKING.md.
  "src/lib/adult-member-hosting-policy-set.ts": 1,
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
  "src/lib/capacity.ts": 1,
  "src/lib/config-transfer/apply.ts": 1,
  "src/lib/member-credit.ts": 1,
  "src/lib/member-lifecycle-actions.ts": 2,
  // #2363: every minimum-stay policy writer takes the one global policy-set
  // key before reading/planning. The migration's BEFORE STATEMENT trigger
  // takes the exact same key for draining old-colour INSERT/UPDATE/DELETE before
  // PostgreSQL reaches tuple locks. Config import orders its existing singleton
  // first, then this key; live CRUD takes only this key.
  "src/lib/minimum-stay-policy-set.ts": 1,
  // #1937: executeMemberMerge takes the shared member-lifecycle:{id} key for
  // BOTH the master and the loser, in sorted id order (deadlock-free), so a
  // merge serialises with any concurrent delete/archive/merge touching either
  // member (same dual-lock pattern as member-lifecycle-actions.ts).
  "src/lib/member-merge.ts": 2,
  "src/lib/member-partner-link.ts": 1,
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
  "src/lib/admin-bed-allocation.ts": 1,
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
  // Member merge (#2243): one id-ordered `SELECT 1 … FOR UPDATE` over BOTH
  // member rows immediately before the merge's fresh field-patch read, inside
  // the transaction that already holds both member-lifecycle advisory locks
  // (order: advisory locks -> row locks; the loser's row was already locked by
  // teardownLoserXero's update, so this adds only the master's). Counterpart
  // writers are the member-photo route above (member-row lock, no advisory
  // lock) and admin member edits — both serialise behind this lock or land a
  // drift the merge refuses with a 409. Ids are sorted so two merges sharing a
  // member cannot deadlock. See docs/CONCURRENCY_AND_LOCKING.md →
  // "Member merge — dual member-lifecycle lock (E11 #1937)" and the #2243
  // fresh-read/drift-refusal paragraphs above it.
  "src/lib/member-merge.ts": 1,
};

const CAPACITY_LOCK_MINT = "src/lib/capacity.ts";

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

/** Count non-comment source lines in `source` matching `needle`. */
function countCodeOccurrences(source: string, needle: string): number {
  let count = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
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

  it("keeps every SELECT FOR UPDATE protocol inside the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of sources) {
      const count = countCodeOccurrences(text, "FOR UPDATE");
      if (count > 0) found[rel] = count;
    }

    expect(
      found,
      "Row-lock sites changed. Inventory their counterpart writers and order " +
        "against advisory and row locks in docs/CONCURRENCY_AND_LOCKING.md.",
    ).toEqual(ROW_LOCK_SITE_INVENTORY);
  });

  it("keeps school held-reuse on global -> lodge -> re-read -> guarded claim", () => {
    const school = sources.find(
      ({ rel }) => rel === "src/lib/school-booking-request.ts",
    )?.text;
    expect(school).toBeDefined();

    const approval =
      school?.slice(
        school.indexOf("export async function approveSchoolBookingRequest"),
      ) ?? "";
    const locator = approval.indexOf("const heldLodgeLocator = expectedHeldBookingId");
    const transaction = approval.indexOf("conversion = await prisma.$transaction");
    const conditionalGlobal = approval.indexOf("if (expectedHeldBookingId)");
    const globalLock = approval.indexOf("pg_advisory_xact_lock(1)", conditionalGlobal);
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
      conditionalGlobal,
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
    expect(locator).toBeLessThan(transaction);
    expect(transaction).toBeLessThan(conditionalGlobal);
    expect(conditionalGlobal).toBeLessThan(globalLock);
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

  it("mints the per-lodge capacity key only in capacity.ts", () => {
    const offenders = sources
      .filter(({ rel }) => rel !== CAPACITY_LOCK_MINT)
      .filter(({ text }) => countCodeOccurrences(text, "hashtextextended") > 0)
      .map(({ rel }) => rel);

    expect(
      offenders,
      "hashtextextended found outside src/lib/capacity.ts. The per-lodge " +
        "capacity key must only be constructed by acquireLodgeCapacityLock so " +
        "every participant provably shares one key — call the helper instead " +
        "of rebuilding the expression."
    ).toEqual([]);
  });
});
