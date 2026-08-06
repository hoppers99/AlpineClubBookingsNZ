import { Prisma } from "@prisma/client";

/**
 * The MEMBER-READABLE column manifest for `BookingChangeRequest` (#2562).
 *
 * WHY THIS EXISTS. `GET /api/bookings/[id]/change-requests` is authorised for the
 * booking's own owner as well as for an officer, and it reads the table that
 * POLICY_EXCEPTION requests live on with no `kind` filter. It used to read with
 * `include:` and no `select:`, and Prisma's `include` returns EVERY scalar column
 * — so the officer's private `internalNotes` went on the wire to the member it was
 * written about the moment #2562 added the column. A projection that names its
 * columns is the only shape that cannot leak the next one.
 *
 * WHY A SPLIT MANIFEST rather than a plain select object. The leak was not a typo,
 * it was a table gaining a column that nobody re-checked this reader against. Both
 * halves below are keyed by `Prisma.BookingChangeRequestScalarFieldEnum`, and
 * `booking-change-request-member-view.test.ts` proves their union is the whole
 * enum, so adding a column to the model fails that test until somebody decides,
 * in writing, whether a member may read it. The same discipline as #2290's audit
 * archive manifest, for the same reason: the compiler and a census test, not a
 * reviewer's memory.
 */

type BookingChangeRequestColumn =
  keyof typeof Prisma.BookingChangeRequestScalarFieldEnum;

/**
 * Columns this endpoint returns. Everything the pre-#2562 `include` returned,
 * minus the two below — so no consumer loses a field it already read.
 */
export const MEMBER_BOOKING_CHANGE_REQUEST_COLUMNS = [
  "id",
  "bookingId",
  "requestedByMemberId",
  "status",
  "kind",
  "requestedChanges",
  "reason",
  // The officer's MEMBER-FACING decision explanation. Deliberately readable: a
  // refusal the member cannot read is a refusal they cannot act on, and the
  // officer UI labels it as member-visible before they submit it.
  "adminNotes",
  "reviewedByMemberId",
  "reviewedAt",
  "linkedModificationId",
  "proposalSnapshot",
  "proposalHash",
  "frozenEvidence",
  "aggregateCapacityMode",
  "memberMessage",
  "attemptCount",
  "conflictCount",
  "lastConflictAt",
  "lastConflictReason",
  "supersededByRequestId",
  "cancelledAt",
  "holdExpiresAt",
  "version",
  "createdAt",
  "updatedAt",
] as const satisfies readonly BookingChangeRequestColumn[];

/**
 * Columns a member-reachable read must NOT return, each with the reason, because
 * a manifest whose exclusions are unexplained is a manifest the next lane
 * "tidies".
 */
export const MEMBER_BOOKING_CHANGE_REQUEST_EXCLUDED_COLUMNS = [
  // #2562: the officer's PRIVATE commentary on the decision — a judgement about
  // the member, a reference to another member's booking, a "watch this one" for
  // the next officer. Read only by the admin-guarded officer surfaces.
  "internalNotes",
  // The DB-enforced one-open-request slot key (#2524). Internal plumbing that
  // encodes nothing a member needs and names another member's id on no path, but
  // still a lock token rather than a fact about the request.
  "openStateKey",
] as const satisfies readonly BookingChangeRequestColumn[];

/**
 * The Prisma `select` for the member-reachable read, built from the manifest so
 * the two cannot drift.
 */
export const memberBookingChangeRequestSelect = Object.fromEntries(
  MEMBER_BOOKING_CHANGE_REQUEST_COLUMNS.map((column) => [column, true]),
) as { [K in (typeof MEMBER_BOOKING_CHANGE_REQUEST_COLUMNS)[number]]: true };

/** The relation keys the member read is allowed to carry alongside the columns. */
const MEMBER_BOOKING_CHANGE_REQUEST_RELATIONS = [
  "requestedBy",
  "reviewedBy",
] as const;

const MEMBER_READABLE_KEYS = new Set<string>([
  ...MEMBER_BOOKING_CHANGE_REQUEST_COLUMNS,
  ...MEMBER_BOOKING_CHANGE_REQUEST_RELATIONS,
]);

/**
 * Project one row onto the manifest before it is serialised — the SECOND guard.
 *
 * The `select` above is the first and the one that matters in production: Prisma
 * never loads an unnamed column, so there is nothing in memory to leak. This
 * function exists because "nothing in memory" is a property of the query, and the
 * query is one edit away from being an `include:` again (which is exactly how the
 * note reached this route in the first place), or a `$queryRaw`, or a row assembled
 * by a helper somewhere else. It is a whitelist copy, not a blacklist delete, so a
 * column added to the model is dropped by DEFAULT rather than carried until
 * somebody notices.
 */
export function projectMemberBookingChangeRequest<T extends object>(
  row: T,
): Partial<T> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (MEMBER_READABLE_KEYS.has(key)) projected[key] = value;
  }
  return projected as Partial<T>;
}
