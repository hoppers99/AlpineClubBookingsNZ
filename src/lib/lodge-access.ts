import type { LodgeAccessKind, PrismaClient } from "@prisma/client";

// Per-lodge access grants (phase 4 of docs/multi-lodge/implementation-plan.md,
// ADR-001 resolved questions 2 and 5). Callers pass their own Prisma
// client/transaction so this module stays free of the app prisma singleton
// and safe to import from seeds and tests.

type LodgeAccessDb = Pick<PrismaClient, "memberLodgeAccess">;

export class LodgeBookingEligibilityError extends Error {
  status: number;

  constructor(message = "This member cannot book the selected lodge.") {
    super(message);
    this.name = "LodgeBookingEligibilityError";
    this.status = 403;
  }
}

/**
 * Booking eligibility is default-open (ADR-001 resolved question 2): a member
 * with no BOOKING_RESTRICTION rows can book every active lodge. A member with
 * any such rows can book only the listed lodges.
 */
export async function isMemberEligibleToBookLodge(
  db: LodgeAccessDb,
  memberId: string,
  lodgeId: string,
): Promise<boolean> {
  const restrictions = await db.memberLodgeAccess.findMany({
    where: { memberId, kind: "BOOKING_RESTRICTION" },
    select: { lodgeId: true },
  });
  if (restrictions.length === 0) return true;
  return restrictions.some((row) => row.lodgeId === lodgeId);
}

/**
 * Enforcement wrapper for booking mutation paths. Admin-created bookings on
 * behalf of a member bypass the restriction deliberately: the restriction is
 * an admin-configured policy, and an admin choosing to book anyway is the
 * override path (the action is audit-logged by the booking flow).
 */
export async function assertMemberMayBookLodge(
  db: LodgeAccessDb,
  input: { memberId: string; lodgeId: string; isOnBehalf?: boolean },
): Promise<void> {
  if (input.isOnBehalf) return;
  const eligible = await isMemberEligibleToBookLodge(
    db,
    input.memberId,
    input.lodgeId,
  );
  if (!eligible) {
    throw new LodgeBookingEligibilityError();
  }
}

/**
 * The lodge a lodge-operational (kiosk) account is bound to via STAFF grants.
 * Exactly one grant = bound to that lodge; zero grants = null (caller falls
 * back to the club's default lodge, preserving single-lodge behaviour).
 * Multiple grants also resolve null with the caller deciding, since a shared
 * device must belong to exactly one property to be meaningful.
 */
export async function getStaffLodgeBinding(
  db: LodgeAccessDb,
  memberId: string,
): Promise<string | null> {
  const grants = await db.memberLodgeAccess.findMany({
    where: { memberId, kind: "STAFF" },
    select: { lodgeId: true },
    take: 2,
  });
  return grants.length === 1 ? grants[0].lodgeId : null;
}

export function serializeLodgeAccessRows(
  rows: ReadonlyArray<{
    id: string;
    lodgeId: string;
    kind: LodgeAccessKind;
    createdAt: Date;
  }>,
) {
  return rows.map((row) => ({
    id: row.id,
    lodgeId: row.lodgeId,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
  }));
}
