/**
 * Real-PostgreSQL serialization proofs for reviewed bed-allocation removal
 * (#2594). Ordinary Vitest runs skip the production-path races. The explicit
 * concurrency job imports this file from concurrency-lock-races.realdb.test.ts
 * after migrating a disposable, loopback-only database.
 *
 * A third connection holds the exact production global booking lock while the
 * two real writers reach PostgreSQL. The test observes their waiters in
 * pg_locks, queues them in a deliberate order, then releases the holder. This
 * forces the interleaving without sleeps or test-only hooks in production code.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LOCK_POLL_TIMEOUT_MS = 2_000;
const RACE_TEST_TIMEOUT_MS = 30_000;

const ACTOR_ID = "race-2594-admin";
const LODGE_ID = "race-2594-lodge";
const ROOM_ID = "race-2594-room";
const OLD_DOUBLE_BED_ID = "race-2594-old-double";
const DESTINATION_BED_ID = "race-2594-destination";
const OTHER_BED_ID = "race-2594-other";
const BOOKING_ID = "race-2594-booking";
const PARTNER_BOOKING_ID = "race-2594-partner-booking";
const GUEST_ID = "race-2594-guest";
const PARTNER_GUEST_ID = "race-2594-partner-guest";
const TARGET_ALLOCATION_ID = "race-2594-target-allocation";
const OTHER_ALLOCATION_ID = "race-2594-other-allocation";
const PARTNER_ALLOCATION_ID = "race-2594-partner-allocation";
const FIRST_NIGHT = new Date("2099-04-01T00:00:00.000Z");
const SECOND_NIGHT = new Date("2099-04-02T00:00:00.000Z");
const CHECK_OUT = new Date("2099-04-03T00:00:00.000Z");
const FIRST_NIGHT_DATE_ONLY = "2099-04-01";
const SECOND_NIGHT_DATE_ONLY = "2099-04-02";

const REMOVAL_AUDIT_ACTIONS = [
  "BED_ALLOCATION_REMOVAL_APPLIED",
  "BED_ALLOCATION_PARTNERS_PROMOTED",
] as const;
const MOVE_AUDIT_ACTIONS = [
  "BED_ALLOCATION_MANUAL_SET",
  "BED_ALLOCATION_PARTNER_PROMOTED",
] as const;

let prisma: typeof import("@/lib/prisma")["prisma"];
let previewBedAllocationRemoval: typeof import("@/lib/bed-allocation-removal")["previewBedAllocationRemoval"];
let applyBedAllocationRemoval: typeof import("@/lib/bed-allocation-removal")["applyBedAllocationRemoval"];
let moveBedAllocationsSameDate: typeof import("@/lib/admin-bed-allocation")["moveBedAllocationsSameDate"];
let runAutoBedAllocation: typeof import("@/lib/admin-bed-allocation")["runAutoBedAllocation"];
let reconcileBedAllocationsForBooking: typeof import("@/lib/bed-allocation-lifecycle")["reconcileBedAllocationsForBooking"];
let cancelBooking: typeof import("@/lib/booking-cancel")["cancelBooking"];
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

/** Standalone fail-closed copy: importing this file must not register the parent suite. */
export function assertSafeRemovalRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Bed-allocation removal races need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run bed-allocation removal races against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Bed-allocation removal race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Bed-allocation removal race DB name must contain 'concurrency_race_1881'.",
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
 * lock(1). PostgreSQL grants advisory waiters in queue order; observing each
 * waiter before starting the next makes the expected serialized outcome
 * deterministic and mutation-sensitive.
 */
async function runWritersInGlobalQueueOrder<A, B>(
  firstWriter: () => Promise<A>,
  secondWriter: () => Promise<B>,
): Promise<[
  PromiseSettledResult<A>,
  PromiseSettledResult<B>,
]> {
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
      { maxWait: 5_000, timeout: 10_000 },
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

function rejectionStatus(outcome: PromiseSettledResult<unknown>): number | null {
  if (outcome.status === "fulfilled") return null;
  return typeof outcome.reason === "object" &&
    outcome.reason !== null &&
    "status" in outcome.reason &&
    typeof outcome.reason.status === "number"
    ? outcome.reason.status
    : null;
}

async function clearBookingFixtures(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { memberId: ACTOR_ID },
        { actorMemberId: ACTOR_ID },
        { targetId: { in: [BOOKING_ID, PARTNER_BOOKING_ID] } },
      ],
    },
  });
  await prisma.bookingEvent.deleteMany({
    where: { bookingId: { in: [BOOKING_ID, PARTNER_BOOKING_ID] } },
  });
  await prisma.booking.deleteMany({
    where: { id: { in: [BOOKING_ID, PARTNER_BOOKING_ID] } },
  });
}

