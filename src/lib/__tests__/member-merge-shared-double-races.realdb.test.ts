/**
 * Real-PostgreSQL proof for the member-merge shared-double defect (#2595).
 *
 * Merging a duplicate whose CONFIRMED partner link is DROPPED by the merge
 * (because the master already has its one confirmed partner) leaves the master
 * and the duplicate's ex-partner sitting in the same DOUBLE bed on a future
 * lodge night with no partnership backing the share. Every other lifecycle
 * event that breaks the sharing precondition — link dissolve, deactivation,
 * ADULT-to-minor correction, account deletion, seasonal tier change — runs the
 * canonical partner-share sweep; merge never did, and no database constraint
 * supplies the invariant.
 *
 * This suite drives the REAL production entrypoints against a real database:
 * `buildMemberMergePreview` + `executeMemberMerge`, which since the #2618
 * integration performs the repair itself as merge step 3b. Every assertion below
 * therefore reads COMMITTED rows written by the production merge — no
 * re-implementation of either side, and no test-only composition of the two.
 * `acquireFuturePartnerSharedAllocationLocks` +
 * `sweepUnbackedFutureSharedDoublesWithLocksHeld` are imported only to drive a
 * SECOND pass for the idempotence case.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL that `concurrency-lock-races.realdb.test.ts` already
 * provisions (#1881) and cleans its own uniquely-namespaced fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

// A member merge joins the global cohort at the TOP of its transaction (#2595
// takes the partner-share prefix immediately after the hosting policy-set key, so
// the fixed global -> lodge -> member order holds). Reaching that point still
// costs a whole preview pass first, run outside the transaction by the admin
// route and by `runRealMemberMerge` below. The poller therefore gets a far larger
// bound than the parent harness's 5s diagnostic — a timeout here must mean "a
// production writer stopped joining the cohort", never "the merge was still
// building its preview".
const LOCK_POLL_TIMEOUT_MS = 30_000;
const RACE_TEST_TIMEOUT_MS = 120_000;

const ACTOR_ID = "race-2595-admin";
const LOSER_ID = "race-2595-loser";
const MASTER_ID = "race-2595-master";
const EX_PARTNER_ID = "race-2595-partner";
const MASTER_PARTNER_ID = "race-2595-qpartner";
const MERGE_MEMBER_IDS = [
  ACTOR_ID,
  LOSER_ID,
  MASTER_ID,
  EX_PARTNER_ID,
  MASTER_PARTNER_ID,
] as const;

const LODGE_ID = "race-2595-merge-lodge";
const ROOM_ID = "race-2595-merge-room";
const UNBACKED_DOUBLE_ID = "race-2595-unbacked-double";
const BACKED_DOUBLE_ID = "race-2595-backed-double";
// Spare singles so the racing production writers have somewhere to place their
// own booking without displacing anybody: a cramped room would make the race
// cases fail on the planner's displacement bookkeeping instead of on this
// issue's invariant.
const SPARE_SINGLE_IDS = [
  "race-2595-spare-single-1",
  "race-2595-spare-single-2",
];
const MERGE_BED_IDS = [
  UNBACKED_DOUBLE_ID,
  BACKED_DOUBLE_ID,
  ...SPARE_SINGLE_IDS,
];

const LOSER_BOOKING_ID = "race-2595-loser-booking";
const EX_PARTNER_BOOKING_ID = "race-2595-partner-booking";
const MASTER_BOOKING_ID = "race-2595-master-booking";
const MASTER_PARTNER_BOOKING_ID = "race-2595-qpartner-booking";
const NEIGHBOUR_BOOKING_ID = "race-2595-neighbour-booking";
const MERGE_BOOKING_IDS = [
  LOSER_BOOKING_ID,
  EX_PARTNER_BOOKING_ID,
  MASTER_BOOKING_ID,
  MASTER_PARTNER_BOOKING_ID,
];
const ALL_BOOKING_IDS = [...MERGE_BOOKING_IDS, NEIGHBOUR_BOOKING_ID];

const LOSER_GUEST_ID = "race-2595-loser-guest";
const EX_PARTNER_GUEST_ID = "race-2595-partner-guest";
const MASTER_GUEST_ID = "race-2595-master-guest";
const MASTER_PARTNER_GUEST_ID = "race-2595-qpartner-guest";
const NEIGHBOUR_GUEST_ID = "race-2595-neighbour-guest";

const LOSER_ALLOCATION_ID = "race-2595-loser-allocation";
const EX_PARTNER_ALLOCATION_ID = "race-2595-partner-allocation";
const MASTER_ALLOCATION_ID = "race-2595-master-allocation";
const MASTER_PARTNER_ALLOCATION_ID = "race-2595-qpartner-allocation";

// Far-future lodge nights, so the frozen test clock (#2481) can never make the
// sweep's `stayDate >= today` window vacuous. The merge fixture occupies ONE
// night; the neighbouring booking the race cases drive occupies the NEXT one.
const MERGE_NIGHT = new Date("2099-06-01T00:00:00.000Z");
const MERGE_CHECK_OUT = new Date("2099-06-02T00:00:00.000Z");
const NEIGHBOUR_NIGHT = new Date("2099-06-02T00:00:00.000Z");
const NEIGHBOUR_CHECK_OUT = new Date("2099-06-03T00:00:00.000Z");
const MERGE_NIGHT_DATE_ONLY = "2099-06-01";
const NEIGHBOUR_NIGHT_DATE_ONLY = "2099-06-02";
const NEIGHBOUR_CHECK_OUT_DATE_ONLY = "2099-06-03";

const SHARE_SWEPT_AUDIT_ACTION = "BED_ALLOCATION_PARTNER_SHARE_SWEPT";

let prisma: typeof import("@/lib/prisma")["prisma"];
let buildMemberMergePreview: typeof import("@/lib/member-merge")["buildMemberMergePreview"];
let executeMemberMerge: typeof import("@/lib/member-merge")["executeMemberMerge"];
let runAutoBedAllocation: typeof import("@/lib/admin-bed-allocation")["runAutoBedAllocation"];
let reconcileBedAllocationsForBooking: typeof import("@/lib/bed-allocation-lifecycle")["reconcileBedAllocationsForBooking"];
let acquireFuturePartnerSharedAllocationLocks: typeof import("@/lib/bed-allocation-lifecycle")["acquireFuturePartnerSharedAllocationLocks"];
let sweepUnbackedFutureSharedDoublesWithLocksHeld: typeof import("@/lib/bed-allocation-lifecycle")["sweepUnbackedFutureSharedDoublesWithLocksHeld"];
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

/** Standalone fail-closed copy: importing this file must not register the parent suite. */
export function assertSafeMergeShareRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Member-merge shared-double races need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run member-merge shared-double races against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Member-merge shared-double race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Member-merge shared-double race DB name must contain 'concurrency_race_1881'.",
    );
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function pendingGlobalLockWaiters(): Promise<number> {
  const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND classid = 0
      AND objid = 1
      AND granted = false
  `;
  return rows[0]?.count ?? 0;
}

async function waitForGlobalLockWaiters(expected: number): Promise<void> {
  const startedAt = process.hrtime.bigint();
  let seen = 0;
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    seen = await pendingGlobalLockWaiters();
    if (seen >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${expected} writer(s) on global bed-allocation lock(1); saw ${seen}. A production writer may have stopped joining the global cohort.`,
  );
}

