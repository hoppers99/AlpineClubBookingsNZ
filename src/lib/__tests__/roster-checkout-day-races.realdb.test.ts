/**
 * Real-PostgreSQL serialization proofs for checkout-day roster rows (#2622).
 *
 * Once a chore row can legitimately sit on a booking's CHECK-OUT date, the
 * roster and the booking-date writers contend for a partition that used to be
 * outside every envelope either of them locked. These tests force both winner
 * orders against a real PostgreSQL and assert the serialised outcome is legal:
 * a row that is still valid survives, a row that is no longer valid is removed
 * exactly once, and a CONFIRMED row is never silently destroyed.
 *
 * They are OFF by default and a no-op in ordinary CI/local runs: they run only
 * when `RUN_CONCURRENCY_RACE_TESTS=1`, read only `CONCURRENCY_RACE_DATABASE_URL`,
 * and refuse anything that is not a loopback host on port 55442+ with the
 * dedicated `concurrency_race_1881` marker in the database name.
 * `concurrency-lock-races.realdb.test.ts` imports this file so the explicit CI
 * race command picks it up without a workflow change.
 *
 * The date-change side replays the production composition with the production
 * helpers — the sorted `rosterOperationalDayRange` lock set, the tuple writes,
 * then `applyChoreCleanup` — rather than driving the whole quote/pricing
 * modification service, so what is under test is the lock and cleanup protocol
 * itself and not the pricing scaffolding around it.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LOCK_POLL_TIMEOUT_MS = 5_000;
const RACE_TEST_TIMEOUT_MS = 30_000;

const ACTOR_ID = "race-2622-admin";
const LODGE_ID = "race-2622-lodge";
const BOOKING_ID = "race-2622-booking";
const GUEST_ID = "race-2622-guest";
const MORNING_TEMPLATE_ID = "race-2622-strip-beds";
const EVENING_TEMPLATE_ID = "race-2622-dinner";

// A three-night stay: nights 1, 2 and 3 May, checking out on the 4th. The 4th
// is the operational day under test — the departure MORNING.
const CHECK_IN = new Date("2099-05-01T00:00:00.000Z");
const NIGHT_TWO = new Date("2099-05-02T00:00:00.000Z");
const NIGHT_THREE = new Date("2099-05-03T00:00:00.000Z");
const CHECK_OUT = new Date("2099-05-04T00:00:00.000Z");
const CHECKOUT_DAY_STRING = "2099-05-04";

let prisma: typeof import("@/lib/prisma")["prisma"];
let getAdminRosterForDate: typeof import("@/lib/admin-roster-service")["getAdminRosterForDate"];
let updateAdminRosterForDate: typeof import("@/lib/admin-roster-service")["updateAdminRosterForDate"];
let applyChoreCleanup: typeof import("@/lib/booking-modify-plan")["applyChoreCleanup"];
let lockRosterDateRangesAndDates: typeof import("@/lib/roster-lock")["lockRosterDateRangesAndDates"];
let rosterOperationalDayRange: typeof import("@/lib/roster-lock")["rosterOperationalDayRange"];
let acquireLodgeCapacityLock: typeof import("@/lib/capacity")["acquireLodgeCapacityLock"];
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

/** Standalone fail-closed copy: importing this file must not register the parent suite. */
export function assertSafeCheckoutRosterRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Checkout-day roster races need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run checkout-day roster races against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Checkout-day roster race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Checkout-day roster race DB name must contain 'concurrency_race_1881'.",
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
    `Timed out waiting for ${expected} writer(s) on the global lock(1); saw ${seen}. A roster or booking-date writer may have stopped joining the global cohort.`,
  );
}