async function seedBookings(
  status: "CONFIRMED" | "AWAITING_REVIEW" = "CONFIRMED",
  includePartner = true,
) {
  await clearBookingFixtures();
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: ACTOR_ID,
      lodgeId: LODGE_ID,
      checkIn: FIRST_NIGHT,
      checkOut: CHECK_OUT,
      status,
      totalPriceCents: 200,
      finalPriceCents: 200,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Removal",
      lastName: "Guest",
      ageTier: "ADULT",
      stayStart: FIRST_NIGHT,
      stayEnd: CHECK_OUT,
      priceCents: 200,
    },
  });
  if (includePartner) {
    await prisma.booking.create({
      data: {
        id: PARTNER_BOOKING_ID,
        memberId: ACTOR_ID,
        lodgeId: LODGE_ID,
        checkIn: FIRST_NIGHT,
        checkOut: CHECK_OUT,
        status: "CONFIRMED",
        totalPriceCents: 200,
        finalPriceCents: 200,
      },
    });
    await prisma.bookingGuest.create({
      data: {
        id: PARTNER_GUEST_ID,
        bookingId: PARTNER_BOOKING_ID,
        firstName: "Shared",
        lastName: "Partner",
        ageTier: "ADULT",
        stayStart: FIRST_NIGHT,
        stayEnd: CHECK_OUT,
        priceCents: 200,
      },
    });
  }
}

async function seedTargetWithPartner(stayDate = FIRST_NIGHT): Promise<void> {
  await prisma.bedAllocation.createMany({
    data: [
      {
        id: TARGET_ALLOCATION_ID,
        bookingId: BOOKING_ID,
        bookingGuestId: GUEST_ID,
        roomId: ROOM_ID,
        bedId: OLD_DOUBLE_BED_ID,
        bedType: "DOUBLE",
        stayDate,
        source: "MANUAL",
      },
      {
        id: PARTNER_ALLOCATION_ID,
        bookingId: PARTNER_BOOKING_ID,
        bookingGuestId: PARTNER_GUEST_ID,
        roomId: ROOM_ID,
        bedId: OLD_DOUBLE_BED_ID,
        bedType: "DOUBLE",
        stayDate,
        source: "MANUAL",
        isSecondOccupant: true,
      },
    ],
  });
}

async function reviewedTargetRemoval(stayDate: string) {
  const request = {
    scope: {
      type: "ALLOCATION" as const,
      allocationId: TARGET_ALLOCATION_ID,
      bookingId: BOOKING_ID,
      bookingGuestId: GUEST_ID,
      lodgeId: LODGE_ID,
      stayDate,
    },
    categories: ["MANUAL_DRAFT" as const],
  };
  const preview = await previewBedAllocationRemoval(request);
  return {
    preview,
    apply: () =>
      applyBedAllocationRemoval({
        actorMemberId: ACTOR_ID,
        request: { ...request, previewDigest: preview.digest },
      }),
  };
}

async function actionCount(actions: readonly string[]): Promise<number> {
  return prisma.auditLog.count({
    where: { memberId: ACTOR_ID, action: { in: [...actions] } },
  });
}

