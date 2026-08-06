import { Prisma, type PrismaClient } from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import type { HostingCoverageReevaluationInput } from "@/lib/adult-member-hosting-coverage-queue";

type ParticipantDb = Pick<PrismaClient, "booking" | "member" | "$executeRaw">;

export const HOSTING_COVERAGE_RETRY_CODE =
  "HOSTING_COVERAGE_PARTICIPANT_RETRY";
export const HOSTING_COVERAGE_RETRY_MESSAGE =
  "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.";

export type HostingCoverageSourceParticipant = Readonly<{
  bookingId: string;
  ownerMemberId: string;
  lodgeId: string;
}>;

const issuedProofs = new WeakSet<object>();

/** A runtime-issued capability; a structural cast is rejected by the WeakSet. */
export type HostingCoverageQueueParticipantProof = Readonly<{
  lockedMemberIds: readonly string[];
  sources: readonly HostingCoverageSourceParticipant[];
}>;

export class HostingCoverageParticipantRetryError extends ApiError {
  readonly statusCode = 409;
  readonly code = HOSTING_COVERAGE_RETRY_CODE;

  constructor() {
    super(HOSTING_COVERAGE_RETRY_MESSAGE, 409);
    this.name = "HostingCoverageParticipantRetryError";
  }
}

function sortedUnique(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))].sort();
}

function sortedSources(
  sources: readonly HostingCoverageSourceParticipant[],
): HostingCoverageSourceParticipant[] {
  const unique = new Map<string, HostingCoverageSourceParticipant>();
  for (const source of sources) {
    unique.set(
      `${source.bookingId}:${source.ownerMemberId}:${source.lodgeId}`,
      source,
    );
  }
  return [...unique.values()].sort((a, b) =>
    a.bookingId.localeCompare(b.bookingId),
  );
}

function sourceFingerprint(
  sources: readonly HostingCoverageSourceParticipant[],
): string {
  return sortedSources(sources)
    .map(
      (source) =>
        `${source.bookingId}:${source.ownerMemberId}:${source.lodgeId}`,
    )
    .join("\n");
}

function issueProof(
  lockedMemberIds: readonly string[],
  sources: readonly HostingCoverageSourceParticipant[],
): HostingCoverageQueueParticipantProof {
  const proof = Object.freeze({
    lockedMemberIds: Object.freeze([...lockedMemberIds]),
    sources: Object.freeze(
      sortedSources(sources).map((source) => Object.freeze({ ...source })),
    ),
  });
  issuedProofs.add(proof);
  return proof;
}

