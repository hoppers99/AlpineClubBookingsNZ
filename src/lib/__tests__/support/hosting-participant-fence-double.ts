import { vi } from "vitest";

/**
 * Test doubles for the hosting participant fence (#2597, hardened in #2619).
 *
 * `acquireHostingCoverageQueueParticipantProof` locks the exact sorted Member
 * rows `FOR KEY SHARE NOWAIT`, then does two reads UNDER that lock:
 *
 *   1. a typed `member.findMany` re-read, requiring every locked id to still
 *      exist, in sorted order;
 *   2. a `booking.findMany` re-read of each source booking's owner and lodge,
 *      requiring the `sourceFingerprint` to match what the caller planned.
 *
 * A double that models neither read makes the fence report contention — or
 * crash outright when the delegate is missing — so before #2619 these suites
 * exercised their seams with the fence effectively switched off. Modelling both
 * reads is what makes the drift check mean anything: it must PASS for unchanged
 * data and FAIL for drifted data, and a double that always returns nothing can
 * do neither.
 *
 * These helpers deliberately answer only the fence's own query shapes and
 * delegate everything else, so adding them to an existing double cannot change
 * what the rest of a suite already asserts.
 */

/**
 * A source booking as the fence re-reads it.
 *
 * `lodgeId` is `string`, not `string | null`, deliberately: `Booking.lodgeId` is
 * NOT NULL in the schema, so a real row always carries one. Allowing it to be
 * absent here would let a fixture compare `"bk1:m1:undefined"` against itself
 * and pass the drift check vacuously — and would hide a real failure, because
 * if a planner's select ever dropped `lodgeId` production would compare an
 * undefined plan against a re-read that has one and refuse every booking write.
 */
export interface FenceBookingRow {
  id: string;
  memberId: string;
  lodgeId: string;
}

/**
 * `member.findMany` for the fence's existence/order re-read: echo the requested
 * ids back, sorted, so every locked participant is present and in order.
 *
 * Pass `missing` to model a participant that vanished under the lock — the
 * fence must then refuse rather than proceed.
 */
export function fenceMemberFindMany(
  missing: readonly string[] = [],
  /**
   * Handles every OTHER member.findMany a suite makes. Pass a double's
   * existing implementation when the delegate is shared, so dropping this in
   * cannot change what the rest of the suite already asserts.
   */
  existing?: (args: unknown) => unknown,
) {
  return vi.fn(async (args?: {
    where?: { id?: { in?: readonly string[] } };
    select?: Record<string, unknown>;
    orderBy?: unknown;
  }) => {
    // The fence's re-read asks for ids only, keyed on id alone, in id order.
    //
    // The `where` must have EXACTLY the one `id` key. Matching on
    // `where.id.in` plus an ids-only select is not specific enough: other
    // production guards issue the same select with extra predicates — notably
    // `assertLinkedMembersExist` (booking-request-quotes.ts), which asks for
    // `{ id: { in }, active: true, archivedAt: null }`. Answering that here
    // would report every requested member as found, active and unarchived,
    // making its "linked member not found" refusal unfailable in any suite
    // using this helper. Same hazard for the merge participant lock's own
    // re-read and family-suggestions.
    const where = args?.where as Record<string, unknown> | undefined;
    const select = args?.select;
    const isFenceRead =
      Array.isArray(args?.where?.id?.in) &&
      !!where &&
      Object.keys(where).length === 1 &&
      !!select &&
      Object.keys(select).length === 1 &&
      select.id === true;
    if (!isFenceRead) {
      return existing ? await existing(args) : [];
    }
    return [...(args?.where?.id?.in ?? [])]
      .filter((id) => !missing.includes(id))
      .sort()
      .map((id) => ({ id }));
  });
}

/** The fence's booking re-read selects exactly these three columns. */
function isFenceBookingRead(args: unknown): args is {
  where: { id: { in: string[] } };
  select: Record<string, boolean>;
} {
  const a = args as
    | { where?: { id?: { in?: unknown } }; select?: Record<string, unknown> }
    | undefined;
  if (!Array.isArray(a?.where?.id?.in)) return false;
  const select = a?.select;
  if (!select) return false;
  const keys = Object.keys(select).sort();
  return (
    keys.length === 3 &&
    keys[0] === "id" &&
    keys[1] === "lodgeId" &&
    keys[2] === "memberId"
  );
}

/**
 * `booking.findMany` that answers the fence's owner/lodge re-read from the
 * bookings a suite already set up, and hands every other query to the double's
 * existing implementation.
 *
 * `lookup` returns the authoritative row for an id, or undefined if the booking
 * is gone — which the fence must treat as drift.
 */
export function fenceBookingFindMany(
  lookup: (id: string) => FenceBookingRow | undefined,
  existing?: (args: unknown) => unknown,
) {
  return vi.fn(async (args: unknown) => {
    if (isFenceBookingRead(args)) {
      return [...args.where.id.in]
        .sort()
        .map(lookup)
        .filter((row): row is FenceBookingRow => Boolean(row));
    }
    return existing ? await existing(args) : [];
  });
}

/**
 * The generic way to satisfy the fence's drift check without restating a
 * suite's fixtures.
 *
 * The production caller plans its participants from a booking it just read, so
 * the no-drift case is exactly "the fence sees what that read returned". This
 * wraps a suite's own `booking.findUnique` double, remembers the owner/lodge of
 * every booking it serves, and replays those rows for the fence's re-read — so
 * the fingerprints match by construction rather than by a hand-copied fixture
 * that can silently drift away from the real one.
 *
 * Drift is still expressible, and still fails: change what `findUnique`
 * returns between the plan and the re-read, or use `overrides` to state the
 * post-lock truth directly.
 */
export function recordingBookingDouble(
  findUnique: (args: unknown) => unknown,
  options: {
    /**
     * Bookings the caller planned from BEFORE entering this client — typically
     * a read on the outer prisma double, where a transaction-scoped recorder
     * cannot see it. Without these the fence reports drift that never happened.
     */
    seed?: readonly FenceBookingRow[];
    overrides?: Map<string, FenceBookingRow | undefined>;
  } = {},
) {
  const overrides = options.overrides ?? new Map();
  const seen = new Map<string, FenceBookingRow>(
    (options.seed ?? []).map((row) => [row.id, row]),
  );

  const recordingFindUnique = vi.fn(async (args: unknown) => {
    const row = (await findUnique(args)) as
      | (Partial<FenceBookingRow> & { id?: string })
      | null
      | undefined;
    if (
      row &&
      typeof row.id === "string" &&
      typeof row.memberId === "string" &&
      typeof row.lodgeId === "string"
    ) {
      // Record lodgeId EXACTLY as served, and only when it IS served. A row
      // without one is not a row this fence could ever see in production, so
      // it is not recorded — the fence then finds no source booking and
      // refuses, which is the honest outcome and points at the fixture.
      seen.set(row.id, {
        id: row.id,
        memberId: row.memberId,
        lodgeId: row.lodgeId,
      });
    }
    return row;
  });

  const lookup = (id: string) =>
    overrides.has(id) ? overrides.get(id) : seen.get(id);

  return {
    findUnique: recordingFindUnique,
    findMany: fenceBookingFindMany(lookup),
    lookup,
    /** State the post-lock truth for one booking, to model drift. */
    drift(id: string, row: FenceBookingRow | undefined) {
      overrides.set(id, row);
    },
  };
}