/**
 * Queue two production writers in an explicit order behind a real holder of
 * lock(1). PostgreSQL grants advisory waiters in queue order, so observing each
 * waiter before starting the next makes the serialised outcome deterministic.
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
  if (!second) {
    await Promise.allSettled([first]);
    throw observationError;
  }
  const outcomes = await Promise.allSettled([first, second]);
  if (observationError) throw observationError;
  return outcomes;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function clearBookingFixtures(): Promise<void> {
  await prisma.choreAssignment.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

async function seedStay(): Promise<void> {
  await clearBookingFixtures();
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: ACTOR_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      // Must be an OPERATIONAL stay status. `OPERATIONAL_STAY_BOOKING_STATUSES`
      // is [PAID, COMPLETED] — "CONFIRMED" means payment is still outstanding,
      // so the eligibility selector would return nobody and every race below
      // would pass vacuously against an empty roster.
      status: "PAID",
      totalPriceCents: 300,
      finalPriceCents: 300,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Checkout",
      lastName: "Guest",
      ageTier: "ADULT",
      priceCents: 300,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      nights: {
        create: [CHECK_IN, NIGHT_TWO, NIGHT_THREE].map((stayDate) => ({
          stayDate,
          priceCents: 100,
        })),
      },
    },
  });
}

async function checkoutDayRows() {
  return prisma.choreAssignment.findMany({
    where: { bookingId: BOOKING_ID, date: CHECK_OUT },
    select: { id: true, status: true, bookingGuestId: true, choreTemplateId: true },
    orderBy: { choreTemplateId: "asc" },
  });
}

// ---------------------------------------------------------------------------
// The two production writers
// ---------------------------------------------------------------------------

function rosterRegenerate() {
  return updateAdminRosterForDate({
    date: CHECK_OUT,
    dateString: CHECKOUT_DAY_STRING,
    data: { action: "regenerate", includeNonEssential: true },
    lodgeId: LODGE_ID,
  });
}

function rosterConfirm() {
  return updateAdminRosterForDate({
    date: CHECK_OUT,
    dateString: CHECKOUT_DAY_STRING,
    data: { action: "confirm" },
    lodgeId: LODGE_ID,
  });
}

type RosterSnapshot = {
  revision: string;
  assignments: Array<{ id: string; choreTemplateId: string; bookingGuestId: string | null }>;
};

/**
 * Read the roster the operator is about to re-save.
 *
 * This MUST happen before the race starts. `getAdminRosterForDate` opens its
 * own `lock(1)` transaction, so folding it into the raced writer would make
 * that writer take the global lock twice: it would join the queue, read, commit,
 * and then re-queue behind the other writer — collapsing both winner orders into
 * "date change first" and making the assertions below meaningless.
 */
async function captureRosterSnapshot(): Promise<RosterSnapshot> {
  return (await getAdminRosterForDate({
    date: CHECK_OUT,
    dateString: CHECKOUT_DAY_STRING,
    regenerate: false,
    includeNonEssential: true,
    lodgeId: LODGE_ID,
  })).body as RosterSnapshot;
}

/** The operator's whole-roster Save of exactly what they were shown. ONE lock(1). */
function rosterSaveExistingRows(snapshot: RosterSnapshot) {
  return updateAdminRosterForDate({
    date: CHECK_OUT,
    dateString: CHECKOUT_DAY_STRING,
    lodgeId: LODGE_ID,
    data: {
      action: "save",
      baseRevision: snapshot.revision,
      acknowledgeCompletedReset: true,
      assignments: snapshot.assignments
        .filter((assignment) => assignment.bookingGuestId !== null)
        .map((assignment) => ({
          rowKey: assignment.id,
          assignmentId: assignment.id,
          choreTemplateId: assignment.choreTemplateId,
          bookingGuestId: assignment.bookingGuestId!,
        })),
    },
  });
}

/**
 * The production booking-date-change composition, minus pricing.
 *
 * Global lock(1), the immutable lodge tier, then ONE sorted roster-date set
 * built from `rosterOperationalDayRange` over the old and new envelopes plus
 * every stored assignment date — exactly what the three modification services
 * do — then the tuple writes and the real `applyChoreCleanup`.
 */
async function changeStayDates(newCheckIn: Date, newCheckOut: Date, nights: Date[]) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, LODGE_ID);
      const storedDates = await tx.choreAssignment.findMany({
        where: { bookingId: BOOKING_ID },
        select: { date: true },
      });
      await lockRosterDateRangesAndDates(
        tx,
        [
          rosterOperationalDayRange(CHECK_IN, CHECK_OUT),
          rosterOperationalDayRange(newCheckIn, newCheckOut),
        ],
        storedDates.map((assignment) => assignment.date),
      );

      await tx.booking.update({
        where: { id: BOOKING_ID },
        data: { checkIn: newCheckIn, checkOut: newCheckOut },
      });
      await tx.bookingGuestNight.deleteMany({ where: { bookingGuestId: GUEST_ID } });
      await tx.bookingGuest.update({
        where: { id: GUEST_ID },
        data: {
          stayStart: newCheckIn,
          stayEnd: newCheckOut,
          nights: {
            create: nights.map((stayDate) => ({ stayDate, priceCents: 100 })),
          },
        },
      });

      return applyChoreCleanup(tx, {
        bookingId: BOOKING_ID,
        newCheckIn,
        newCheckOut,
        datesChanged: true,
        rosterDatesAlreadyLocked: true,
      });
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
}

/** Drop the first night; the CHECK-OUT date, and so the roster day, is unchanged. */
function shortenFromTheStart() {
  return changeStayDates(NIGHT_TWO, CHECK_OUT, [NIGHT_TWO, NIGHT_THREE]);
}