async function waitForAuditAction(action: string): Promise<void> {
  const startedAt = process.hrtime.bigint();
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const count = await prisma.auditLog.count({
      where: { memberId: ACTOR_ID, action },
    });
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for asynchronous ${action} audit`);
}

describe("bed-allocation removal race DB safety guard (#2594)", () => {
  it("accepts only the dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeRemovalRaceDbUrl(
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
    expect(() => assertSafeRemovalRaceDbUrl(url)).toThrow();
  });
});

(RUN ? describe : describe.skip)(
  "reviewed bed-allocation removal races - real PostgreSQL (#2594)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    let previousBedAllocationModuleEnabled: boolean | null = null;
    let moduleSettingsExisted = false;

    beforeAll(async () => {
      assertSafeRemovalRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ previewBedAllocationRemoval, applyBedAllocationRemoval } = await import(
        "@/lib/bed-allocation-removal"
      ));
      ({ moveBedAllocationsSameDate, runAutoBedAllocation } = await import(
        "@/lib/admin-bed-allocation"
      ));
      ({ reconcileBedAllocationsForBooking } = await import(
        "@/lib/bed-allocation-lifecycle"
      ));
      ({ cancelBooking } = await import("@/lib/booking-cancel"));

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
      lockHolderClient = createSeparateClient("race-2594-lock-holder");
      observerClient = createSeparateClient("race-2594-observer");
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
      });

      await prisma.bedAllocationSettings.deleteMany({ where: { id: LODGE_ID } });
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

      await clearBookingFixtures();
      await prisma.lodgeBed.deleteMany({
        where: {
          id: { in: [OLD_DOUBLE_BED_ID, DESTINATION_BED_ID, OTHER_BED_ID] },
        },
      });
      await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: ACTOR_ID } });

      await prisma.member.create({
        data: {
          id: ACTOR_ID,
          email: "race-2594@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Removal",
          lastName: "Admin",
          role: "ADMIN",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({
        data: { id: LODGE_ID, name: "Race 2594 Lodge", slug: "race-2594" },
      });
      await prisma.lodgeRoom.create({
        data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Race 2594 Room" },
      });
      await prisma.lodgeBed.createMany({
        data: [
          {
            id: OLD_DOUBLE_BED_ID,
            roomId: ROOM_ID,
            name: "Old double",
            bedType: "DOUBLE",
            sortOrder: 0,
          },
          {
            id: DESTINATION_BED_ID,
            roomId: ROOM_ID,
            name: "Destination",
            bedType: "SINGLE",
            sortOrder: 1,
          },
          {
            id: OTHER_BED_ID,
            roomId: ROOM_ID,
            name: "Other",
            bedType: "SINGLE",
            sortOrder: 2,
          },
        ],
      });
    }, 60_000);

    beforeEach(async () => {
      await clearBookingFixtures();
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
        await attempt(clearBookingFixtures);
        await attempt(() =>
          prisma.bedAllocationSettings.deleteMany({ where: { id: LODGE_ID } }),
        );
        await attempt(() =>
          prisma.lodgeBed.deleteMany({
            where: {
              id: { in: [OLD_DOUBLE_BED_ID, DESTINATION_BED_ID, OTHER_BED_ID] },
            },
          }),
        );
        await attempt(() => prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } }));
        await attempt(() => prisma.lodge.deleteMany({ where: { id: LODGE_ID } }));
        await attempt(() => prisma.member.deleteMany({ where: { id: ACTOR_ID } }));
        if (moduleSettingsExisted) {
          await attempt(() =>
            prisma.clubModuleSettings.update({
              where: { id: "default" },
              data: {
                bedAllocation: previousBedAllocationModuleEnabled ?? false,
              },
            }),
          );
        } else {
          await attempt(() =>
            prisma.clubModuleSettings.deleteMany({ where: { id: "default" } }),
          );
        }
      }
      if (typeof lockHolderClient !== "undefined") {
        await attempt(() => lockHolderClient.$disconnect());
      }
      if (typeof observerClient !== "undefined") {
        await attempt(() => observerClient.$disconnect());
      }
      if (typeof prisma !== "undefined") {
        await attempt(() => prisma.$disconnect());
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Bed-allocation removal race teardown failed",
        );
      }
    }, 60_000);

    it.each(["MOVE_FIRST", "REMOVAL_FIRST"] as const)(
      "serializes reset and move atomically when %s is queued first",
      async (order) => {
        await seedBookings();
        await seedTargetWithPartner();
        const removal = await reviewedTargetRemoval(FIRST_NIGHT_DATE_ONLY);
        const move = () =>
          moveBedAllocationsSameDate({
            allocationIds: [TARGET_ALLOCATION_ID],
            bedId: DESTINATION_BED_ID,
            actorMemberId: ACTOR_ID,
          });

        const outcomes =
          order === "MOVE_FIRST"
            ? await runWritersInGlobalQueueOrder(move, removal.apply)
            : await runWritersInGlobalQueueOrder(removal.apply, move);
        const [moveOutcome, removalOutcome] =
          order === "MOVE_FIRST"
            ? outcomes
            : [outcomes[1], outcomes[0]];

        const [target, partner, removalAudits, moveAudits] = await Promise.all([
          prisma.bedAllocation.findUnique({
            where: { id: TARGET_ALLOCATION_ID },
            select: { bedId: true },
          }),
          prisma.bedAllocation.findUniqueOrThrow({
            where: { id: PARTNER_ALLOCATION_ID },
            select: { isSecondOccupant: true },
          }),
          actionCount(REMOVAL_AUDIT_ACTIONS),
          actionCount(MOVE_AUDIT_ACTIONS),
        ]);

        expect(partner.isSecondOccupant).toBe(false);
        if (order === "MOVE_FIRST") {
          expect(moveOutcome.status).toBe("fulfilled");
          expect(rejectionStatus(removalOutcome)).toBe(409);
          expect(target?.bedId).toBe(DESTINATION_BED_ID);
          expect(removalAudits).toBe(0);
          expect(moveAudits).toBe(2);
        } else {
          expect(removalOutcome.status).toBe("fulfilled");
          expect(rejectionStatus(moveOutcome)).toBe(404);
          expect(target).toBeNull();
          expect(removalAudits).toBe(2);
          expect(moveAudits).toBe(0);
        }
      },
    );

    it("serializes an explicit auto run before reset, records no reset-triggered planning, and permits a later explicit rebuild", async () => {
      await seedBookings("CONFIRMED", false);
      await prisma.bedAllocation.create({
        data: {
          id: TARGET_ALLOCATION_ID,
          bookingId: BOOKING_ID,
          bookingGuestId: GUEST_ID,
          roomId: ROOM_ID,
          bedId: OLD_DOUBLE_BED_ID,
          bedType: "DOUBLE",
          stayDate: FIRST_NIGHT,
          source: "MANUAL",
        },
      });
      const removal = await reviewedTargetRemoval(FIRST_NIGHT_DATE_ONLY);
      const range = {
        from: FIRST_NIGHT,
        to: CHECK_OUT,
        fromDate: FIRST_NIGHT_DATE_ONLY,
        toDate: "2099-04-03",
      };

      const [autoOutcome, removalOutcome] = await runWritersInGlobalQueueOrder(
        () => runAutoBedAllocation({ range, lodgeId: LODGE_ID }),
        removal.apply,
      );
      expect(autoOutcome.status).toBe("fulfilled");
      expect(removalOutcome.status).toBe("fulfilled");
      if (autoOutcome.status === "fulfilled") {
        expect(autoOutcome.value.count).toBe(1);
      }

      const afterRace = await prisma.bedAllocation.findMany({
        where: { bookingId: BOOKING_ID },
        select: { stayDate: true, source: true },
        orderBy: { stayDate: "asc" },
      });
      expect(afterRace).toEqual([
        expect.objectContaining({ stayDate: SECOND_NIGHT, source: "AUTO" }),
      ]);
      const removalAudit = await prisma.auditLog.findFirstOrThrow({
        where: { memberId: ACTOR_ID, action: "BED_ALLOCATION_REMOVAL_APPLIED" },
        select: { metadata: true },
      });
      expect(removalAudit.metadata).toMatchObject({
        autoAllocationTriggered: false,
      });

      // D-R19 forbids RESET from invoking the planner. It does not forbid a
      // later, separately authorised Run Auto Allocation action. A fresh run
      // sees the committed missing first night and may rebuild it.
      const laterExplicitRun = await runAutoBedAllocation({
        range,
        lodgeId: LODGE_ID,
      });
      expect(laterExplicitRun.count).toBe(1);
      const rebuilt = await prisma.bedAllocation.findMany({
        where: { bookingId: BOOKING_ID },
        select: { stayDate: true, source: true },
        orderBy: { stayDate: "asc" },
      });
      expect(rebuilt).toEqual([
        expect.objectContaining({ stayDate: FIRST_NIGHT, source: "AUTO" }),
        expect.objectContaining({ stayDate: SECOND_NIGHT, source: "AUTO" }),
      ]);
    });

    it("returns a refreshed stale preview after lifecycle reconciliation wins, with no partial reset audit", async () => {
      await seedBookings();
      await prisma.bedAllocation.create({
        data: {
          id: OTHER_ALLOCATION_ID,
          bookingId: BOOKING_ID,
          bookingGuestId: GUEST_ID,
          roomId: ROOM_ID,
          bedId: OTHER_BED_ID,
          stayDate: FIRST_NIGHT,
          source: "MANUAL",
        },
      });
      await seedTargetWithPartner(SECOND_NIGHT);
      await prisma.bookingGuest.update({
        where: { id: GUEST_ID },
        data: { stayEnd: SECOND_NIGHT },
      });
      const removal = await reviewedTargetRemoval(SECOND_NIGHT_DATE_ONLY);

      const [lifecycleOutcome, removalOutcome] =
        await runWritersInGlobalQueueOrder(
          () => reconcileBedAllocationsForBooking({ bookingId: BOOKING_ID }),
          removal.apply,
        );

      expect(lifecycleOutcome.status).toBe("fulfilled");
      expect(rejectionStatus(removalOutcome)).toBe(409);
      if (removalOutcome.status === "rejected") {
        expect(removalOutcome.reason).toMatchObject({
          refreshedPreview: expect.objectContaining({ matchedRowCount: 0 }),
        });
      }
      const [target, validRow, partner, removalAudits] = await Promise.all([
        prisma.bedAllocation.findUnique({ where: { id: TARGET_ALLOCATION_ID } }),
        prisma.bedAllocation.findUnique({ where: { id: OTHER_ALLOCATION_ID } }),
        prisma.bedAllocation.findUniqueOrThrow({
          where: { id: PARTNER_ALLOCATION_ID },
          select: { isSecondOccupant: true },
        }),
        actionCount(REMOVAL_AUDIT_ACTIONS),
      ]);
      expect(target).toBeNull();
      expect(validRow).not.toBeNull();
      expect(partner.isSecondOccupant).toBe(false);
      expect(removalAudits).toBe(0);
    });

    it("returns a refreshed stale preview after production cancellation wins, with no partial reset state", async () => {
      await seedBookings("AWAITING_REVIEW");
      await seedTargetWithPartner();
      const removal = await reviewedTargetRemoval(FIRST_NIGHT_DATE_ONLY);

      const [cancelOutcome, removalOutcome] = await runWritersInGlobalQueueOrder(
        () =>
          cancelBooking(
            BOOKING_ID,
            ACTOR_ID,
            "ADMIN",
            "127.0.0.1",
            "card",
            {
              suppressCustomerNotification: true,
              notifyMember: false,
            },
          ),
        removal.apply,
      );

      expect(cancelOutcome.status).toBe("fulfilled");
      if (cancelOutcome.status === "fulfilled") {
        expect(cancelOutcome.value.status).toBe(200);
      }
      expect(rejectionStatus(removalOutcome)).toBe(409);
      // cancelBooking intentionally emits its legacy cancellation audit
      // asynchronously. Observe it before teardown so the unique fixture is
      // never cleaned while that write is still in flight.
      await waitForAuditAction("booking.cancel");
      const [booking, target, partner, removalAudits] = await Promise.all([
        prisma.booking.findUniqueOrThrow({
          where: { id: BOOKING_ID },
          select: { status: true },
        }),
        prisma.bedAllocation.findUnique({ where: { id: TARGET_ALLOCATION_ID } }),
        prisma.bedAllocation.findUniqueOrThrow({
          where: { id: PARTNER_ALLOCATION_ID },
          select: { isSecondOccupant: true },
        }),
        actionCount(REMOVAL_AUDIT_ACTIONS),
      ]);
      expect(booking.status).toBe("CANCELLED");
      expect(target).toBeNull();
      expect(partner.isSecondOccupant).toBe(false);
      expect(removalAudits).toBe(0);
    });
  },
);
