/**
 * Opt-in real-PostgreSQL concurrency proof for issue #2597.
 *
 * The ordinary queue seams take exact owner/actor Member rows FOR KEY SHARE
 * NOWAIT; member merge takes the complete sorted owner union FOR UPDATE. These
 * tests force both winner orders against the production functions, prove that
 * a later bulk seam aborts its complete outer transaction, exercise under-lock
 * fan-out drift, and check the policy/config/merge lock order in both directions.
 *
 * Two full `executeMemberMerge` races use a test-only Prisma transaction proxy.
 * It delegates every statement to PostgreSQL and pauses only immediately before
 * or after the production Member `FOR UPDATE` statement. No production hook or
 * reimplementation of the merge algorithm is involved.
 *
 * Ordinary test runs remain database-free. The suite runs only when
 * `RUN_CONCURRENCY_RACE_TESTS=1`, reads only the guarded race URL, and is also
 * registered by `concurrency-lock-races.realdb.test.ts` for the migration-drift
 * job's dedicated PostgreSQL service.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LOCK_POLL_TIMEOUT_MS = 5_000;

const IDS = {
  lodge: "race-2597-lodge",
  policy: "race-2597-policy",
  master: "race-2597-master",
  loser: "race-2597-loser",
  actor: "race-2597-actor",
  ownerA: "race-2597-owner-a",
  ownerB: "race-2597-owner-b",
  target: "race-2597-target",
  ancillaryA: "race-2597-ancillary-a",
  ancillaryB: "race-2597-ancillary-b",
  mergeBooking: "race-2597-booking-merge",
  bookingA: "race-2597-booking-a",
  bookingB: "race-2597-booking-b",
  fanoutBookingA: "race-2597-booking-fanout-a",
  fanoutBookingB: "race-2597-booking-fanout-b",
  fanoutGuestA: "race-2597-guest-fanout-a",
  fanoutGuestB: "race-2597-guest-fanout-b",
} as const;

const MEMBER_IDS = [
  IDS.master,
  IDS.loser,
  IDS.actor,
  IDS.ownerA,
  IDS.ownerB,
  IDS.target,
  IDS.ancillaryA,
  IDS.ancillaryB,
];
const BOOKING_IDS = [
  IDS.mergeBooking,
  IDS.bookingA,
  IDS.bookingB,
  IDS.fanoutBookingA,
  IDS.fanoutBookingB,
];
const MARKER_ACTION = "RACE_2597_OUTER_TRANSACTION_MARKER";

export function assertSafeHostingQueueRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Hosting queue race tests need a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing hosting queue race DB port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      parsed.hostname.toLowerCase(),
    )
  ) {
    throw new Error("Hosting queue race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Hosting queue race DB name must contain 'concurrency_race_1881'.",
    );
  }
}

type Deferred = ReturnType<typeof deferred>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function rawStatement(input: unknown): string {
  if (Array.isArray(input)) return input.join("?");
  const strings = (input as { strings?: readonly string[] })?.strings;
  return strings ? strings.join("?") : String(input);
}

type ParticipantPause = {
  position: "before" | "after";
  reached: Deferred;
  release: Deferred;
};

/** Wrap only `$transaction`; every model call still uses the real client. */
function createParticipantPauseClient(
  client: PrismaClient,
  pause: ParticipantPause,
): PrismaClient {
  let consumed = false;
  return new Proxy(client, {
    get(target, property) {
      if (property === "$transaction") {
        return <T>(
          callback: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: {
            maxWait?: number;
            timeout?: number;
            isolationLevel?: Prisma.TransactionIsolationLevel;
          },
        ) =>
          target.$transaction(async (tx) => {
            const txProxy = new Proxy(tx, {
              get(txTarget, txProperty) {
                if (txProperty === "$executeRaw") {
                  return async (query: unknown, ...values: unknown[]) => {
                    const statement = rawStatement(query);
                    const isParticipantLock =
                      !consumed &&
                      statement.includes('FROM "Member"') &&
                      statement.includes("FOR UPDATE");
                    if (isParticipantLock && pause.position === "before") {
                      consumed = true;
                      pause.reached.resolve();
                      await pause.release.promise;
                    }
                    const result = (await Reflect.apply(
                      txTarget.$executeRaw,
                      txTarget,
                      [query, ...values],
                    )) as number;
                    if (isParticipantLock && pause.position === "after") {
                      consumed = true;
                      pause.reached.resolve();
                      await pause.release.promise;
                    }
                    return result;
                  };
                }
                const value = Reflect.get(txTarget, txProperty);
                return typeof value === "function"
                  ? value.bind(txTarget)
                  : value;
              },
            });
            return callback(txProxy);
          }, options);
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createAfterParticipantLockTx(
  tx: Prisma.TransactionClient,
  hook: () => Promise<void>,
): Prisma.TransactionClient {
  let ran = false;
  return new Proxy(tx, {
    get(target, property) {
      if (property === "$executeRaw") {
        return async (query: unknown, ...values: unknown[]) => {
          const statement = rawStatement(query);
          const result = (await Reflect.apply(target.$executeRaw, target, [
            query,
            ...values,
          ])) as number;
          if (!ran && statement.includes("FOR KEY SHARE NOWAIT")) {
            ran = true;
            await hook();
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function waitForPauseOrFail<T>(
  pause: ParticipantPause,
  operation: Promise<T>,
): Promise<void> {
  const outcome = await Promise.race([
    pause.reached.promise.then(() => ({ kind: "paused" as const })),
    operation.then(
      () => ({ kind: "completed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    ),
  ]);
  if (outcome.kind === "completed") {
    throw new Error(
      "Member merge completed before reaching its participant lock.",
    );
  }
  if (outcome.kind === "failed") throw outcome.error;
}

describe("hosting queue/member merge race DB safety guard (#2597)", () => {
  it("accepts only the dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeHostingQueueRaceDbUrl(
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
    expect(() => assertSafeHostingQueueRaceDbUrl(url)).toThrow();
  });
});

let primary: PrismaClient;
let ordinary: PrismaClient;
let mergeA: PrismaClient;
let mergeB: PrismaClient;
let observer: PrismaClient;

let acquireHostingCoverageQueueParticipantProof: (typeof import("@/lib/adult-member-hosting-queue-participants"))["acquireHostingCoverageQueueParticipantProof"];
let lockMemberMergeHostingCoverageParticipants: (typeof import("@/lib/adult-member-hosting-queue-participants"))["lockMemberMergeHostingCoverageParticipants"];
let HostingCoverageParticipantRetryError: (typeof import("@/lib/adult-member-hosting-queue-participants"))["HostingCoverageParticipantRetryError"];
let HOSTING_COVERAGE_RETRY_CODE: (typeof import("@/lib/adult-member-hosting-queue-participants"))["HOSTING_COVERAGE_RETRY_CODE"];
let HOSTING_COVERAGE_RETRY_MESSAGE: (typeof import("@/lib/adult-member-hosting-queue-participants"))["HOSTING_COVERAGE_RETRY_MESSAGE"];
let enqueueOwnHostingCoverageReevaluation: (typeof import("@/lib/adult-member-hosting-review"))["enqueueOwnHostingCoverageReevaluation"];
let enqueueHostingCoverageReevaluationForMember: (typeof import("@/lib/adult-member-hosting-review"))["enqueueHostingCoverageReevaluationForMember"];
let buildMemberMergePreview: (typeof import("@/lib/member-merge"))["buildMemberMergePreview"];
let executeMemberMerge: (typeof import("@/lib/member-merge"))["executeMemberMerge"];
let acquireConfigImportLock: (typeof import("@/lib/config-transfer-lock"))["acquireConfigImportLock"];
let lockMinimumStayPolicySet: (typeof import("@/lib/minimum-stay-policy-set"))["lockMinimumStayPolicySet"];
let lockAdultMemberHostingPolicySet: (typeof import("@/lib/adult-member-hosting-policy-set"))["lockAdultMemberHostingPolicySet"];

(RUN ? describe : describe.skip)(
  "hosting queue/member merge interleavings — real PostgreSQL (#2597)",
  { timeout: 120_000 },
  () => {
    async function clearFixtures(): Promise<void> {
      await primary.hostingCoverageIncident.deleteMany({
        where: { bookingId: { in: BOOKING_IDS } },
      });
      await primary.hostingCoverageReevaluation.deleteMany({
        where: {
          OR: [
            { memberId: { in: MEMBER_IDS } },
            { actorMemberId: { in: MEMBER_IDS } },
            { sourceBookingId: { in: BOOKING_IDS } },
          ],
        },
      });
      await primary.auditLog.deleteMany({
        where: {
          OR: [
            { action: MARKER_ACTION },
            { entityId: { in: MEMBER_IDS } },
            { subjectMemberId: { in: MEMBER_IDS } },
          ],
        },
      });
      await primary.bookingGuest.deleteMany({
        where: { bookingId: { in: BOOKING_IDS } },
      });
      await primary.booking.deleteMany({ where: { id: { in: BOOKING_IDS } } });
      await primary.adultMemberHostingPolicy.deleteMany({
        where: { id: IDS.policy },
      });
      await primary.lodge.deleteMany({ where: { id: IDS.lodge } });
      await primary.memberAccessRole.deleteMany({
        where: { memberId: { in: MEMBER_IDS } },
      });
      await primary.member.deleteMany({ where: { id: { in: MEMBER_IDS } } });
    }

    async function seedFixtures(): Promise<void> {
      await primary.member.createMany({
        data: MEMBER_IDS.map((id) => ({
          id,
          email: `${id}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: id === IDS.loser ? "Duplicate" : id.split("-").at(-1)!,
          lastName: "Race",
          role: id === IDS.actor ? ("ADMIN" as const) : ("USER" as const),
          ageTier: "ADULT" as const,
          active: true,
          canLogin: false,
        })),
      });
      await primary.memberAccessRole.create({
        data: { memberId: IDS.actor, role: "ADMIN" },
      });
      await primary.lodge.create({
        data: {
          id: IDS.lodge,
          name: "Race 2597 Lodge",
          slug: "race-2597-lodge",
        },
      });
      await primary.adultMemberHostingPolicy.create({
        data: {
          id: IDS.policy,
          lodgeId: IDS.lodge,
          scopeKey: IDS.lodge,
          mode: "ENFORCED",
          capacityMode: "NO_HOLD",
          hostScopeSameBooking: true,
          hostScopeSameBookingOwner: false,
        },
      });
      const stay = {
        checkIn: new Date("2099-04-01"),
        checkOut: new Date("2099-04-03"),
        status: "CONFIRMED" as const,
        lodgeId: IDS.lodge,
        totalPriceCents: 100,
        finalPriceCents: 100,
      };
      await primary.booking.createMany({
        data: [
          { id: IDS.mergeBooking, memberId: IDS.loser, ...stay },
          { id: IDS.bookingA, memberId: IDS.ownerA, ...stay },
          { id: IDS.bookingB, memberId: IDS.ownerB, ...stay },
          { id: IDS.fanoutBookingA, memberId: IDS.ownerA, ...stay },
          { id: IDS.fanoutBookingB, memberId: IDS.ownerB, ...stay },
        ],
      });
    }

    async function waitForClientToBlock(
      applicationName: string,
    ): Promise<void> {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observer.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count"
          FROM pg_stat_activity
          WHERE application_name = ${applicationName}
            AND wait_event_type = 'Lock'
            AND state = 'active'
        `;
        if ((rows[0]?.count ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `Timed out waiting for PostgreSQL client ${applicationName} to block on a lock.`,
      );
    }

    async function previewMerge() {
      const preview = await buildMemberMergePreview({
        masterId: IDS.master,
        loserId: IDS.loser,
        actorMemberId: IDS.actor,
        db: primary,
      });
      expect(preview.blockers).toEqual([]);
      return preview;
    }

    async function startPausedMerge(position: "before" | "after") {
      const preview = await previewMerge();
      const pause: ParticipantPause = {
        position,
        reached: deferred(),
        release: deferred(),
      };
      const db = createParticipantPauseClient(mergeA, pause);
      const operation = executeMemberMerge({
        masterId: IDS.master,
        loserId: IDS.loser,
        actorMemberId: IDS.actor,
        previewToken: preview.previewToken,
        confirmationText: preview.confirmationPhrase,
        db: db as never,
      });
      await waitForPauseOrFail(pause, operation);
      return { operation, pause };
    }

    beforeAll(async () => {
      assertSafeHostingQueueRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;

      const [
        participants,
        review,
        merge,
        configLock,
        minimumLock,
        hostingLock,
      ] = await Promise.all([
        import("@/lib/adult-member-hosting-queue-participants"),
        import("@/lib/adult-member-hosting-review"),
        import("@/lib/member-merge"),
        import("@/lib/config-transfer-lock"),
        import("@/lib/minimum-stay-policy-set"),
        import("@/lib/adult-member-hosting-policy-set"),
      ]);
      acquireHostingCoverageQueueParticipantProof =
        participants.acquireHostingCoverageQueueParticipantProof;
      lockMemberMergeHostingCoverageParticipants =
        participants.lockMemberMergeHostingCoverageParticipants;
      HostingCoverageParticipantRetryError =
        participants.HostingCoverageParticipantRetryError;
      HOSTING_COVERAGE_RETRY_CODE = participants.HOSTING_COVERAGE_RETRY_CODE;
      HOSTING_COVERAGE_RETRY_MESSAGE =
        participants.HOSTING_COVERAGE_RETRY_MESSAGE;
      enqueueOwnHostingCoverageReevaluation =
        review.enqueueOwnHostingCoverageReevaluation;
      enqueueHostingCoverageReevaluationForMember =
        review.enqueueHostingCoverageReevaluationForMember;
      buildMemberMergePreview = merge.buildMemberMergePreview;
      executeMemberMerge = merge.executeMemberMerge;
      acquireConfigImportLock = configLock.acquireConfigImportLock;
      lockMinimumStayPolicySet = minimumLock.lockMinimumStayPolicySet;
      lockAdultMemberHostingPolicySet =
        hostingLock.lockAdultMemberHostingPolicySet;

      const [
        { PrismaClient: SeparatePrismaClient },
        { createPrismaPgAdapter },
      ] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const createClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({
          adapter: createPrismaPgAdapter(url.toString()),
        });
      };
      primary = createClient("race-2597-primary");
      ordinary = createClient("race-2597-ordinary");
      mergeA = createClient("race-2597-merge-a");
      mergeB = createClient("race-2597-merge-b");
      observer = createClient("race-2597-observer");
      await Promise.all(
        [primary, ordinary, mergeA, mergeB, observer].map((client) =>
          client.$connect(),
        ),
      );
      await clearFixtures();
    }, 60_000);

    beforeEach(async () => {
      await clearFixtures();
      await seedFixtures();
    }, 60_000);

    afterAll(async () => {
      if (primary) await clearFixtures().catch(() => {});
      await Promise.all(
        [primary, ordinary, mergeA, mergeB, observer].map((client) =>
          client ? client.$disconnect().catch(() => {}) : Promise.resolve(),
        ),
      );
    }, 60_000);

    it("ordinary wins between merge moves and participant locks, then the real merge late-sweeps owner plus actor and folds both counts into its result and audit", async () => {
      const { operation, pause } = await startPausedMerge("before");
      let ordinaryError: unknown;
      try {
        await ordinary.$transaction((tx) =>
          enqueueOwnHostingCoverageReevaluation(IDS.mergeBooking, tx, {
            cause: "OFFICER_OVERRIDE",
            actorMemberId: IDS.loser,
            reason: "Race 2597 retained officer reason",
          }),
        );
      } catch (error) {
        ordinaryError = error;
      } finally {
        pause.release.resolve();
      }
      const result = await operation;
      if (ordinaryError) throw ordinaryError;

      expect(result.relationMoves).toContainEqual({
        model: "HostingCoverageReevaluation.member",
        count: 1,
      });
      expect(result.relationMoves).toContainEqual({
        model: "HostingCoverageReevaluation.actorMemberId",
        count: 1,
      });

      const retained =
        await primary.hostingCoverageReevaluation.findFirstOrThrow({
          where: {
            sourceBookingId: IDS.mergeBooking,
            cause: "OFFICER_OVERRIDE",
          },
        });
      expect(retained).toMatchObject({
        memberId: IDS.master,
        actorMemberId: IDS.master,
        reason: "Race 2597 retained officer reason",
      });

      const audit = await primary.auditLog.findFirstOrThrow({
        where: { action: "MEMBER_MERGED", entityId: IDS.master },
        orderBy: { createdAt: "desc" },
      });
      const metadata = audit.metadata as {
        relationMoves?: Array<{ model: string; count: number }>;
      };
      expect(metadata.relationMoves).toEqual(result.relationMoves);
      await expect(
        primary.member.findUnique({ where: { id: IDS.loser } }),
      ).resolves.toBeNull();
    });

    it("merge wins the Member rows, so an ordinary owner+actor enqueue gets the fixed retry and its complete outer transaction rolls back", async () => {
      const { operation, pause } = await startPausedMerge("after");
      let ordinaryError: unknown;
      try {
        await ordinary.$transaction(async (tx) => {
          await tx.auditLog.create({
            data: { action: MARKER_ACTION, entityId: IDS.mergeBooking },
          });
          await enqueueOwnHostingCoverageReevaluation(IDS.mergeBooking, tx, {
            cause: "OFFICER_OVERRIDE",
            actorMemberId: IDS.loser,
            reason: "must roll back",
          });
        });
      } catch (error) {
        ordinaryError = error;
      } finally {
        pause.release.resolve();
      }

      expect(ordinaryError).toBeInstanceOf(
        HostingCoverageParticipantRetryError,
      );
      expect(ordinaryError).toMatchObject({
        code: HOSTING_COVERAGE_RETRY_CODE,
        statusCode: 409,
        message: HOSTING_COVERAGE_RETRY_MESSAGE,
      });
      expect(
        await primary.auditLog.count({ where: { action: MARKER_ACTION } }),
      ).toBe(0);
      expect(
        await primary.hostingCoverageReevaluation.count({
          where: {
            sourceBookingId: IDS.mergeBooking,
            cause: "OFFICER_OVERRIDE",
          },
        }),
      ).toBe(0);
      await expect(operation).resolves.toMatchObject({
        masterId: IDS.master,
        loserId: IDS.loser,
      });
    });

    it("fails fast on a later bulk seam and rolls back the earlier queue row plus the caller marker", async () => {
      const held = deferred();
      const release = deferred();
      const holder = mergeA.$transaction(
        async (tx) => {
          await lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.ownerB,
            loserId: IDS.ancillaryA,
            ownerMemberIds: [],
          });
          held.resolve();
          await release.promise;
        },
        { timeout: 30_000 },
      );
      await held.promise;

      let bulkError: unknown;
      try {
        await ordinary.$transaction(async (tx) => {
          await tx.auditLog.create({
            data: { action: MARKER_ACTION, entityId: IDS.bookingA },
          });
          await enqueueOwnHostingCoverageReevaluation(IDS.bookingA, tx);
          await enqueueOwnHostingCoverageReevaluation(IDS.bookingB, tx);
        });
      } catch (error) {
        bulkError = error;
      } finally {
        release.resolve();
      }
      await holder;

      expect(bulkError).toMatchObject({
        code: HOSTING_COVERAGE_RETRY_CODE,
        statusCode: 409,
      });
      expect(
        await primary.hostingCoverageReevaluation.count({
          where: { sourceBookingId: { in: [IDS.bookingA, IDS.bookingB] } },
        }),
      ).toBe(0);
      expect(
        await primary.auditLog.count({ where: { action: MARKER_ACTION } }),
      ).toBe(0);
    });

    it("rejects missing actor and source-owner drift with the stable retry contract and no marker write", async () => {
      const source = {
        bookingId: IDS.bookingB,
        ownerMemberId: IDS.ownerA,
        lodgeId: IDS.lodge,
      };

      for (const attempt of [
        () =>
          ordinary.$transaction(async (tx) => {
            await tx.auditLog.create({
              data: { action: MARKER_ACTION, entityId: "source-drift" },
            });
            await acquireHostingCoverageQueueParticipantProof(
              { sources: [source] },
              tx,
            );
          }),
        () =>
          ordinary.$transaction(async (tx) => {
            await tx.auditLog.create({
              data: { action: MARKER_ACTION, entityId: "missing-actor" },
            });
            await acquireHostingCoverageQueueParticipantProof(
              {
                sources: [
                  {
                    bookingId: IDS.bookingA,
                    ownerMemberId: IDS.ownerA,
                    lodgeId: IDS.lodge,
                  },
                ],
                actorMemberId: "race-2597-missing-actor",
              },
              tx,
            );
          }),
      ]) {
        await expect(attempt()).rejects.toMatchObject({
          code: HOSTING_COVERAGE_RETRY_CODE,
          statusCode: 409,
          message: HOSTING_COVERAGE_RETRY_MESSAGE,
        });
      }
      expect(
        await primary.auditLog.count({ where: { action: MARKER_ACTION } }),
      ).toBe(0);
    });

    it("includes a guest present before locking and rejects a guest that appears after the participant lock, rolling back all queue work", async () => {
      const guest = (id: string, bookingId: string) => ({
        id,
        bookingId,
        memberId: IDS.target,
        firstName: "Target",
        lastName: "Race",
        ageTier: "ADULT" as const,
        isMember: true,
        stayStart: new Date("2099-04-01"),
        stayEnd: new Date("2099-04-03"),
        priceCents: 100,
      });
      await primary.bookingGuest.createMany({
        data: [
          guest(IDS.fanoutGuestA, IDS.fanoutBookingA),
          guest(IDS.fanoutGuestB, IDS.fanoutBookingB),
        ],
      });
      await expect(
        ordinary.$transaction((tx) =>
          enqueueHostingCoverageReevaluationForMember(IDS.target, tx),
        ),
      ).resolves.toBe(2);
      expect(
        await primary.hostingCoverageReevaluation.count({
          where: {
            sourceBookingId: {
              in: [IDS.fanoutBookingA, IDS.fanoutBookingB],
            },
          },
        }),
      ).toBe(2);

      await primary.hostingCoverageReevaluation.deleteMany({
        where: {
          sourceBookingId: { in: [IDS.fanoutBookingA, IDS.fanoutBookingB] },
        },
      });
      await primary.bookingGuest.delete({ where: { id: IDS.fanoutGuestB } });

      await expect(
        ordinary.$transaction(async (tx) => {
          await tx.auditLog.create({
            data: { action: MARKER_ACTION, entityId: "late-guest" },
          });
          const hookedTx = createAfterParticipantLockTx(tx, () =>
            mergeB.bookingGuest
              .create({
                data: guest(IDS.fanoutGuestB, IDS.fanoutBookingB),
              })
              .then(() => {}),
          );
          await enqueueHostingCoverageReevaluationForMember(
            IDS.target,
            hookedTx,
          );
        }),
      ).rejects.toMatchObject({
        code: HOSTING_COVERAGE_RETRY_CODE,
        statusCode: 409,
      });
      expect(
        await primary.hostingCoverageReevaluation.count({
          where: {
            sourceBookingId: {
              in: [IDS.fanoutBookingA, IDS.fanoutBookingB],
            },
          },
        }),
      ).toBe(0);
      expect(
        await primary.auditLog.count({ where: { action: MARKER_ACTION } }),
      ).toBe(0);
      await expect(
        primary.bookingGuest.findUnique({ where: { id: IDS.fanoutGuestB } }),
      ).resolves.not.toBeNull();
    });

    it("sorts overlapping ancillary owner sets so two opposing merge lock plans serialize without deadlock", async () => {
      const firstHeld = deferred();
      const releaseFirst = deferred();
      const first = mergeA.$transaction(
        async (tx) => {
          await lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.master,
            loserId: IDS.loser,
            ownerMemberIds: [IDS.ancillaryB, IDS.ancillaryA],
          });
          firstHeld.resolve();
          await releaseFirst.promise;
        },
        { timeout: 30_000 },
      );
      await firstHeld.promise;

      const second = mergeB.$transaction(
        (tx) =>
          lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.ancillaryB,
            loserId: IDS.ancillaryA,
            ownerMemberIds: [IDS.loser, IDS.master],
          }),
        { timeout: 30_000 },
      );
      try {
        await waitForClientToBlock("race-2597-merge-b");
      } finally {
        releaseFirst.resolve();
      }

      await expect(Promise.all([first, second])).resolves.toBeDefined();
    });

    it("keeps config-transfer and merge in the one-way policy-set order in both winner orders", async () => {
      const configHeld = deferred();
      const releaseConfig = deferred();
      const configFirst = mergeA.$transaction(
        async (tx) => {
          await acquireConfigImportLock(tx);
          await lockMinimumStayPolicySet(tx);
          await lockAdultMemberHostingPolicySet(tx);
          configHeld.resolve();
          await releaseConfig.promise;
        },
        { timeout: 30_000 },
      );
      await configHeld.promise;

      const mergeSecond = mergeB.$transaction(
        async (tx) => {
          await lockAdultMemberHostingPolicySet(tx);
          await lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.master,
            loserId: IDS.loser,
            ownerMemberIds: [IDS.ownerA],
          });
        },
        { timeout: 30_000 },
      );
      try {
        await waitForClientToBlock("race-2597-merge-b");
        // Waiting on the policy key must happen before merge takes Member rows.
        await expect(
          primary.$transaction(
            (tx) =>
              tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${IDS.master} FOR UPDATE NOWAIT`,
          ),
        ).resolves.toBe(1);
      } finally {
        releaseConfig.resolve();
      }
      await Promise.all([configFirst, mergeSecond]);

      const mergeHeld = deferred();
      const releaseMerge = deferred();
      const mergeFirst = mergeA.$transaction(
        async (tx) => {
          await lockAdultMemberHostingPolicySet(tx);
          await lockMemberMergeHostingCoverageParticipants(tx, {
            masterId: IDS.master,
            loserId: IDS.loser,
            ownerMemberIds: [IDS.ownerA],
          });
          mergeHeld.resolve();
          await releaseMerge.promise;
        },
        { timeout: 30_000 },
      );
      await mergeHeld.promise;
      const configSecond = mergeB.$transaction(
        async (tx) => {
          await acquireConfigImportLock(tx);
          await lockMinimumStayPolicySet(tx);
          await lockAdultMemberHostingPolicySet(tx);
        },
        { timeout: 30_000 },
      );
      try {
        await waitForClientToBlock("race-2597-merge-b");
      } finally {
        releaseMerge.resolve();
      }
      await expect(
        Promise.all([mergeFirst, configSecond]),
      ).resolves.toBeDefined();
    });
  },
);