/**
 * Queue two production writers in an explicit order behind a real holder of
 * lock(1). PostgreSQL grants advisory waiters in queue order, so observing each
 * waiter before starting the next makes the serialized outcome deterministic
 * without sleeps or test-only hooks in production code.
 */
async function runWritersInGlobalQueueOrder<A, B>(
  firstWriter: () => Promise<A>,
  secondWriter: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const lockHeld = deferred();
  const releaseLock = deferred();
  let holderError: unknown;
  const holder = lockHolderClient
    .$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        lockHeld.resolve();
        await releaseLock.promise;
      },
      { maxWait: 5_000, timeout: LOCK_POLL_TIMEOUT_MS + 30_000 },
    )
    .catch((error: unknown) => {
      holderError = error;
      lockHeld.resolve();
    });

  await lockHeld.promise;
  if (holderError) {
    throw new Error(`Could not hold global lock(1): ${String(holderError)}`);
  }

  const first = firstWriter();
  let second: Promise<B> | undefined;
  let observationError: unknown;
  try {
    await waitForGlobalLockWaiters(1);
    second = secondWriter();
    await waitForGlobalLockWaiters(2);
  } catch (error) {
    observationError = error;
  } finally {
    releaseLock.resolve();
  }

  await holder;
  if (holderError) {
    throw new Error(`Global lock(1) holder failed: ${String(holderError)}`);
  }
  if (!second) {
    await Promise.allSettled([first]);
    throw observationError;
  }
  const outcomes = await Promise.allSettled([first, second]);
  if (observationError) throw observationError;
  return outcomes;
}

/** Surface a losing writer's real error instead of a bare "rejected". */
function settledValueOrThrow<T>(outcome: PromiseSettledResult<T>): T {
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

async function clearMergeFixtures(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { memberId: { in: [...MERGE_MEMBER_IDS] } },
        { actorMemberId: { in: [...MERGE_MEMBER_IDS] } },
        { targetId: { in: [...MERGE_MEMBER_IDS, ...ALL_BOOKING_IDS] } },
      ],
    },
  });
  await prisma.hostingCoverageReevaluation.deleteMany({
    where: { memberId: { in: [...MERGE_MEMBER_IDS] } },
  });
  await prisma.hostingCoverageIncident.deleteMany({
    where: { bookingId: { in: ALL_BOOKING_IDS } },
  });
  await prisma.bookingEvent.deleteMany({
    where: { bookingId: { in: ALL_BOOKING_IDS } },
  });
  await prisma.booking.deleteMany({ where: { id: { in: ALL_BOOKING_IDS } } });
  await prisma.memberPartnerLink.deleteMany({
    where: {
      OR: [
        { memberAId: { in: [...MERGE_MEMBER_IDS] } },
        { memberBId: { in: [...MERGE_MEMBER_IDS] } },
      ],
    },
  });
}

function canonicalPair(a: string, b: string) {
  return a < b ? { memberAId: a, memberBId: b } : { memberAId: b, memberBId: a };
}

const MERGE_MEMBER_SEED = [
  {
    id: ACTOR_ID,
    email: "race-2595-admin@example.invalid",
    firstName: "Merge",
    lastName: "Admin",
    role: "ADMIN" as const,
  },
  {
    id: LOSER_ID,
    email: "race-2595-loser@example.invalid",
    firstName: "Duplicate",
    lastName: "Loser",
    role: "USER" as const,
  },
  {
    id: MASTER_ID,
    email: "race-2595-master@example.invalid",
    firstName: "Surviving",
    lastName: "Master",
    role: "USER" as const,
  },
  {
    id: EX_PARTNER_ID,
    email: "race-2595-partner@example.invalid",
    firstName: "Dropped",
    lastName: "Partner",
    role: "USER" as const,
  },
  {
    id: MASTER_PARTNER_ID,
    email: "race-2595-qpartner@example.invalid",
    firstName: "Kept",
    lastName: "Partner",
    role: "USER" as const,
  },
];

