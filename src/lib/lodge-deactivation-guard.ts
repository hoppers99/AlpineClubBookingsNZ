import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";
import { getTodayDateOnly } from "@/lib/date-only";
import { BookingStatus, type PrismaClient } from "@prisma/client";

/**
 * May this lodge be deactivated? (#2701/#2887)
 *
 * `PATCH /api/admin/lodges/[id]` asks twice — once cheaply before taking a
 * lock, and again under the per-lodge capacity key on the row it re-read
 * there. Those two asks were copies of each other, which is the failure mode
 * this module exists to remove: a dependency class added to one copy and not
 * the other is a rule that holds outside the lock and lets the race through
 * under it, or the reverse. There is one predicate now, and both call sites
 * run it.
 *
 * It is a pure read, so it is safe on either client. Pass `prisma` for the
 * pre-lock ask and the transaction client for the locked one — only the
 * locked answer is authoritative, and the pre-lock answer exists to refuse the
 * common cases without paying for a lock.
 */

/**
 * The delegates the predicate reads — the same `Pick<PrismaClient, ...>` shape
 * `LodgeDb` in `lodges.ts` uses, so both the base client and a transaction
 * client satisfy it without a cast.
 */
export type LodgeDeactivationDb = Pick<
  PrismaClient,
  "lodge" | "booking" | "hutLeaderAssignment" | "memberLodgeAccess"
>;

export type LodgeDeactivationRefusal = {
  status: 409;
  body:
    | { error: string }
    | {
        error: string;
        code: "LODGE_HAS_DEPENDENCIES";
        dependencies: {
          futureBookings: number;
          waitlistEntries: number;
          hutLeaderAssignments: number;
          kioskBindings: number;
        };
      };
};

/**
 * `null` means the deactivation may proceed — including when the request is
 * not a deactivation at all, so a caller can run this unconditionally.
 */
export async function findLodgeDeactivationRefusal(
  db: LodgeDeactivationDb,
  input: {
    lodgeId: string;
    /** The lodge's CURRENT active flag, as read by this caller. */
    lodgeIsActive: boolean;
    /** The requested value; anything but `false` is not a deactivation. */
    requestedActive: boolean | undefined;
    force: boolean | undefined;
  },
): Promise<LodgeDeactivationRefusal | null> {
  if (input.requestedActive !== false || !input.lodgeIsActive) return null;

  // Every deployment keeps at least one active lodge: booking flows and the
  // ADR-002 presentation rule both assume one exists.
  const otherActive = await db.lodge.count({
    where: { active: true, id: { not: input.lodgeId } },
  });
  if (otherActive === 0) {
    return {
      status: 409,
      body: { error: "At least one lodge must remain active." },
    };
  }

  if (input.force) return null;

  // Deactivation stops NEW bookings but does not touch existing dependencies.
  // Surface them so an admin cannot silently strand future bookings, waitlist
  // entries, hut-leader assignments, or a bound kiosk account; require an
  // explicit force to proceed. (What deactivation ultimately means for existing
  // bookings is an open operational decision — see docs/multi-lodge.)
  //
  // checkOut and hutLeaderAssignment.endDate are @db.Date (NZ calendar date at
  // UTC midnight). Compare against the date-only "today" so a stay or hut-leader
  // term ending today still registers as a live dependency for the whole NZ
  // day, not just the first ~13h under the TZ=Pacific/Auckland pin (F32, #1888).
  const today = getTodayDateOnly();
  const [futureBookings, waitlistEntries, hutLeaderAssignments, kioskBindings] =
    await Promise.all([
      db.booking.count({
        where: {
          lodgeId: input.lodgeId,
          status: { in: [...ACTIVE_BOOKING_STATUSES] },
          checkOut: { gte: today },
        },
      }),
      db.booking.count({
        where: {
          lodgeId: input.lodgeId,
          status: {
            in: [BookingStatus.WAITLISTED, BookingStatus.WAITLIST_OFFERED],
          },
        },
      }),
      db.hutLeaderAssignment.count({
        where: { lodgeId: input.lodgeId, endDate: { gte: today } },
      }),
      db.memberLodgeAccess.count({
        where: { lodgeId: input.lodgeId, kind: "STAFF" },
      }),
    ]);

  if (
    futureBookings + waitlistEntries + hutLeaderAssignments + kioskBindings ===
    0
  ) {
    return null;
  }

  return {
    status: 409,
    body: {
      error:
        "This lodge still has active dependencies. Deactivating stops new bookings but leaves these in place. Confirm to proceed.",
      code: "LODGE_HAS_DEPENDENCIES",
      dependencies: {
        futureBookings,
        waitlistEntries,
        hutLeaderAssignments,
        kioskBindings,
      },
    },
  };
}
