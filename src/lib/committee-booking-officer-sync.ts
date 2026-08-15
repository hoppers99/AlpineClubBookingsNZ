import "server-only";
import type { Prisma } from "@prisma/client";
import { formatCommitteeMemberPhone } from "@/lib/committee";

/**
 * Keep the "Other Clubs" registry's booking-officer contact in step with whoever
 * currently holds the Booking Officer committee role.
 *
 * When a member is assigned (or removed from) the Booking Officer committee role,
 * the OtherLodge rows whose `name` matches one of the club's own lodges have their
 * bookingOfficerName / bookingOfficerEmail / bookingOfficerPhone (and, via Prisma's
 * `@updatedAt`, `updatedAt`) refreshed. Name and phone come from the assigned
 * member; the email is the ROLE's shared contact address (e.g. bookings@club), not
 * the member's personal email. This is what feeds the central-server distribution,
 * so partner clubs always see the current officer.
 *
 * Role identity: the seeded Booking Officer role carries the stable key "bookings"
 * (a role's key never changes when its display name is edited). A club may rename
 * the role, so a role literally named "Booking Officer" is also honoured as a
 * fallback.
 */

const BOOKING_OFFICER_ROLE_KEY = "bookings";
const BOOKING_OFFICER_ROLE_NAME = "Booking Officer";

// The subset of the Prisma client this module touches. Accepting the narrow shape
// lets callers pass either `prisma` or an interactive-transaction client (`tx`).
type CommitteeSyncClient = Pick<
  Prisma.TransactionClient,
  "committeeRole" | "committeeAssignment" | "lodge" | "otherLodge"
>;

interface BookingOfficerContact {
  bookingOfficerName: string | null;
  bookingOfficerEmail: string | null;
  bookingOfficerPhone: string | null;
}

const EMPTY_CONTACT: BookingOfficerContact = {
  bookingOfficerName: null,
  bookingOfficerEmail: null,
  bookingOfficerPhone: null,
};

/** CommitteeRole ids that represent the Booking Officer (stable key or name). */
async function bookingOfficerRoleIds(
  db: CommitteeSyncClient,
): Promise<string[]> {
  const roles = await db.committeeRole.findMany({
    where: {
      OR: [
        { key: BOOKING_OFFICER_ROLE_KEY },
        { name: { equals: BOOKING_OFFICER_ROLE_NAME, mode: "insensitive" } },
      ],
    },
    select: { id: true },
  });
  return roles.map((role) => role.id);
}

/**
 * Recompute the current Booking Officer contact and write it into every OtherLodge
 * row whose name matches one of the club's lodges.
 *
 * - The "current" holder is the active assignment ordered first (sortOrder asc,
 *   then earliest createdAt) — deterministic when more than one member holds it.
 * - With no active holder, the contact fields are cleared to null.
 * - Only rows whose stored contact actually differs are written, so `updatedAt` is
 *   bumped (and the row re-distributed) only on a genuine change.
 */
async function applyBookingOfficerContact(
  db: CommitteeSyncClient,
  roleIds: string[],
): Promise<{ updated: number; holderMemberId: string | null }> {
  const holder = await db.committeeAssignment.findFirst({
    where: { committeeRoleId: { in: roleIds }, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      memberId: true,
      // Email comes from the ROLE's shared contact address (e.g. bookings@club),
      // not the member's personal email; name and phone come from the member.
      committeeRole: { select: { contactEmail: true } },
      member: {
        select: {
          firstName: true,
          lastName: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
        },
      },
    },
  });

  const contact: BookingOfficerContact = holder
    ? {
        bookingOfficerName:
          `${holder.member.firstName} ${holder.member.lastName}`.trim() || null,
        bookingOfficerEmail: holder.committeeRole.contactEmail?.trim() || null,
        bookingOfficerPhone: formatCommitteeMemberPhone(holder.member),
      }
    : EMPTY_CONTACT;

  // Match OtherLodge registry rows to the club's own lodge names.
  const lodges = await db.lodge.findMany({ select: { name: true } });
  const lodgeNames = [...new Set(lodges.map((lodge) => lodge.name))];
  if (lodgeNames.length === 0) {
    return { updated: 0, holderMemberId: holder?.memberId ?? null };
  }

  const rows = await db.otherLodge.findMany({
    where: { name: { in: lodgeNames } },
    select: {
      id: true,
      bookingOfficerName: true,
      bookingOfficerEmail: true,
      bookingOfficerPhone: true,
    },
  });

  let updated = 0;
  for (const row of rows) {
    if (
      row.bookingOfficerName === contact.bookingOfficerName &&
      row.bookingOfficerEmail === contact.bookingOfficerEmail &&
      row.bookingOfficerPhone === contact.bookingOfficerPhone
    ) {
      continue; // Unchanged — leave updatedAt (and distribution) untouched.
    }
    await db.otherLodge.update({
      where: { id: row.id },
      // Prisma's `@updatedAt` stamps `updatedAt` on this write.
      data: contact,
    });
    updated++;
  }

  return { updated, holderMemberId: holder?.memberId ?? null };
}

/**
 * Sync the OtherLodge booking-officer contact after a committee assignment change,
 * but ONLY when the mutated assignment belongs to the Booking Officer role — so
 * unrelated committee edits stay cheap. Pass the affected assignment's
 * `committeeRoleId`. Safe to run inside the caller's transaction.
 */
export async function syncBookingOfficerForRole(
  db: CommitteeSyncClient,
  committeeRoleId: string,
): Promise<{ updated: number; holderMemberId: string | null } | null> {
  const roleIds = await bookingOfficerRoleIds(db);
  if (!roleIds.includes(committeeRoleId)) return null;
  return applyBookingOfficerContact(db, roleIds);
}