/** Drop the last night; the 4th stops being an operational day for this stay. */
function shortenFromTheEnd() {
  return changeStayDates(CHECK_IN, NIGHT_THREE, [CHECK_IN, NIGHT_TWO]);
}

(RUN ? describe : describe.skip)(
  "checkout-day roster rows vs booking date changes - real PostgreSQL (#2622)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    beforeAll(async () => {
      assertSafeCheckoutRosterRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ getAdminRosterForDate, updateAdminRosterForDate } = await import(
        "@/lib/admin-roster-service"
      ));
      ({ applyChoreCleanup } = await import("@/lib/booking-modify-plan"));
      ({ lockRosterDateRangesAndDates, rosterOperationalDayRange } = await import(
        "@/lib/roster-lock"
      ));
      ({ acquireLodgeCapacityLock } = await import("@/lib/capacity"));

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
      lockHolderClient = createSeparateClient("race-2622-lock-holder");
      observerClient = createSeparateClient("race-2622-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      await clearBookingFixtures();
      await prisma.choreTemplate.deleteMany({
        where: { id: { in: [MORNING_TEMPLATE_ID, EVENING_TEMPLATE_ID] } },
      });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: ACTOR_ID } });

      await prisma.member.create({
        data: {
          id: ACTOR_ID,
          email: "race-2622@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Roster",
          lastName: "Admin",
          role: "ADMIN",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({
        data: { id: LODGE_ID, name: "Race 2622 Lodge", slug: "race-2622" },
      });
      await prisma.choreTemplate.createMany({
        data: [
          {
            id: MORNING_TEMPLATE_ID,
            lodgeId: LODGE_ID,
            name: "Strip beds",
            recommendedPeopleMin: 1,
            recommendedPeopleMax: 1,
            isEssential: true,
            timeOfDay: "MORNING",
            sortOrder: 1,
          },
          {
            id: EVENING_TEMPLATE_ID,
            lodgeId: LODGE_ID,
            name: "Dinner",
            recommendedPeopleMin: 1,
            recommendedPeopleMax: 1,
            isEssential: true,
            timeOfDay: "EVENING",
            sortOrder: 2,
          },
        ],
      });
    }, 60_000);

    beforeEach(seedStay);
    afterEach(clearBookingFixtures);

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
          prisma.choreTemplate.deleteMany({
            where: { id: { in: [MORNING_TEMPLATE_ID, EVENING_TEMPLATE_ID] } },
          }),
        );
        await attempt(() => prisma.lodge.deleteMany({ where: { id: LODGE_ID } }));
        await attempt(() => prisma.member.deleteMany({ where: { id: ACTOR_ID } }));
      }
      await attempt(async () => {
        await lockHolderClient?.$disconnect();
      });
      await attempt(async () => {
        await observerClient?.$disconnect();
      });
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Checkout-day roster race cleanup failed");
      }
    });

    it("generates a departure-morning roster at all", async () => {
      // The baseline the races depend on: on the check-out day the guest is
      // present for the morning, so the MORNING chore is rostered and the
      // EVENING chore is not.
      const result = await rosterRegenerate();
      expect(result.init?.status ?? 200).toBe(200);
      const rows = await checkoutDayRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        choreTemplateId: MORNING_TEMPLATE_ID,
        bookingGuestId: GUEST_ID,
        status: "SUGGESTED",
      });
    });

    for (const [label, order] of [
      ["roster first", "roster"],
      ["date change first", "dates"],
    ] as const) {
      it(`keeps the checkout-day row when the check-out date does not move (${label})`, async () => {
        // Trimming the FRONT of the stay leaves the 4th a departure morning, so
        // the row is still valid and must survive whichever writer wins.
        const outcomes = order === "roster"
          ? await runWritersInGlobalQueueOrder(rosterRegenerate, shortenFromTheStart)
          : await runWritersInGlobalQueueOrder(shortenFromTheStart, rosterRegenerate);
        expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);

        const rows = await checkoutDayRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          choreTemplateId: MORNING_TEMPLATE_ID,
          bookingGuestId: GUEST_ID,
        });
      });

      it(`removes the orphaned checkout-day row exactly once when the check-out date moves earlier (${label})`, async () => {
        // NON-VACUITY: seed the roster first, so there is a real departure-
        // morning row on the 4th before either writer starts. Without this the
        // "dates first" order would assert an empty table that was empty all
        // along.
        await rosterRegenerate();
        expect(await checkoutDayRows()).toHaveLength(1);

        const outcomes = order === "roster"
          ? await runWritersInGlobalQueueOrder(rosterRegenerate, shortenFromTheEnd)
          : await runWritersInGlobalQueueOrder(shortenFromTheEnd, rosterRegenerate);
        expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
        const dateChange = (order === "roster" ? outcomes[1] : outcomes[0]) as
          PromiseSettledResult<string[]>;

        // Both winner orders end with nothing on the 4th, and the row was only
        // ever SUGGESTED, so it goes without a warning: "roster first" rebuilds
        // it and cleanup then removes it; "dates first" removes the seeded row
        // and the regenerate that follows finds nobody present to re-create it.
        expect(await checkoutDayRows()).toEqual([]);
        expect(dateChange.status === "fulfilled" && dateChange.value).toEqual([]);

        // Nothing was collaterally created or moved onto another date.
        const survivors = await prisma.choreAssignment.findMany({
          where: { bookingId: BOOKING_ID },
          select: { date: true },
        });
        for (const survivor of survivors) {
          expect(survivor.date.getTime()).toBeLessThan(CHECK_OUT.getTime());
        }
      });

      it(`never silently destroys a CONFIRMED checkout-day row (${label})`, async () => {
        await rosterRegenerate();
        await rosterConfirm();
        const confirmed = await checkoutDayRows();
        expect(confirmed).toHaveLength(1);
        expect(confirmed[0]).toMatchObject({
          choreTemplateId: MORNING_TEMPLATE_ID,
          bookingGuestId: GUEST_ID,
          status: "CONFIRMED",
        });

        // Outside the race on purpose — see `captureRosterSnapshot`.
        const snapshot = await captureRosterSnapshot();
        expect(snapshot.assignments).toHaveLength(1);
        const save = () => rosterSaveExistingRows(snapshot);

        const outcomes = order === "roster"
          ? await runWritersInGlobalQueueOrder(save, shortenFromTheEnd)
          : await runWritersInGlobalQueueOrder(shortenFromTheEnd, save);
        const [saveOutcome, dateChange] = (order === "roster"
          ? [outcomes[0], outcomes[1]]
          : [outcomes[1], outcomes[0]]) as [
            PromiseSettledResult<{ body: unknown; init?: ResponseInit }>,
            PromiseSettledResult<string[]>,
          ];
        expect(saveOutcome.status).toBe("fulfilled");
        expect(dateChange.status).toBe("fulfilled");
        if (saveOutcome.status !== "fulfilled" || dateChange.status !== "fulfilled") return;

        const rows = await checkoutDayRows();
        if (order === "roster") {
          // Save wins. The row is still valid when it commits, so the operator's
          // own edit legitimately returns it to SUGGESTED. The date change then
          // finds a SUGGESTED row outside the new stay and removes it silently —
          // which is correct, because it is no longer a confirmed commitment.
          expect((saveOutcome.value.init?.status ?? 200)).toBe(200);
          expect(rows).toEqual([]);
          expect(dateChange.value).toEqual([]);
        } else {
          // The date change wins while the row is still CONFIRMED. It must NOT
          // delete it: it leaves the row alone and reports it twice — once from
          // the envelope pass, once from the per-guest stay-range pass — so the
          // operator is told. The Save that follows is then rejected, because
          // the person it names is no longer in the lodge on the 4th.
          expect(dateChange.value).toEqual([
            `Strip beds on ${CHECKOUT_DAY_STRING} is CONFIRMED and was not auto-removed`,
            `Strip beds on ${CHECKOUT_DAY_STRING} is CONFIRMED and falls outside the guest's stay range`,
          ]);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            choreTemplateId: MORNING_TEMPLATE_ID,
            bookingGuestId: GUEST_ID,
            status: "CONFIRMED",
          });
          expect(saveOutcome.value.init?.status).toBe(400);
          expect(saveOutcome.value.body).toMatchObject({
            code: "ROSTER_GUEST_INELIGIBLE",
          });
        }
      });
    }

    it("holds both check-out dates in one sorted roster-date set", async () => {
      // Direct evidence for the lock-set widening: with the OLD check-out day
      // locked, a second transaction cannot take that key until the first
      // commits, even though the new envelope no longer contains it.
      await rosterRegenerate();
      const held = deferred();
      const release = deferred();
      const holder = prisma
        .$transaction(
          async (tx) => {
            await lockRosterDateRangesAndDates(
              tx,
              [rosterOperationalDayRange(CHECK_IN, CHECK_OUT)],
              [],
            );
            held.resolve();
            await release.promise;
          },
          { maxWait: 5_000, timeout: 15_000 },
        )
        .catch(() => held.resolve());
      await held.promise;

      const contended = observerClient.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`roster:${CHECKOUT_DAY_STRING}`})) AS "locked"
      `;
      const [row] = await contended;
      release.resolve();
      await holder;
      expect(row.locked).toBe(false);
    });
  },
);