/** Exact SQLSTATE inspection for direct pg and nested Prisma adapter errors. */
export function isPostgresLockNotAvailable(
  error: unknown,
  depth = 0,
): boolean {
  if (depth > 5 || !error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  if (candidate.code === "55P03" || candidate.originalCode === "55P03") {
    return true;
  }
  return ["meta", "driverAdapterError", "cause"].some((key) =>
    isPostgresLockNotAvailable(candidate[key], depth + 1),
  );
}

/**
 * Acquire one exact, sorted Member participant set without waiting. Source
 * booking owner and lodge are re-read only after those rows are protected.
 */
export async function acquireHostingCoverageQueueParticipantProof(
  params: {
    sources: readonly HostingCoverageSourceParticipant[];
    actorMemberId?: string | null;
  },
  db: ParticipantDb,
): Promise<HostingCoverageQueueParticipantProof> {
  const memberIds = sortedUnique([
    ...params.sources.map((source) => source.ownerMemberId),
    params.actorMemberId,
  ]);
  // Hosting service unit tests use deliberately narrow in-memory delegates.
  // A real Prisma client exposes both raw methods; requiring that production
  // shape keeps those existing test doubles narrow without weakening the
  // runtime-issued proof at the queue boundary.
  if (
    typeof (db as { $executeRaw?: unknown }).$executeRaw !== "function" ||
    typeof (db as { $queryRaw?: unknown }).$queryRaw !== "function"
  ) {
    return issueProof(memberIds, params.sources);
  }
  try {
    await db.$executeRaw(Prisma.sql`
      SELECT 1
      FROM "Member"
      WHERE "id" IN (${Prisma.join(memberIds)})
      ORDER BY "id"
      FOR KEY SHARE NOWAIT
    `);
  } catch (error) {
    if (
      error instanceof HostingCoverageParticipantRetryError ||
      isPostgresLockNotAvailable(error)
    ) {
      throw new HostingCoverageParticipantRetryError();
    }
    throw error;
  }

  const members = await db.member.findMany({
    where: { id: { in: memberIds } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (
    members.length !== memberIds.length ||
    members.some((member, index) => member.id !== memberIds[index])
  ) {
    throw new HostingCoverageParticipantRetryError();
  }

  const bookingIds = sortedUnique(
    params.sources.map((source) => source.bookingId),
  );
  const bookings = await db.booking.findMany({
    where: { id: { in: bookingIds } },
    orderBy: { id: "asc" },
    select: { id: true, memberId: true, lodgeId: true },
  });
  const refreshed = bookings.map((booking) => ({
    bookingId: booking.id,
    ownerMemberId: booking.memberId,
    lodgeId: booking.lodgeId,
  }));
  if (sourceFingerprint(refreshed) !== sourceFingerprint(params.sources)) {
    throw new HostingCoverageParticipantRetryError();
  }
  return issueProof(memberIds, refreshed);
}

/** Validate before both coverage-owner acquisition and the final queue write. */
export function assertHostingCoverageQueueParticipantsLocked(
  proof: HostingCoverageQueueParticipantProof,
  input: Pick<
    HostingCoverageReevaluationInput,
    "memberId" | "lodgeId" | "sourceBookingId" | "actorMemberId"
  >,
): void {
  if (!issuedProofs.has(proof as object)) {
    throw new HostingCoverageParticipantRetryError();
  }
  const source = proof.sources.find(
    (candidate) => candidate.bookingId === input.sourceBookingId,
  );
  const locked = new Set(proof.lockedMemberIds);
  if (
    !input.sourceBookingId ||
    !source ||
    source.ownerMemberId !== input.memberId ||
    source.lodgeId !== input.lodgeId ||
    !locked.has(input.memberId) ||
    (input.actorMemberId && !locked.has(input.actorMemberId))
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
}

/** One blocking, sorted master/loser/ancillary-owner row-lock statement. */
export async function lockMemberMergeHostingCoverageParticipants(
  db: Pick<PrismaClient, "$executeRaw" | "member">,
  params: {
    masterId: string;
    loserId: string;
    ownerMemberIds: readonly string[];
  },
): Promise<readonly string[]> {
  const ids = sortedUnique([
    params.masterId,
    params.loserId,
    ...params.ownerMemberIds,
  ]);
  await db.$executeRaw(Prisma.sql`
    SELECT 1
    FROM "Member"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `);
  const locked = await db.member.findMany({
    where: { id: { in: ids } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (
    locked.length !== ids.length ||
    locked.some((member, index) => member.id !== ids[index])
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
  return Object.freeze(ids);
}

/** Issue the merge bypass only after an exact under-lock plan comparison. */
export function proveMemberMergeHostingCoverageParticipants(params: {
  lockedMemberIds: readonly string[];
  plannedSources: readonly HostingCoverageSourceParticipant[];
  refreshedSources: readonly HostingCoverageSourceParticipant[];
}): HostingCoverageQueueParticipantProof {
  if (
    sourceFingerprint(params.plannedSources) !==
    sourceFingerprint(params.refreshedSources)
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
  const locked = new Set(params.lockedMemberIds);
  if (
    params.refreshedSources.some(
      (source) => !locked.has(source.ownerMemberId),
    )
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
  return issueProof(params.lockedMemberIds, params.refreshedSources);
}