/**
 * Re-establish the five members. Called per case, not once, because the merge
 * HARD-DELETES the duplicate — the next case's bookings would otherwise fail
 * the `Booking_memberId_fkey` foreign key.
 */
async function seedMergeMembers(): Promise<void> {
  for (const member of MERGE_MEMBER_SEED) {
    await prisma.member.upsert({
      where: { id: member.id },
      create: {
        id: member.id,
        email: member.email,
        passwordHash: "not-a-real-password",
        firstName: member.firstName,
        lastName: member.lastName,
        role: member.role,
        ageTier: "ADULT",
        active: true,
      },
      update: {
        email: member.email,
        firstName: member.firstName,
        lastName: member.lastName,
        role: member.role,
        ageTier: "ADULT",
        active: true,
        archivedAt: null,
      },
    });
  }
  // `actorIsFullAdmin` reads the access-role join, not `Member.role`.
  await prisma.memberAccessRole.upsert({
    where: { memberId_role: { memberId: ACTOR_ID, role: "ADMIN" } },
    create: { memberId: ACTOR_ID, role: "ADMIN" },
    update: {},
  });
}

async function seedBooking(params: {
  bookingId: string;
  memberId: string;
  guestId: string;
  guestMemberId: string | null;
  firstName: string;
  lastName: string;
  night: Date;
  checkOut: Date;
}): Promise<void> {
  await prisma.booking.create({
    data: {
      id: params.bookingId,
      memberId: params.memberId,
      lodgeId: LODGE_ID,
      checkIn: params.night,
      checkOut: params.checkOut,
      status: "CONFIRMED",
      totalPriceCents: 100,
      finalPriceCents: 100,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: params.guestId,
      bookingId: params.bookingId,
      memberId: params.guestMemberId,
      firstName: params.firstName,
      lastName: params.lastName,
      ageTier: "ADULT",
      stayStart: params.night,
      stayEnd: params.checkOut,
      priceCents: 100,
    },
  });
  await prisma.bookingGuestNight.create({
    data: {
      bookingGuestId: params.guestId,
      stayDate: params.night,
      priceCents: 100,
    },
  });
}

/**
 * The exact scenario recorded on #2595, plus one neighbouring booking on the
 * NEXT night for the race cases to drive.
 *
 * The duplicate L holds a CONFIRMED partner link with P and shares a future
 * DOUBLE bed with them (L primary, P second occupant). The master M already
 * holds its one CONFIRMED partner Q and shares a DIFFERENT double with them,
 * which the merge must leave completely alone.
 */
