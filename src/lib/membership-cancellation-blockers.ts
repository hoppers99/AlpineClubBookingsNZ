import type { Prisma } from "@prisma/client";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";
import { getTodayDateOnly } from "@/lib/date-only";
import type {
  MembershipCancellationBlocker,
  MembershipCancellationBookingBlocker,
} from "@/lib/membership-cancellation-blocker-messages";
import { loadMembershipCancellationInvoiceBlockersByMemberId } from "@/lib/membership-cancellation-invoice-blockers";
import type { MembershipCancellationSubscriptionCreditPlan } from "@/lib/membership-cancellation-subscription-credit";
import { prisma } from "@/lib/prisma";

export type {
  MembershipCancellationBlocker,
  MembershipCancellationBookingBlocker,
};

export type MembershipCancellationBlockerClient =
  | typeof prisma
  | Prisma.TransactionClient;

export type LoadMembershipCancellationBlockersOptions = {
  /**
   * Decide the unpaid-invoice check on a live Xero answer rather than the short
   * in-process memo. The approval guard sets this; the review queue's advisory
   * panel does not (#2392).
   */
  freshInvoiceCheck?: boolean;
  /**
   * The subscription credit plans, already loaded by the caller. Passed straight
   * through to the invoice check so a caller that also needs the plans (the
   * review queue, for the shared-invoice notice) reads them once rather than
   * twice per page load (#2400 review, F8).
   */
  creditPlansByMemberId?: ReadonlyMap<
    string,
    MembershipCancellationSubscriptionCreditPlan | null
  >;
};

export function emptyMembershipCancellationBlockerMap(memberIds: readonly string[]) {
  return new Map(
    memberIds.map((memberId) => [
      memberId,
      [] as MembershipCancellationBlocker[],
    ]),
  );
}

async function loadBookingBlockersByMemberId(
  uniqueMemberIds: readonly string[],
  db: MembershipCancellationBlockerClient,
) {
  const blockersByMemberId = new Map<
    string,
    MembershipCancellationBookingBlocker[]
  >(uniqueMemberIds.map((memberId) => [memberId, []]));

  const today = getTodayDateOnly();
  const [ownedBookings, guestAppearances] = await Promise.all([
    db.booking.findMany({
      where: {
        memberId: { in: [...uniqueMemberIds] },
        status: { in: [...ACTIVE_BOOKING_STATUSES] },
        checkOut: { gt: today },
      },
      select: {
        id: true,
        memberId: true,
        checkIn: true,
        checkOut: true,
        status: true,
      },
      orderBy: [{ checkIn: "asc" }, { id: "asc" }],
    }),
    db.bookingGuest.findMany({
      where: {
        memberId: { in: [...uniqueMemberIds] },
        stayEnd: { gt: today },
        booking: {
          status: { in: [...ACTIVE_BOOKING_STATUSES] },
        },
      },
      select: {
        id: true,
        memberId: true,
        stayStart: true,
        stayEnd: true,
        booking: {
          select: {
            id: true,
            status: true,
            checkIn: true,
            checkOut: true,
          },
        },
      },
      orderBy: [{ stayStart: "asc" }, { id: "asc" }],
    }),
  ]);

  for (const booking of ownedBookings) {
    blockersByMemberId.get(booking.memberId)?.push({
      type: "owned_booking",
      bookingId: booking.id,
      bookingStatus: booking.status,
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
    });
  }

  for (const guest of guestAppearances) {
    if (!guest.memberId) continue;
    blockersByMemberId.get(guest.memberId)?.push({
      type: "guest_appearance",
      bookingId: guest.booking.id,
      bookingStatus: guest.booking.status,
      checkIn: guest.stayStart.toISOString(),
      checkOut: guest.stayEnd.toISOString(),
      guestAppearanceId: guest.id,
    });
  }

  return blockersByMemberId;
}

/**
 * Every reason a membership cancellation cannot be approved yet, per member.
 *
 * Two families of blocker, deliberately behind one entry point so all three call
 * sites — the review queue, the approval guard, and the post-review reload —
 * agree by construction:
 *
 * - future bookings and guest appearances (local, always checked);
 * - unpaid Xero invoices on the member's contact, which approval would archive
 *   (#2392 — see `membership-cancellation-invoice-blockers.ts` for what counts
 *   as unpaid, when the check runs at all, and why an unknown answer blocks).
 *
 * `db` reaches the BOOKING half only. The invoice half deliberately reads
 * through the global client, because it also calls Xero, and this repo's rule is
 * that external provider calls stay outside database transactions — handing it a
 * `tx` would invite exactly the long-transaction-around-a-network-call shape
 * that rule exists to prevent. So `db` is "which client sees the local rows",
 * not a whole-function isolation guarantee; no caller passes a `tx` today, and
 * one that wants to should read the invoice half separately (#2392 review).
 */
export async function loadMembershipCancellationBlockersByMemberId(
  memberIds: readonly string[],
  db: MembershipCancellationBlockerClient = prisma,
  options: LoadMembershipCancellationBlockersOptions = {},
) {
  const uniqueMemberIds = [...new Set(memberIds)].filter(Boolean);
  const blockersByMemberId =
    emptyMembershipCancellationBlockerMap(uniqueMemberIds);
  if (uniqueMemberIds.length === 0) return blockersByMemberId;

  const [bookingBlockers, invoiceBlockers] = await Promise.all([
    loadBookingBlockersByMemberId(uniqueMemberIds, db),
    loadMembershipCancellationInvoiceBlockersByMemberId(uniqueMemberIds, {
      fresh: options.freshInvoiceCheck,
      creditPlansByMemberId: options.creditPlansByMemberId,
    }),
  ]);

  for (const memberId of uniqueMemberIds) {
    blockersByMemberId.set(memberId, [
      ...(bookingBlockers.get(memberId) ?? []),
      ...(invoiceBlockers.get(memberId) ?? []),
    ]);
  }

  return blockersByMemberId;
}