async function seedMergeScenario(): Promise<void> {
  await clearMergeFixtures();
  // The merge HARD-DELETES the duplicate, so every case re-creates the members.
  await seedMergeMembers();

  const mergeNight = { night: MERGE_NIGHT, checkOut: MERGE_CHECK_OUT };
  await seedBooking({
    bookingId: LOSER_BOOKING_ID,
    memberId: LOSER_ID,
    guestId: LOSER_GUEST_ID,
    guestMemberId: LOSER_ID,
    firstName: "Duplicate",
    lastName: "Loser",
    ...mergeNight,
  });
  await seedBooking({
    bookingId: EX_PARTNER_BOOKING_ID,
    memberId: EX_PARTNER_ID,
    guestId: EX_PARTNER_GUEST_ID,
    guestMemberId: EX_PARTNER_ID,
    firstName: "Dropped",
    lastName: "Partner",
    ...mergeNight,
  });
  await seedBooking({
    bookingId: MASTER_BOOKING_ID,
    memberId: MASTER_ID,
    guestId: MASTER_GUEST_ID,
    guestMemberId: MASTER_ID,
    firstName: "Surviving",
    lastName: "Master",
    ...mergeNight,
  });
  await seedBooking({
    bookingId: MASTER_PARTNER_BOOKING_ID,
    memberId: MASTER_PARTNER_ID,
    guestId: MASTER_PARTNER_GUEST_ID,
    guestMemberId: MASTER_PARTNER_ID,
    firstName: "Kept",
    lastName: "Partner",
    ...mergeNight,
  });
  // The race writers' own work: the night AFTER the merge fixture, with a
  // NON-member guest. See NEIGHBOUR_ALLOCATION_WINDOW_NOTE below.
  await seedBooking({
    bookingId: NEIGHBOUR_BOOKING_ID,
    memberId: ACTOR_ID,
    guestId: NEIGHBOUR_GUEST_ID,
    guestMemberId: null,
    firstName: "Neighbouring",
    lastName: "Guest",
    night: NEIGHBOUR_NIGHT,
    checkOut: NEIGHBOUR_CHECK_OUT,
  });

  await prisma.memberPartnerLink.createMany({
    data: [
      {
        ...canonicalPair(LOSER_ID, EX_PARTNER_ID),
        status: "CONFIRMED",
        confirmedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        ...canonicalPair(MASTER_ID, MASTER_PARTNER_ID),
        status: "CONFIRMED",
        confirmedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
  });

  await prisma.bedAllocation.createMany({
    data: [
      {
        id: LOSER_ALLOCATION_ID,
        bookingId: LOSER_BOOKING_ID,
        bookingGuestId: LOSER_GUEST_ID,
        roomId: ROOM_ID,
        bedId: UNBACKED_DOUBLE_ID,
        bedType: "DOUBLE",
        stayDate: MERGE_NIGHT,
        source: "MANUAL",
      },
      {
        id: EX_PARTNER_ALLOCATION_ID,
        bookingId: EX_PARTNER_BOOKING_ID,
        bookingGuestId: EX_PARTNER_GUEST_ID,
        roomId: ROOM_ID,
        bedId: UNBACKED_DOUBLE_ID,
        bedType: "DOUBLE",
        stayDate: MERGE_NIGHT,
        source: "MANUAL",
        isSecondOccupant: true,
      },
      {
        id: MASTER_ALLOCATION_ID,
        bookingId: MASTER_BOOKING_ID,
        bookingGuestId: MASTER_GUEST_ID,
        roomId: ROOM_ID,
        bedId: BACKED_DOUBLE_ID,
        bedType: "DOUBLE",
        stayDate: MERGE_NIGHT,
        source: "MANUAL",
      },
      {
        id: MASTER_PARTNER_ALLOCATION_ID,
        bookingId: MASTER_PARTNER_BOOKING_ID,
        bookingGuestId: MASTER_PARTNER_GUEST_ID,
        roomId: ROOM_ID,
        bedId: BACKED_DOUBLE_ID,
        bedType: "DOUBLE",
        stayDate: MERGE_NIGHT,
        source: "MANUAL",
        isSecondOccupant: true,
      },
    ],
  });
}

/** Drive the real preview + execute pair, exactly as the admin route does. */
async function runRealMemberMerge() {
  const preview = await buildMemberMergePreview({
    masterId: MASTER_ID,
    loserId: LOSER_ID,
    actorMemberId: ACTOR_ID,
  });
  expect(preview.blockers).toEqual([]);
  return executeMemberMerge({
    masterId: MASTER_ID,
    loserId: LOSER_ID,
    actorMemberId: ACTOR_ID,
    previewToken: preview.previewToken,
    confirmationText: preview.confirmationPhrase,
  });
}

/**
 * ============================= THE WIRED SEAM ==============================
 * `executeMemberMerge` now owns the reconciliation. The two edits that used to
 * be held out of this branch behind PR #2618 are in `src/lib/member-merge.ts`:
 *
 *   1. immediately AFTER `await lockAdultMemberHostingPolicySet(tx)` and BEFORE
 *      the two sorted `member-lifecycle:` advisory locks:
 *
 *          await acquireFuturePartnerSharedAllocationLocks(tx, [masterId, loserId]);
 *
 *      — the global cohort `lock(1)` plus every affected lodge key, sorted, so
 *      the fixed global -> lodge -> member order holds. Taking it at the point
 *      of use would acquire a lodge key with member keys already held.
 *
 *   2. as step 3b, AFTER `applyMoves` (guest rows now name the master), AFTER
 *      step 2's `resolvePartnerLinks` (the surviving partnerships are final),
 *      and after every drift refusal, BEFORE step 4's Xero teardown:
 *
 *          sweptShares = await sweepUnbackedFutureSharedDoublesWithLocksHeld({
 *            memberIds: [masterId, loserId],
 *            reason: "members_merged",
 *            db: tx,
 *          });
 *
 * plus the post-commit `sendAdminPartnerShareSweptAlert` next to
 * `settleHostingCoverageAfterCommit`.
 *
 * That source order is pinned structurally by
 * `adult-member-hosting-coverage-lock.test.ts` ("pins the merge participant
 * re-plan, late sweeps, queue write and drain order"). This suite proves the
 * OBSERVABLE result of it on real PostgreSQL: `runRealMemberMerge()` below is
 * the entire production path, and every assertion reads committed rows.
 * ==========================================================================
 */

/**
 * A SECOND reconciliation pass over the same scope, driven through the same two
 * production helpers the merge itself uses. Only the idempotence case needs it:
 * the merge hard-deletes the loser, so a second merge cannot be run, and this is
 * the only way to ask "does another pass write anything?".
 */
async function runSecondReconciliationPass() {
  return prisma.$transaction(async (tx) => {
    await acquireFuturePartnerSharedAllocationLocks(tx, [MASTER_ID, LOSER_ID]);
    return sweepUnbackedFutureSharedDoublesWithLocksHeld({
      memberIds: [MASTER_ID, LOSER_ID],
      reason: "members_merged",
      db: tx,
    });
  });
}

async function sharedDoubleOccupants(bedId: string) {
  const rows = await prisma.bedAllocation.findMany({
    where: { bedId, stayDate: MERGE_NIGHT },
    select: {
      id: true,
      bedId: true,
      isSecondOccupant: true,
      bookingId: true,
      bookingGuest: { select: { memberId: true } },
    },
    orderBy: { isSecondOccupant: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    bedId: row.bedId,
    isSecondOccupant: row.isSecondOccupant,
    bookingId: row.bookingId,
    memberId: row.bookingGuest.memberId,
  }));
}

async function confirmedPartnerIdsOf(memberId: string): Promise<string[]> {
  const links = await prisma.memberPartnerLink.findMany({
    where: {
      status: "CONFIRMED",
      OR: [{ memberAId: memberId }, { memberBId: memberId }],
    },
    select: { memberAId: true, memberBId: true },
  });
  return links
    .map((link) => (link.memberAId === memberId ? link.memberBId : link.memberAId))
    .sort();
}

async function shareSweptAuditRows() {
  return prisma.auditLog.findMany({
    where: {
      action: SHARE_SWEPT_AUDIT_ACTION,
      targetId: { in: ALL_BOOKING_IDS },
    },
    select: { targetId: true, metadata: true },
    orderBy: { targetId: "asc" },
  });
}

/**
 * The #2595 invariant, read back from the committed rows: no FUTURE bed-night
 * in the fixture lodge holds two occupants without a CONFIRMED partner link
 * behind them, AND the master's own backed share is still there.
 *
 * Deliberately a scan of the whole lodge window rather than a fixed row list, so
 * a concurrent writer that re-plans the contested pair onto a different bed
 * cannot satisfy it by accident — and the second half stops "sweep everything"
 * from passing.
 */
async function expectNoUnbackedSharedDouble(): Promise<void> {
  const rows = await prisma.bedAllocation.findMany({
    where: { room: { lodgeId: LODGE_ID }, stayDate: { gte: MERGE_NIGHT } },
    select: {
      id: true,
      bedId: true,
      stayDate: true,
      isSecondOccupant: true,
      bookingGuest: { select: { memberId: true } },
    },
  });
  const confirmed = await prisma.memberPartnerLink.findMany({
    where: { status: "CONFIRMED" },
    select: { memberAId: true, memberBId: true },
  });
  const confirmedPairs = new Set(
    confirmed.map((link) => `${link.memberAId}:${link.memberBId}`),
  );

  const byBedNight = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.bedId}:${row.stayDate.toISOString().slice(0, 10)}`;
    byBedNight.set(key, [...(byBedNight.get(key) ?? []), row]);
  }
  for (const [bedNight, occupants] of byBedNight) {
    if (occupants.length < 2) continue;
    const primaryMemberId =
      occupants.find((row) => !row.isSecondOccupant)?.bookingGuest.memberId ?? null;
    const secondMemberId =
      occupants.find((row) => row.isSecondOccupant)?.bookingGuest.memberId ?? null;
    const pair =
      primaryMemberId && secondMemberId
        ? canonicalPair(primaryMemberId, secondMemberId)
        : null;
    expect({
      bedNight,
      primaryMemberId,
      secondMemberId,
      backedByConfirmedPartnership: Boolean(
        pair && confirmedPairs.has(`${pair.memberAId}:${pair.memberBId}`),
      ),
    }).toMatchObject({ backedByConfirmedPartnership: true });
  }

  const backed = await sharedDoubleOccupants(BACKED_DOUBLE_ID);
  expect(backed.map((row) => row.id)).toEqual([
    MASTER_ALLOCATION_ID,
    MASTER_PARTNER_ALLOCATION_ID,
  ]);
}

describe("member-merge shared-double race DB safety guard (#2595)", () => {
  it("accepts only the dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeMergeShareRaceDbUrl(
        "postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881",
      ),
    ).not.toThrow();
  });

  it.each([
    "postgresql://user:pass@db.example.org:55442/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeMergeShareRaceDbUrl(url)).toThrow();
  });
});

(RUN ? describe : describe.skip)(
  "member merge leaves no unbacked shared double - real PostgreSQL (#2595)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    let previousBedAllocationModuleEnabled: boolean | null = null;
    let moduleSettingsExisted = false;

    beforeAll(async () => {
      assertSafeMergeShareRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ buildMemberMergePreview, executeMemberMerge } = await import(
        "@/lib/member-merge"
      ));
      ({ runAutoBedAllocation } = await import("@/lib/admin-bed-allocation"));
      ({
        acquireFuturePartnerSharedAllocationLocks,
        reconcileBedAllocationsForBooking,
        sweepUnbackedFutureSharedDoublesWithLocksHeld,
      } = await import("@/lib/bed-allocation-lifecycle"));

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([
          import("@prisma/client"),
          import("@/lib/prisma-adapter"),
        ]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({
          adapter: createPrismaPgAdapter(url.toString()),
        });
      };
      lockHolderClient = createSeparateClient("race-2595-merge-lock-holder");
      observerClient = createSeparateClient("race-2595-merge-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      const priorModuleSettings = await prisma.clubModuleSettings.findUnique({
        where: { id: "default" },
        select: { bedAllocation: true },
      });
      moduleSettingsExisted = priorModuleSettings !== null;
      previousBedAllocationModuleEnabled =
        priorModuleSettings?.bedAllocation ?? null;
      await prisma.clubModuleSettings.upsert({
        where: { id: "default" },
        create: { id: "default", bedAllocation: true },
        update: { bedAllocation: true },
        // Explicit select on a WRITE too: Prisma's implicit RETURNING would
        // otherwise name every column of the singleton, which the #175
        // blue/green guard forbids anywhere under `src/`.
        select: { id: true },
      });

      await prisma.bedAllocationSettings.deleteMany({ where: { id: LODGE_ID } });
      await clearMergeFixtures();
      await prisma.lodgeBed.deleteMany({ where: { id: { in: MERGE_BED_IDS } } });
      await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({
        where: { id: { in: [...MERGE_MEMBER_IDS] } },
      });
      await seedMergeMembers();

      await prisma.lodge.create({
        data: {
          id: LODGE_ID,
          name: "Race 2595 Merge Lodge",
          slug: "race-2595-merge",
        },
      });
      await prisma.lodgeRoom.create({
        data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Race 2595 Merge Room" },
      });
      await prisma.lodgeBed.createMany({
        data: [
          {
            id: UNBACKED_DOUBLE_ID,
            roomId: ROOM_ID,
            name: "Unbacked double",
            bedType: "DOUBLE",
            sortOrder: 0,
          },
          {
            id: BACKED_DOUBLE_ID,
            roomId: ROOM_ID,
            name: "Backed double",
            bedType: "DOUBLE",
            sortOrder: 1,
          },
          ...SPARE_SINGLE_IDS.map((id, index) => ({
            id,
            roomId: ROOM_ID,
            name: `Spare single ${index + 1}`,
            bedType: "SINGLE" as const,
            sortOrder: 2 + index,
          })),
        ],
      });
      await prisma.bedAllocationSettings.create({
        data: {
          id: LODGE_ID,
          lodgeId: LODGE_ID,
          autoAllocationEnabled: true,
          allocationPriorityOrder: [
            "BOOKING_COHESION",
            "STAY_CONTINUITY",
            "REQUESTED_ROOM",
            "FAMILY_COHESION",
          ],
          updatedByMemberId: ACTOR_ID,
        },
      });
    }, 120_000);

    beforeEach(async () => {
      await clearMergeFixtures();
    });

    afterEach(async () => {
      await clearMergeFixtures();
    });

    afterAll(async () => {
      const cleanupErrors: unknown[] = [];
      const attempt = async (work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      if (typeof prisma !== "undefined") {
        await attempt(clearMergeFixtures);
        await attempt(() =>
          prisma.bedAllocationSettings.deleteMany({ where: { id: LODGE_ID } }),
        );
        await attempt(() =>
          prisma.lodgeBed.deleteMany({ where: { id: { in: MERGE_BED_IDS } } }),
        );
        await attempt(() => prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } }));
        await attempt(() => prisma.lodge.deleteMany({ where: { id: LODGE_ID } }));
        await attempt(() =>
          prisma.member.deleteMany({ where: { id: { in: [...MERGE_MEMBER_IDS] } } }),
        );
        if (moduleSettingsExisted) {
          await attempt(() =>
            prisma.clubModuleSettings.update({
              where: { id: "default" },
              data: {
                bedAllocation: previousBedAllocationModuleEnabled ?? false,
              },
              select: { id: true },
            }),
          );
        } else {
          await attempt(() =>
            prisma.clubModuleSettings.deleteMany({ where: { id: "default" } }),
          );
        }
      }
      await attempt(() => lockHolderClient?.$disconnect());
      await attempt(() => observerClient?.$disconnect());
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Member-merge share race cleanup failed",
        );
      }
    });

    it("removes the shared double the dropped partner link no longer backs", async () => {
      await seedMergeScenario();

      // THE defect this issue records. Nothing but the production merge runs.
      const merge = await runRealMemberMerge();
      expect(merge.masterId).toBe(MASTER_ID);

      const [unbacked, backed, masterPartners, sweptAudits] = await Promise.all([
        sharedDoubleOccupants(UNBACKED_DOUBLE_ID),
        sharedDoubleOccupants(BACKED_DOUBLE_ID),
        confirmedPartnerIdsOf(MASTER_ID),
        shareSweptAuditRows(),
      ]);

      // The dropped L-P link is gone and the master keeps only its own Q.
      expect(masterPartners).toEqual([MASTER_PARTNER_ID]);

      // The bed the merge invalidated keeps only its primary; the ex-partner's
      // second-occupant row is back in the awaiting-allocation queue.
      expect(unbacked).toEqual([
        {
          id: LOSER_ALLOCATION_ID,
          bedId: UNBACKED_DOUBLE_ID,
          isSecondOccupant: false,
          bookingId: LOSER_BOOKING_ID,
          memberId: MASTER_ID,
        },
      ]);

      // The master's own still-CONFIRMED share is untouched — the whole reason
      // merge cannot reuse the #1756 member-scope sweep.
      expect(backed).toEqual([
        {
          id: MASTER_ALLOCATION_ID,
          bedId: BACKED_DOUBLE_ID,
          isSecondOccupant: false,
          bookingId: MASTER_BOOKING_ID,
          memberId: MASTER_ID,
        },
        {
          id: MASTER_PARTNER_ALLOCATION_ID,
          bedId: BACKED_DOUBLE_ID,
          isSecondOccupant: true,
          bookingId: MASTER_PARTNER_BOOKING_ID,
          memberId: MASTER_PARTNER_ID,
        },
      ]);

      // Both sides of the swept bed-night are audited, against the merge issue.
      // This is also where the removed row is NAMED in committed state — the
      // same facts the post-commit admin alert is built from.
      expect(sweptAudits).toHaveLength(2);
      expect(sweptAudits.map((row) => row.targetId).sort()).toEqual(
        [EX_PARTNER_BOOKING_ID, LOSER_BOOKING_ID].sort(),
      );
      for (const row of sweptAudits) {
        expect(row.metadata).toMatchObject({
          issue: 2595,
          reason: "members_merged",
          stayDates: [MERGE_NIGHT_DATE_ONLY],
          allocationIds: [EX_PARTNER_ALLOCATION_ID],
        });
      }
      expect(
        sweptAudits.map((row) => [
          row.targetId,
          (row.metadata as { role?: string } | null)?.role,
          (row.metadata as { counterpartBookingId?: string } | null)
            ?.counterpartBookingId,
        ]),
      ).toEqual(
        [
          [EX_PARTNER_BOOKING_ID, "second_occupant", LOSER_BOOKING_ID],
          [LOSER_BOOKING_ID, "primary", EX_PARTNER_BOOKING_ID],
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
    });

    it("is idempotent: a second reconciliation pass writes nothing", async () => {
      await seedMergeScenario();
      await runRealMemberMerge();

      const second = await runSecondReconciliationPass();
      expect(second).toEqual([]);
      expect(await shareSweptAuditRows()).toHaveLength(2);
      expect(await sharedDoubleOccupants(UNBACKED_DOUBLE_ID)).toHaveLength(1);
      expect(await sharedDoubleOccupants(BACKED_DOUBLE_ID)).toHaveLength(2);
    });

    it("keeps the share the merge CARRIES OVER when the master had no confirmed partner", async () => {
      await seedMergeScenario();
      // Drop the master's own confirmed partner, so `planPartnerLinkMerge`
      // re-points the duplicate's CONFIRMED link onto the master instead of
      // deleting it. The share stays fully backed and must survive.
      await prisma.memberPartnerLink.deleteMany({
        where: canonicalPair(MASTER_ID, MASTER_PARTNER_ID),
      });
      await prisma.bedAllocation.deleteMany({
        where: { id: MASTER_PARTNER_ALLOCATION_ID },
      });

      await runRealMemberMerge();

      expect(await confirmedPartnerIdsOf(MASTER_ID)).toEqual([EX_PARTNER_ID]);
      expect(await sharedDoubleOccupants(UNBACKED_DOUBLE_ID)).toEqual([
        {
          id: LOSER_ALLOCATION_ID,
          bedId: UNBACKED_DOUBLE_ID,
          isSecondOccupant: false,
          bookingId: LOSER_BOOKING_ID,
          memberId: MASTER_ID,
        },
        {
          id: EX_PARTNER_ALLOCATION_ID,
          bedId: UNBACKED_DOUBLE_ID,
          isSecondOccupant: true,
          bookingId: EX_PARTNER_BOOKING_ID,
          memberId: EX_PARTNER_ID,
        },
      ]);
      expect(await shareSweptAuditRows()).toEqual([]);
    });

    // The PIN that used to sit here — "the merge transaction does not yet
    // reconcile (wiring deferred behind #2618)" — is deleted, because the wiring
    // landed and it was written to fail the moment it did. The first case above
    // is its replacement: the SAME bare `runRealMemberMerge()` call, now
    // asserting that the invalid share is gone instead of that it survives.

    // -----------------------------------------------------------------------
    // NEIGHBOUR_ALLOCATION_WINDOW_NOTE
    //
    // Both race cases below point their planner-running writer at the
    // NEIGHBOURING lodge night rather than the contested one. That is a
    // work-around for a SEPARATE pre-existing defect, not a weakening of the
    // race.
    //
    // `assertRoomNightAgeMixConsistent` (`bed-allocation.ts`; test-only — it
    // runs under `NODE_ENV === "test"`) throws whenever the planner is seeded
    // with an EXISTING shared DOUBLE. Seeding calls `trackRoomNightOccupant`
    // once per `occupiedBedNights` row, but `setOccupant` keys `occupantByKey`
    // by `occupiedKey(bedId, stayDate)`, so a double's second row overwrites its
    // primary and the assertion's recomputation loses one adult. Two of THIS
    // branch's own race cases already fail on it at `acd0a435a`
    // (`bed-allocation-removal-races.realdb.test.ts`, the `AUTO_FIRST` and
    // `LIFECYCLE_FIRST` orders), so it predates this work and is out of scope
    // here. Widening either writer's planner window onto the contested night —
    // directly, or via the dashboard's continuity-context expansion for a
    // booking whose envelope starts earlier — reproduces it every time.
    //
    // What these cases do still prove, which is what this issue needs: the
    // merge reconciliation JOINS the global cohort, so PostgreSQL grants it and
    // the other bed-allocation writer in a deterministic order on the same
    // lodge; both commit; and the #2595 invariant holds on the committed rows in
    // EITHER grant order.
    // -----------------------------------------------------------------------
    const NEIGHBOUR_RANGE = {
      from: NEIGHBOUR_NIGHT,
      to: NEIGHBOUR_CHECK_OUT,
      fromDate: NEIGHBOUR_NIGHT_DATE_ONLY,
      toDate: NEIGHBOUR_CHECK_OUT_DATE_ONLY,
    };

    /**
     * The committed evidence that the MERGE removed exactly the unbacked row:
     * the row is gone and both audit sides name its allocation id. Read from
     * committed state rather than a returned array, because the production
     * entrypoint under test is `executeMemberMerge` alone.
     */
    async function expectMergeSweptOnlyTheUnbackedRow(): Promise<void> {
      const audits = await shareSweptAuditRows();
      expect(audits).toHaveLength(2);
      for (const row of audits) {
        expect(row.metadata).toMatchObject({
          issue: 2595,
          reason: "members_merged",
          allocationIds: [EX_PARTNER_ALLOCATION_ID],
        });
      }
      expect(
        await prisma.bedAllocation.findUnique({
          where: { id: EX_PARTNER_ALLOCATION_ID },
          select: { id: true },
        }),
      ).toBeNull();
    }

    /**
     * ================== THE WRITER QUEUED BEHIND A MERGE ===================
     * A consequence of #2595 that is production behaviour, not a test artifact,
     * and is stated here rather than hidden behind a retry.
     *
     * A PostgreSQL advisory xact lock is released only at COMMIT, so once merge
     * takes the global cohort `lock(1)` at the top of its transaction it holds it
     * for the whole merge — and a merge deliberately runs with `timeout: 120s`
     * because re-pointing 70+ relations takes hundreds of sequential round-trips
     * (docs/CONCURRENCY_AND_LOCKING.md → "Member merge"). The ordinary
     * bed-allocation writers raced here open their own interactive transaction
     * and THEN block on `lock(1)`, on Prisma's default 5-second budget
     * (`writeUnderLocks` in `admin-bed-allocation.ts`,
     * `reconcileBedAllocationsForBookingWithGlobalLockHeld`). So a writer that
     * arrives while a merge is running either gets the lock in time, or its own
     * budget expires first and Prisma rejects it with `P2028`.
     *
     * Both outcomes are SAFE, and this helper asserts exactly that: the writer
     * either committed its own work, or it wrote NOTHING and was rejected with a
     * retryable transaction expiry. What it must never do is commit anything that
     * breaks the #2595 invariant, and the caller asserts the invariant itself
     * either way. The alternative — asserting only "it always commits" — was true
     * only while merge took no global key, and would now pass or fail on how
     * loaded the machine is rather than on the contract.
     *
     * Whether that availability cost is acceptable, or whether merge should get a
     * narrower prefix, is recorded as an owner decision on #2595.
     * ======================================================================
     */
    function isRetryableTransactionExpiry(error: unknown): boolean {
      return (
        error instanceof Error && /expired transaction/i.test(error.message)
      );
    }

    async function neighbourAllocationRows() {
      return prisma.bedAllocation.findMany({
        where: { bookingId: NEIGHBOUR_BOOKING_ID },
        select: { bookingGuestId: true, stayDate: true, source: true },
      });
    }

    /**
     * The queued writer's outcome, whichever way the budget fell. `onCommitted`
     * asserts the writer's OWN success contract; the rejected arm proves it wrote
     * nothing at all.
     */
    async function expectQueuedWriterCommittedOrCleanlyRejected<T>(
      outcome: PromiseSettledResult<T>,
      onCommitted: (value: T) => void,
    ): Promise<void> {
      if (outcome.status === "fulfilled") {
        onCommitted(outcome.value);
        await expectNeighbourAllocated();
        return;
      }
      expect(
        isRetryableTransactionExpiry(outcome.reason),
        `A writer queued behind a merge may only fail with a retryable ` +
          `transaction expiry; got: ${String(outcome.reason)}`,
      ).toBe(true);
      // Rejected, so its whole transaction rolled back: no partial placement.
      expect(await neighbourAllocationRows()).toEqual([]);
    }

    async function expectNeighbourAllocated(): Promise<void> {
      const rows = await neighbourAllocationRows();
      expect(rows).toEqual([
        {
          bookingGuestId: NEIGHBOUR_GUEST_ID,
          stayDate: NEIGHBOUR_NIGHT,
          source: "AUTO",
        },
      ]);
    }

    it.each(["MERGE_FIRST", "AUTO_FIRST"] as const)(
      "serializes the merge reconciliation and explicit auto-allocation when %s is queued first",
      async (order) => {
        await seedMergeScenario();

        const mergeWriter = () => runRealMemberMerge();
        const autoWriter = () =>
          runAutoBedAllocation({ range: NEIGHBOUR_RANGE, lodgeId: LODGE_ID });

        // Destructured per branch rather than by swapping one tuple: the two
        // writers return different shapes, so a swapped tuple would widen both
        // to a union and lose the assertions below.
        let mergeOutcome: PromiseSettledResult<
          Awaited<ReturnType<typeof mergeWriter>>
        >;
        let autoOutcome: PromiseSettledResult<
          Awaited<ReturnType<typeof autoWriter>>
        >;
        if (order === "MERGE_FIRST") {
          [mergeOutcome, autoOutcome] = await runWritersInGlobalQueueOrder(
            mergeWriter,
            autoWriter,
          );
        } else {
          [autoOutcome, mergeOutcome] = await runWritersInGlobalQueueOrder(
            autoWriter,
            mergeWriter,
          );
        }

        // The merge always commits: its own 120s budget outlasts the queue wait
        // in either order, and its step-3b reconciliation removed exactly the
        // unbacked row.
        expect(settledValueOrThrow(mergeOutcome).masterId).toBe(MASTER_ID);
        await expectMergeSweptOnlyTheUnbackedRow();

        if (order === "AUTO_FIRST") {
          // Queued FIRST, so it never waits on the merge: it must commit.
          expect(settledValueOrThrow(autoOutcome)).toEqual({ count: 1 });
          await expectNeighbourAllocated();
        } else {
          // Queued BEHIND the merge on its own 5s budget — see
          // "THE WRITER QUEUED BEHIND A MERGE" above.
          await expectQueuedWriterCommittedOrCleanlyRejected(
            autoOutcome,
            (value) => expect(value).toEqual({ count: 1 }),
          );
        }

        // The invariant holds on the committed rows either way — the point of
        // the whole case.
        await expectNoUnbackedSharedDouble();
      },
    );

    it.each(["MERGE_FIRST", "LIFECYCLE_FIRST"] as const)(
      "serializes the merge reconciliation and lifecycle reconciliation when %s is queued first",
      async (order) => {
        await seedMergeScenario();

        const mergeWriter = () => runRealMemberMerge();
        const lifecycleWriter = () =>
          reconcileBedAllocationsForBooking({ bookingId: NEIGHBOUR_BOOKING_ID });

        let mergeOutcome: PromiseSettledResult<
          Awaited<ReturnType<typeof mergeWriter>>
        >;
        let lifecycleOutcome: PromiseSettledResult<
          Awaited<ReturnType<typeof lifecycleWriter>>
        >;
        if (order === "MERGE_FIRST") {
          [mergeOutcome, lifecycleOutcome] = await runWritersInGlobalQueueOrder(
            mergeWriter,
            lifecycleWriter,
          );
        } else {
          [lifecycleOutcome, mergeOutcome] = await runWritersInGlobalQueueOrder(
            lifecycleWriter,
            mergeWriter,
          );
        }

        expect(settledValueOrThrow(mergeOutcome).masterId).toBe(MASTER_ID);
        await expectMergeSweptOnlyTheUnbackedRow();

        if (order === "LIFECYCLE_FIRST") {
          expect(settledValueOrThrow(lifecycleOutcome)).toMatchObject({
            enabled: true,
            createdCount: 1,
            deletedCount: 0,
          });
          await expectNeighbourAllocated();
        } else {
          await expectQueuedWriterCommittedOrCleanlyRejected(
            lifecycleOutcome,
            (value) =>
              expect(value).toMatchObject({
                enabled: true,
                createdCount: 1,
                deletedCount: 0,
              }),
          );
        }

        await expectNoUnbackedSharedDouble();
      },
    );
  },
);
